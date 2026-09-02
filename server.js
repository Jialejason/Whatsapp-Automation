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

// 初始化 Gemini (使用当前支持的 3.6-flash)
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
let pendingTasks = new Map(); // taskId -> { finalText, originalChatId }
let taskCounter = 1;

// 群组与对话上下文缓存（最近10分钟滑动窗口，保留最近6条）
const chatHistoryMap = new Map(); // chatId -> [ { sender, text, timestamp } ]

function appendChatHistory(chatId, sender, text) {
  if (!text) return;
  const now = Date.now();
  let history = chatHistoryMap.get(chatId) || [];
  history = history.filter(item => now - item.timestamp < 10 * 60 * 1000);
  history.push({ sender, text, timestamp: now });
  if (history.length > 6) history.shift();
  chatHistoryMap.set(chatId, history);
}

function getRecentContext(chatId) {
  const history = chatHistoryMap.get(chatId) || [];
  return history.map(h => `${h.sender}: ${h.text}`).join('\n');
}

// 辅助：全面解析 WhatsApp 消息及引用（Quote）内容
function extractMessageContent(msg) {
  if (!msg.message) return { text: '', quotedText: '' };

  let text = '';
  let quotedText = '';

  const m = msg.message;
  if (m.conversation) {
    text = m.conversation;
  } else if (m.extendedTextMessage) {
    text = m.extendedTextMessage.text || '';
    const ctx = m.extendedTextMessage.contextInfo;
    if (ctx && ctx.quotedMessage) {
      const qm = ctx.quotedMessage;
      quotedText = qm.conversation || (qm.extendedTextMessage && qm.extendedTextMessage.text) || '';
    }
  } else if (m.imageMessage) {
    text = m.imageMessage.caption || '';
  }

  return { text: text.trim(), quotedText: quotedText.trim() };
}

// 前置关键词与马来西亚车牌正则过滤（避免非出货消息浪费免费配额）
function isLogisticsRelevant(text, quotedText) {
  const combined = `${text} ${quotedText}`.toLowerCase();
  
  // 物流高频业务词
  const logisticsKeywords = [
    'do', 'pallet', 'lorry', 'plate', 'batu', 'jawi', 'profast',
    '客户', '日期', '车牌', '提货', '送货', '出货', '单号', '箱', 'pcs'
  ];
  const hitKeyword = logisticsKeywords.some(kw => combined.includes(kw));

  // 马来西亚车牌正则（如 ANA9306, PKK 1234, W 1234 A, VAA 888）
  const plateRegex = /\b[A-Za-z]{1,3}\s*\d{1,4}\s*[A-Za-z]?\b/;
  const hitPlate = plateRegex.test(combined);

  return hitKeyword || hitPlate;
}

// 带自动退避的 Gemini 调用（防 429 崩溃）
async function callGeminiWithRetry(prompt, retries = 2, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      return result.response.text().trim();
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes('429') && attempt < retries) {
        console.warn(`[限频警告] 遇到 429，等待 ${delayMs / 1000} 秒后进行第 ${attempt} 次重试...`);
        await new Promise(res => setTimeout(res, delayMs));
        delayMs *= 2; // 指数递增
      } else {
        throw err;
      }
    }
  }
}

// 启动 WhatsApp 实例
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
        console.error('二维码生成失败:', err);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`>>> 连接断开, 状态码: ${statusCode}`);

      if (statusCode === 515) {
        console.log('>>> 凭据同步更新, 立即重载会话...');
        setTimeout(startBot, 1000);
      } else if (shouldReconnect) {
        console.log('>>> 正在尝试重新连接...');
        setTimeout(startBot, 3000);
      } else {
        console.log('>>> 设备已下线，请重新前往 /qr 扫码绑定。');
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

// 核心业务流
async function handleIncomingMessage(msg) {
  const chatId = msg.key.remoteJid;
  if (!chatId || chatId === 'status@broadcast') return;

  const isFromMe = msg.key.fromMe;
  const pushName = msg.pushName || '未知用户';
  const { text, quotedText } = extractMessageContent(msg);

  if (!text) return;

  // 1. 管理员审批指令 (回复单号数字如 "1" 或 "0" 取消)
  const adminJid = `${ADMIN_NUMBER}@s.whatsapp.net`;
  const isFromAdmin = chatId === adminJid || (isFromMe && chatId.includes(ADMIN_NUMBER));

  if (isFromAdmin && /^\d+$/.test(text)) {
    const actionId = parseInt(text, 10);

    if (actionId === 0) {
      await sock.sendMessage(chatId, { text: '❌ 已清空待办审批队列。' });
      pendingTasks.clear();
      return;
    }

    const task = pendingTasks.get(actionId);
    if (task) {
      const targetJid = await resolveContactOrGroupJid(TARGET_NAME);
      if (targetJid) {
        await sock.sendMessage(targetJid, { text: task.finalText });
        await sock.sendMessage(chatId, {
          text: `✅ [转发成功] 任务 #${actionId} 已发送给 ${TARGET_NAME}！`
        });
      } else {
        await sock.sendMessage(chatId, {
          text: `⚠️ 找不到目标【${TARGET_NAME}】，请确认目标存在对应私聊或群名。`
        });
      }
      pendingTasks.delete(actionId);
      return;
    }
  }

  // 2. 忽略机器人自身发出的日常通知
  if (isFromMe) return;

  // 3. 记录上下文（群聊或私聊）
  appendChatHistory(chatId, pushName, text);

  // 4. 前置物流特征筛查：无特征闲聊直接退出，绝不调用 API
  if (!isLogisticsRelevant(text, quotedText)) {
    return;
  }

  if (!model) return;

  try {
    const recentContext = getRecentContext(chatId);
    const prompt = `
你是一个专业的马来西亚紧固件/五金物流出货助理。
请结合以下消息、引用内容以及群聊近期对话，研判出货与提货信息：

【发件人】: ${pushName}
【当前收到的消息】: "${text}"
${quotedText ? `【引用的消息内容】: "${quotedText}"` : ''}
【近期群聊上下文记录】:
${recentContext}

提取与推理要求：
1. 综合判断群聊中多人的对话。如果有人先发了出货信息，后面有人回复车牌号（如 "ANA9306"）或提货时间，请将其关联并整合进同一份出货单。
2. 识别字段：
   - date: 日期
   - time: 时间/地点
   - doNumber: DO单号 (如 DO-2609/003)
   - lorryPlate: 车牌/运输车号 (严格注意：ANA9306、PKK1234 等是马来西亚车牌号，不是 DO 单号)
   - pallets: 托盘/件数/规格 (如 10 NORMAL PALLET)
   - area: 送货地区
   - customer: 客户名称
   - phone: 联系电话
3. 若只是无关闲聊，必须返回 isDelivery: false。

请严格仅输出 JSON：
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

    const jsonRaw = await callGeminiWithRetry(prompt);
    const cleanJson = jsonRaw.replace(/```json|```/g, '').trim();
    const data = JSON.parse(cleanJson);

    // 确认包含核心要素
    if (data.isDelivery && (data.doNumber || data.lorryPlate || data.customer)) {
      const taskId = taskCounter++;

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
      console.log(`[已推送审批] 任务编号: #${taskId} (车牌: ${data.lorryPlate || '未提供'})`);
    }
  } catch (err) {
    console.error('AI 解析异常:', err);
  }
}

// 目标联系人/群聊 JID 匹配
async function resolveContactOrGroupJid(name) {
  try {
    const chats = await sock.groupFetchAllParticipating();
    for (const jid in chats) {
      if (chats[jid].subject && chats[jid].subject.includes(name)) {
        return jid;
      }
    }
  } catch (e) {
    // 忽略群解析错误
  }
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
