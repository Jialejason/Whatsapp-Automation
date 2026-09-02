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
const TARGET_NAME = 'MinKoNaing';    // 出货单转发目标
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const INQUIRY_TIMEOUT_MS = 15 * 60 * 1000; // 询价超时时限：15 分钟

let model = null;
if (GEMINI_API_KEY) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  model = genAI.getGenerativeModel({
    model: 'gemini-3.6-flash',
    generationConfig: { responseMimeType: 'application/json' }
  });
}

let currentQR = null;
let sock = null;
let pendingTasks = new Map();
let taskCounter = 1;

// 待处理询价跟踪池：chatId -> { customer, items, timer, timestamp, pushName, groupCompany }
const activeInquiries = new Map();

// 群组名称缓存
const groupNameCache = new Map();

// 10 分钟滑动窗口对话记录
const chatHistoryMap = new Map();

function appendChatHistory(chatId, sender, text) {
  if (!text) return;
  const now = Date.now();
  let history = chatHistoryMap.get(chatId) || [];
  history = history.filter(item => now - item.timestamp < 10 * 60 * 1000);
  history.push({ sender, text, timestamp: now });
  if (history.length > 8) history.shift();
  chatHistoryMap.set(chatId, history);
}

function getRecentContext(chatId) {
  const history = chatHistoryMap.get(chatId) || [];
  return history.map(h => `${h.sender}: ${h.text}`).join('\n');
}

// 提取群名称或客户公司后缀
async function resolveChatGroupName(chatId) {
  if (!chatId.endsWith('@g.us')) return '';
  if (groupNameCache.has(chatId)) return groupNameCache.get(chatId);

  try {
    const meta = await sock.groupMetadata(chatId);
    let name = meta.subject || '';
    if (name.toUpperCase().includes('PROFAST -')) {
      name = name.replace(/PROFAST\s*-\s*/i, '').trim();
    }
    groupNameCache.set(chatId, name);
    return name;
  } catch (err) {
    return '';
  }
}

// 辅助：提取消息正文、引用内容及提及人
function extractMessageContent(msg) {
  if (!msg.message) return { text: '', quotedText: '', mentions: [] };

  let text = '';
  let quotedText = '';
  let mentions = [];

  const m = msg.message;
  if (m.conversation) {
    text = m.conversation;
  } else if (m.extendedTextMessage) {
    text = m.extendedTextMessage.text || '';
    mentions = m.extendedTextMessage.contextInfo?.mentionedJid || [];
    const ctx = m.extendedTextMessage.contextInfo;
    if (ctx && ctx.quotedMessage) {
      const qm = ctx.quotedMessage;
      quotedText = qm.conversation || (qm.extendedTextMessage && qm.extendedTextMessage.text) || '';
    }
  } else if (m.imageMessage) {
    text = m.imageMessage.caption || '';
  }

  return { text: text.trim(), quotedText: quotedText.trim(), mentions };
}

// 业务场景前置筛选
function preClassifyMessage(text, quotedText, mentions) {
  const raw = `${text} ${quotedText}`;
  const lower = raw.toLowerCase();

  // 1. @Profast Jiale
  const isMentioned = lower.includes('@profast jiale') || mentions.some(jid => jid.includes(ADMIN_NUMBER));
  if (isMentioned) return 'TASK_MENTION';

  // 2. 货柜船期详情
  if ((raw.includes('广州') || raw.includes('义乌') || lower.includes('update')) && (lower.includes('gc') || lower.includes('zc'))) {
    return 'CONTAINER_STATUS';
  }

  // 3. 客户询价 或 内部针对询价的跟进回复报价
  const inquiryKeywords = ['quote', '询价', '现货', '多少钱', 'washer', 'csk', 'sds', 'bolt', 'screw', 'price'];
  const hasInquiryWord = inquiryKeywords.some(k => lower.includes(k));
  const isInternalReplyToQuote = quotedText && (lower.includes('@0.') || lower.includes('能等') || lower.includes('有货') || lower.includes('ctn') || lower.includes('pcs') || lower.includes('rm'));

  if (hasInquiryWord || isInternalReplyToQuote) {
    return 'INQUIRY';
  }

  // 4. 出货/来货
  const logisticsKeywords = [
    'do', 'pallet', 'normal pallet', 'long pallet', 'lorry', 'plate',
    'zc', 'gc', '出货', '到货', 'incoming', '送货', 'batu caves', 'jawi profast'
  ];
  const hasLogisticsKeyword = logisticsKeywords.some(kw => lower.includes(kw));
  const hasPlateNumber = /\b[A-Za-z]{1,3}\s*\d{1,4}\b/.test(raw);

  if (hasLogisticsKeyword || hasPlateNumber) return 'LOGISTICS';

  return 'IGNORE';
}

// Gemini 调用防 429
async function callGemini(prompt) {
  let delay = 3000;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await model.generateContent(prompt);
      return res.response.text().trim();
    } catch (e) {
      if (String(e).includes('429') && i === 0) {
        console.log(`[429 限频保护] 等待 ${delay / 1000} 秒后重试...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw e;
      }
    }
  }
}

// 启动 WhatsApp 客户端
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
      currentQR = await QRCode.toDataURL(qr);
      console.log('>>> [QR] 请访问 /qr 扫码');
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === 515) {
        setTimeout(startBot, 1000);
      } else if (code !== DisconnectReason.loggedOut) {
        setTimeout(startBot, 3000);
      }
    } else if (connection === 'open') {
      currentQR = null;
      console.log('🎉🎉 紧固件供应链业务调度中枢已就绪！');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      await handleIncomingMessage(msg);
    }
  });
}

// 主流程分发
async function handleIncomingMessage(msg) {
  const chatId = msg.key.remoteJid;
  if (!chatId || chatId === 'status@broadcast') return;

  const isFromMe = msg.key.fromMe;
  const pushName = msg.pushName || '未知用户';
  const { text, quotedText, mentions } = extractMessageContent(msg);
  const adminJid = `${ADMIN_NUMBER}@s.whatsapp.net`;

  if (!text) return;

  // 1. 管理员指令审批
  const isFromAdmin = chatId === adminJid || (isFromMe && chatId.includes(ADMIN_NUMBER));
  if (isFromAdmin && /^\d+$/.test(text)) {
    const actionId = parseInt(text, 10);
    if (actionId === 0) {
      await sock.sendMessage(chatId, { text: '❌ 已清空待办审批。' });
      pendingTasks.clear();
      return;
    }
    const task = pendingTasks.get(actionId);
    if (task) {
      const targetJid = await resolveContactOrGroupJid(TARGET_NAME);
      if (targetJid) {
        await sock.sendMessage(targetJid, { text: task.finalText });
        await sock.sendMessage(chatId, { text: `✅ [已转发] #${actionId} 已下发至 ${TARGET_NAME}！` });
      } else {
        await sock.sendMessage(chatId, { text: `⚠️ 未能匹配目标【${TARGET_NAME}】。` });
      }
      pendingTasks.delete(actionId);
      return;
    }
  }

  if (isFromMe) return;

  appendChatHistory(chatId, pushName, text);

  // 2. 场景分流
  const scene = preClassifyMessage(text, quotedText, mentions);
  if (scene === 'IGNORE' || !model) return;

  const groupCompany = await resolveChatGroupName(chatId);

  // -------------------------------------------------------------
  // 场景 1：【有任务@Profast Jiale】
  // -------------------------------------------------------------
  if (scene === 'TASK_MENTION') {
    const fromLabel = groupCompany ? `${pushName} (${groupCompany})` : pushName;
    const taskNotice = `🔔【有任务@Profast Jiale】
------------------------------------
📌 派工来源: ${fromLabel}
💬 任务指示:
"${text}"
${quotedText ? `\n📎 关联引用:\n"${quotedText}"` : ''}
------------------------------------
⏰ 请及时在群聊中跟进！`;

    await sock.sendMessage(adminJid, { text: taskNotice });
    console.log(`[任务通知] 来源: ${fromLabel}`);
    return;
  }

  // -------------------------------------------------------------
  // 场景 2：【货柜船期详情】
  // -------------------------------------------------------------
  if (scene === 'CONTAINER_STATUS') {
    const containerPrompt = `
你是一个专业的马来西亚五金紧固件海运进柜分析专家。
解析以下货柜排期更新，严格按规则分类与统计盘托总数：

【清单原文】:
${text}

研判规则：
1. "未到"：包含"预计**到港"、"海关查验还未放行"、"询问运输几时派送中"、"预计**拉进运输仓库"、"ON SHIP"、"还未安排装柜"、"还未收到资料"。
2. "将到"：包含"运输安排**派送"。
3. 盘托数量提取与整型求和：将 Normal 与 Long 盘托数值累加，分别计算"未到"和"将到"总数。

仅输出严格 JSON 格式：
{
  "undeliveredPallets": 0,
  "arrivingPallets": 0,
  "summaryList": "简洁分行清单"
}
`;

    try {
      const rawRes = await callGemini(containerPrompt);
      const data = JSON.parse(rawRes.replace(/```json|```/g, '').trim());

      const containerCard = `🚢【货柜船期详情】
------------------------------------
📊【盘托统计】：
⏳【未到货柜】: ${data.undeliveredPallets} 盘托 (在船/海关查验/待拉仓)
🚚【将到货柜】: ${data.arrivingPallets} 盘托 (已安排派送中)
------------------------------------
📋【进柜状态概览】：
${data.summaryList}
------------------------------------
💡 此简报仅供过目与备货仓位规划。`;

      await sock.sendMessage(adminJid, { text: containerCard });
    } catch (e) {
      console.error('船期详情解析异常:', e);
    }
    return;
  }

  // -------------------------------------------------------------
  // 场景 3：【询价/物】双向闭环 + 超时报警系统
  // -------------------------------------------------------------
  if (scene === 'INQUIRY') {
    const inquiryPrompt = `
你是一个专业的五金紧固件业务助理。
请研判当前群聊消息是客户在询问紧固件价格/库存，还是内部同事正在进行回复/报价：

【发件人】: ${pushName}
【最新消息】: "${text}"
【引用内容】: "${quotedText}"
【群聊近期上下文】:
${getRecentContext(chatId)}

判断规则：
1. 如果是内部同事正在回复/报价（提供单价、确认货期、询问能否等待等）：
   - isReplyUpdate: true
   - replyContent: 提取详细回复报价内容
2. 如果是客户/采购在发起询价：
   - isReplyUpdate: false
   - replyContent: "暂未回复"
3. 提取 customer: 询价发件人姓名
4. 提取 items: 询价的具体产品规格、材质、头型/牙型及数量

仅输出严格 JSON 格式：
{
  "isReplyUpdate": true/false,
  "customer": "...",
  "items": "...",
  "replyContent": "..."
}
`;

    try {
      const rawRes = await callGemini(inquiryPrompt);
      const data = JSON.parse(rawRes.replace(/```json|```/g, '').trim());

      let customerDisplay = data.customer || pushName;
      if (groupCompany && !customerDisplay.toUpperCase().includes(groupCompany.toUpperCase())) {
        customerDisplay = `${customerDisplay} (${groupCompany})`;
      }

      if (data.isReplyUpdate) {
        // --- 内部同事已回复：取消超时报警，推送完成闭环卡片 ---
        if (activeInquiries.has(chatId)) {
          clearTimeout(activeInquiries.get(chatId).timer);
          activeInquiries.delete(chatId);
          console.log(`[询价闭环] 群聊 ${chatId} 已有回复，清除报警定时器。`);
        }

        const replyCard = `💬【询价跟进 / 内部已回复】
------------------------------------
👤 咨询客户: ${customerDisplay}
🔩 紧固件规格: ${data.items || '未注明'}
📌 内部回复: ${data.replyContent} (由 ${pushName} 回复)
------------------------------------
✅ 报价闭环已完成，超时预警自动解除。`;

        await sock.sendMessage(adminJid, { text: replyCard });
      } else {
        // --- 客户发起新询价：启动 15 分钟超时未回复倒计时 ---
        if (activeInquiries.has(chatId)) {
          clearTimeout(activeInquiries.get(chatId).timer);
        }

        const timeoutTimer = setTimeout(async () => {
          const alertMsg = `⚠️【超时未回复预警 / Inquiry Alert】
------------------------------------
🏢 客户群组: ${groupCompany || '普通群聊'}
👤 咨询客户: ${customerDisplay}
🔩 紧固件规格: ${data.items || '未注明'}
⏳ 等待时长: 已超过 15 分钟未响应！
------------------------------------
📢 办公室内台暂无人员跟进，请协调尽快报价！`;

          try {
            await sock.sendMessage(adminJid, { text: alertMsg });
            console.log(`[超时警报] 群 ${chatId} 询价超过 15 分钟未回复！`);
          } catch (err) {
            console.error('发送超时预警失败:', err);
          }
          activeInquiries.delete(chatId);
        }, INQUIRY_TIMEOUT_MS);

        activeInquiries.set(chatId, {
          customerDisplay,
          items: data.items,
          timer: timeoutTimer,
          timestamp: Date.now()
        });

        const newInquiryCard = `💬【询价/物】
------------------------------------
👤 咨询客户: ${customerDisplay}
🔩 紧固件规格: ${data.items || '未注明'}
📌 内部回复: 暂未回复 (⏳ 15分钟应答倒计时中)
------------------------------------
👀 询价动态已过目，超时未回复将自动预警。`;

        await sock.sendMessage(adminJid, { text: newInquiryCard });
        console.log(`[新询价挂载] 客户: ${customerDisplay}，启动 15 分钟计时。`);
      }
    } catch (e) {
      console.error('询价/报价双向闭环解析异常:', e);
    }
    return;
  }

  // -------------------------------------------------------------
  // 场景 4：【出货/来货】
  // -------------------------------------------------------------
  if (scene === 'LOGISTICS') {
    const logisticsPrompt = `
结合以下消息、引用内容及群聊历史进行研判：
发件人: ${pushName}
当前消息: "${text}"
引用内容: "${quotedText}"
上下文记录:
${getRecentContext(chatId)}

研判规则：
1. 【来货/到货通知】：无客户送货地址，主要包含中国直发单号（ZC/GC）与托盘规格（如 3 NORMAL PALLET, 4 LONG PALLET）。
2. 【出货通知】：包含本地送货客户、送货区域、DO单号、车牌等。
3. 补充车牌（如 ANA9306）需与引用的单据合并。

仅输出严格 JSON 格式:
{
  "isLogistics": true/false,
  "type": "出货" 或 "来货",
  "date": "...",
  "time": "...",
  "doOrChinaNo": "DO单号或中国单号(ZC/GC)",
  "lorryPlate": "车牌号(如适用)",
  "pallets": "托盘/规格",
  "area": "送货区域(出货适用)",
  "customer": "客户名称(出货适用)",
  "phone": "联系电话"
}
`;

    try {
      const rawRes = await callGemini(logisticsPrompt);
      const data = JSON.parse(rawRes.replace(/```json|```/g, '').trim());

      if (data.isLogistics) {
        const taskId = taskCounter++;
        let output = '';

        if (data.type === '来货') {
          output = `【到货/来货通知】\n`;
          if (data.date) output += `📅 日期: ${data.date}\n`;
          if (data.doOrChinaNo) output += `📦 中国单号: ${data.doOrChinaNo}\n`;
          if (data.pallets) output += `🪵 托盘详情: ${data.pallets}\n`;
          output += `\n请仓库注意接卸核对入库！`;
        } else {
          output = `【出货通知 / Delivery Notice】\n`;
          if (data.date) output += `📅 日期: ${data.date}\n`;
          if (data.time) output += `⏰ 时间/地点: ${data.time}\n`;
          if (data.doOrChinaNo) output += `📄 DO 单号: ${data.doOrChinaNo}\n`;
          if (data.lorryPlate) output += `🚛 车牌号: ${data.lorryPlate}\n`;
          if (data.pallets) output += `📦 货物规格: ${data.pallets}\n`;
          if (data.area) output += `📍 送货区域: ${data.area}\n`;
          if (data.customer) output += `🏢 客户名称: ${data.customer}\n`;
          if (data.phone) output += `📞 联络电话: ${data.phone}\n`;
          output += `\n请相关人员跟进安排，谢谢！`;
        }

        pendingTasks.set(taskId, {
          finalText: output,
          originalChatId: chatId
        });

        const approvalCard = `📋【待审批 - 出货/来货 #${taskId}】
类型: ${data.type}通知
来源: ${groupCompany ? `${pushName} (${groupCompany})` : pushName}
目标: ${TARGET_NAME}

预定发送文案:
------------------------------------
${output}
------------------------------------
👉 回复【${taskId}】确认立即转发
👉 回复【0】丢弃全部待办`;

        await sock.sendMessage(adminJid, { text: approvalCard });
        console.log(`[审批卡片] #${taskId} (${data.type})`);
      }
    } catch (e) {
      console.error('出货/来货解析异常:', e);
    }
  }
}

// 目标联系人/群解析
async function resolveContactOrGroupJid(name) {
  try {
    const chats = await sock.groupFetchAllParticipating();
    for (const jid in chats) {
      if (chats[jid].subject && chats[jid].subject.includes(name)) {
        return jid;
      }
    }
  } catch (e) {}
  return process.env.TARGET_JID || null;
}

// 网页路由
app.get('/qr', (req, res) => {
  if (currentQR) {
    res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>WhatsApp 扫码中枢</title><meta http-equiv="refresh" content="5"></head>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;font-family:sans-serif;">
          <h2>请使用 WhatsApp 扫描二维码连接调度中枢</h2>
          <img src="${currentQR}" style="width:300px;height:300px;" />
          <p style="color:gray;">每 5 秒自动刷新状态</p>
        </body>
      </html>
    `);
  } else {
    res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>调度中枢状态</title><meta http-equiv="refresh" content="5"></head>
        <body style="display:flex;align-items:center;justify-content:center;height:90vh;font-family:sans-serif;">
          <h2 style="color:green;">🎉 紧固件供应链业务调度中枢正在运行！</h2>
        </body>
      </html>
    `);
  }
});

app.get('/status', (req, res) => res.json({ status: 'ok', live: true }));
app.get('/', (req, res) => res.send('Fastener Supply Chain AI Dispatch Center Live.'));

app.listen(PORT, () => {
  console.log(`调度中枢网关启动，监听端口: ${PORT}`);
  startBot();
});
