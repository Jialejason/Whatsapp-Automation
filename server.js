const express = require('express');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 10000;

const ADMIN_NUMBER = '601137169383'; // Jia Le
const TARGET_NAME = 'MinKoNaing';    // 最终接收目标
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// 初始化 Gemini (最新 3.6-flash)
let model = null;
if (GEMINI_API_KEY) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  model = genAI.getGenerativeModel({
    model: 'gemini-3.6-flash',
    generationConfig: { responseMimeType: 'application/json' }
  });
}

// 内存状态
let currentQR = null;
let sock = null;
let pendingTasks = new Map(); // taskId -> { data, originalChatId }
let taskCounter = 1;

// 群组与对话上下文缓存（最近10分钟，最多保留6条历史记录）
const chatHistoryMap = new Map(); // chatId -> [ { sender, text, timestamp } ]

function appendChatHistory(chatId, sender, text) {
  if (!text) return;
  const now = Date.now();
  let history = chatHistoryMap.get(chatId) || [];
  // 剔除 10 分钟以前的过期记录
  history = history.filter(item => now - item.timestamp < 10 * 60 * 1000);
  history.push({ sender, text, timestamp: now });
  if (history.length > 6) history.shift();
  chatHistoryMap.set(chatId, history);
}

function getRecentContext(chatId) {
  const history = chatHistoryMap.get(chatId) || [];
  return history.map(h => `${h.sender}: ${h.text}`).join('\n');
}

// 辅助：解析 WhatsApp 复杂消息体与引用消息
function extractMessageContent(msg) {
  if (!msg.message) return { text: '', quotedText: '' };

  const messageType = Object.keys(msg.message)[0];
  let text = '';
  let quotedText = '';

  if (messageType === 'conversation') {
    text = msg.message.conversation;
  } else if (messageType === 'extendedTextMessage') {
    text = msg.message.extendedTextMessage.text || '';
    const ctx = msg.message.extendedTextMessage.contextInfo;
    if (ctx && ctx.quotedMessage) {
      const qType = Object.keys(ctx.quotedMessage)[0];
      if (qType === 'conversation') {
        quotedText = ctx.quotedMessage.conversation;
      } else if (qType === 'extendedTextMessage') {
        quotedText = ctx.quotedMessage.extendedTextMessage.text || '';
      }
    }
  } else if (messageType === 'imageMessage') {
    text = msg.message.imageMessage.caption || '';
  }

  return { text: text.trim(), quotedText: quotedText.trim() };
}

// 启动 WhatsApp 连接
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`>>> WhatsApp 协议版本: v${version.join('.')}, 是否最新: ${isLatest}`);

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: false,
    generateHighQualityLinkPreview: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        currentQR = await QRCode.toDataURL(qr);
        console.log('>>> [QR] 请访问 /qr 扫码');
      } catch (err) {
        console.error('二维码生成错误:', err);
      }
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`>>> 连接断开, 状态码: ${statusCode}`);

      if (statusCode === 515) {
        console.log('>>> 凭据保存成功, 立即重启连接载入登录态...');
        setTimeout(startBot, 1000);
      } else if (shouldReconnect) {
        console.log('>>> 正在尝试重新连接...');
        setTimeout(startBot, 3000);
      } else {
        console.log('>>> 设备已登出, 请清理凭据后重新扫码。');
      }
    } else if (connection === 'open') {
      currentQR = null;
      console.log('🎉🎉 WhatsApp AI Agent 已就绪！');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      await handleIncomingMessage(msg);
    }
  });
}

// 核心业务处理
async function handleIncomingMessage(msg) {
  const chatId = msg.key.remoteJid;
  if (!chatId || chatId === 'status@broadcast') return;

  const isFromMe = msg.key.fromMe;
  const pushName = msg.pushName || '未知用户';
  const { text, quotedText } = extractMessageContent(msg);

  if (!text) return;

  // 1. 处理管理员审批回复指令 (例如 "1", "9" 或 "0")
  const adminJid = `${ADMIN_NUMBER}@s.whatsapp.net`;
  const isFromAdmin = chatId === adminJid || (isFromMe && chatId.includes(ADMIN_NUMBER));

  if (isFromAdmin && /^\d+$/.test(text)) {
    const actionId = parseInt(text, 10);

    if (actionId === 0) {
      await sock.sendMessage(chatId, { text: '❌ 已取消全部待办任务。' });
      pendingTasks.clear();
      return;
    }

    const task = pendingTasks.get(actionId);
    if (task) {
      // 匹配 MinKoNaing
      const targetJid = await resolveContactOrGroupJid(TARGET_NAME);
      if (targetJid) {
        await sock.sendMessage(targetJid, { text: task.finalText });
        await sock.sendMessage(chatId, {
          text: `✅ [已发送] 任务 #${actionId} 已成功转发至 ${TARGET_NAME}！`
        });
      } else {
        await sock.sendMessage(chatId, {
          text: `⚠️ 无法找到目标联系人/群聊【${TARGET_NAME}】，请确认通讯录已有聊天记录。已暂存。`
        });
      }
      pendingTasks.delete(actionId);
      return;
    }
  }

  // 2. 忽略自己发出的日常业务消息
  if (isFromMe) return;

  // 3. 记录群聊/私聊上下文
  appendChatHistory(chatId, pushName, text);

  // 4. 调用 AI 进行多轮对话与引用分析
  if (!model) return;

  try {
    const recentContext = getRecentContext(chatId);
    const analysisPrompt = `
你是一个专业的马来西亚物流出货智能助理。
以下是当前收到的最新消息以及关联上下文，请综合分析：

【发件人】: ${pushName}
【当前最新消息】: "${text}"
${quotedText ? `【引用的上一条消息】: "${quotedText}"` : ''}
【最近群聊/对话记录】:
${recentContext}

业务研判规则：
1. 判断这些对话中是否包含出货/提货/送货/DO单相关要素。
2. 识别提取出：
   - date: 日期
   - time: 时间/提货地点备注 (如 2.30pm JAWI PROFAST)
   - doNumber: DO单号 (如 DO-2609/003 & DO-2609/004)
   - lorryPlate: 车牌号/运输车号 (重要：马来西亚常见车牌如 ANA9306、PKK1234 等若出现在回复中，属于车牌号，不是 DO 单号)
   - pallets: 货物件数/托盘规格 (如 10 NORMAL PALLET)
   - area: 送货/提货区域 (如 BATU CAVES)
   - customer: 客户名称 (如 ADVANCE BOLTS & FASTENERS SDN BHD)
   - phone: 联络电话
3. 如果当前消息只是补充信息（例如引用了之前的单子补充了车牌号 "ANA9306"），必须将完整单据信息与该车牌号合并整合成一份最完整的出货通知！
4. 如果完全只是闲聊打招呼，返回 isDelivery: false。

请仅严格以 JSON 格式输出：
{
  "isDelivery": true/false,
  "date": "...",
  "time": "...",
  "doNumber": "...",
  "lorryPlate": "...",
  "pallets": "...",
  "area": "...",
  "customer": "...",
  "phone": "..."
}
`;

    const result = await model.generateContent(analysisPrompt);
    const jsonText = result.response.text().trim();
    const data = JSON.parse(jsonText);

    if (data.isDelivery && (data.doNumber || data.lorryPlate || data.customer)) {
      const taskId = taskCounter++;

      // 格式化输出最终文案
      let output = `【出货/提货通知 / Delivery Notice】\n`;
      if (data.date) output += `📅 日期: ${data.date}\n`;
      if (data.time) output += `⏰ 时间/地点: ${data.time}\n`;
      if (data.doNumber) output += `📄 DO 单号: ${data.doNumber}\n`;
      if (data.lorryPlate) output += `🚛 车牌号 (Lorry Plate): ${data.lorryPlate}\n`;
      if (data.pallets) output += `📦 货物规格: ${data.pallets}\n`;
      if (data.area) output += `📍 送货区域: ${data.area}\n`;
      if (data.customer) output += `🏢 客户名称: ${data.customer}\n`;
      if (data.phone) output += `📞 联络电话: ${data.phone}\n`;
      output += `\n请相关人员跟进安排，谢谢！`;

      pendingTasks.set(taskId, {
        finalText: output,
        originalChatId: chatId
      });

      // 推送审批卡片至管理员
      const approvalCard = `📋【待审批出货通知 #${taskId}】
来源: ${pushName}
目标: ${TARGET_NAME}

预定发送文案:
------------------------------------
${output}
------------------------------------
👉 回复【${taskId}】确认立即转发
👉 回复【0】丢弃全部待办`;

      await sock.sendMessage(adminJid, { text: approvalCard });
      console.log(`[已推送审批] 任务编号: #${taskId} (包含车牌: ${data.lorryPlate || '无'})`);
    }
  } catch (err) {
    console.error('AI 解析与业务处理异常:', err);
  }
}

// 目标联系人/群聊解析
async function resolveContactOrGroupJid(name) {
  try {
    const chats = await sock.groupFetchAllParticipating();
    for (const jid in chats) {
      if (chats[jid].subject && chats[jid].subject.includes(name)) {
        return jid;
      }
    }
  } catch (e) {
    // 忽略群解析错误，继续匹配个人
  }
  // 也可以在环境变量中预设特定联系人的 JID
  return process.env.TARGET_JID || null;
}

// 路由服务
app.get('/qr', (req, res) => {
  if (currentQR) {
    res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>WhatsApp 扫码登录</title><meta http-equiv="refresh" content="5"></head>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;font-family:sans-serif;">
          <h2>请使用 WhatsApp 扫描二维码</h2>
          <img src="${currentQR}" style="width:300px;height:300px;" />
          <p style="color:gray;">每 5 秒自动刷新状态</p>
        </body>
      </html>
    `);
  } else {
    res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>WhatsApp 状态</title><meta http-equiv="refresh" content="5"></head>
        <body style="display:flex;align-items:center;justify-content:center;height:90vh;font-family:sans-serif;">
          <h2 style="color:green;">🎉 WhatsApp 已成功连接！无需扫码。</h2>
        </body>
      </html>
    `);
  }
});

app.get('/', (req, res) => res.send('WhatsApp AI Automation is Live.'));

app.listen(PORT, () => {
  console.log(`Gateway 监听端口: ${PORT}`);
  startBot();
});
