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

// 初始化 Gemini 3.6-flash
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

// 对话上下文缓存（10分钟滑动窗口，保留最近8条）
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

// 辅助：提取消息体、引用内容及提及人
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

// 紧固件调度中枢：前置业务场景分流
function preClassifyMessage(text, quotedText, mentions) {
  const raw = `${text} ${quotedText}`;
  const lower = raw.toLowerCase();

  // 1. 任务艾特强提醒 (针对 @Profast Jiale)
  const isMentioned = lower.includes('@profast jiale') || mentions.some(jid => jid.includes(ADMIN_NUMBER));
  if (isMentioned) return 'TASK_MENTION';

  // 2. 货柜海运船期详情 (广州/义乌/UPDATE/到港/ON SHIP/海关查验/安排装柜等)
  if ((raw.includes('广州') || raw.includes('义乌') || lower.includes('update')) && (lower.includes('gc') || lower.includes('zc'))) {
    return 'CONTAINER_STATUS';
  }

  // 3. 客户询价与库存确认 (quote, 现货, 多少钱, csk, sds, bolt, screw 等五金特征)
  if (lower.includes('quote') || lower.includes('询价') || lower.includes('现货') || lower.includes('多少钱')) {
    return 'INQUIRY';
  }

  // 4. 出货与来货通知 (DO单、车牌号、托盘、送货、到货、ZC/GC)
  const logisticsKeywords = [
    'do', 'pallet', 'normal pallet', 'long pallet', 'lorry', 'plate',
    'zc', 'gc', '出货', '到货', 'incoming', '送货', 'batu caves', 'jawi profast'
  ];
  const hasLogisticsKeyword = logisticsKeywords.some(kw => lower.includes(kw));
  const hasPlateNumber = /\b[A-Za-z]{1,3}\s*\d{1,4}\b/.test(raw);

  if (hasLogisticsKeyword || hasPlateNumber) return 'LOGISTICS';

  return 'IGNORE';
}

// 防 429 频率限制调用机制
async function callGemini(prompt) {
  let delay = 3000;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await model.generateContent(prompt);
      return res.response.text().trim();
    } catch (e) {
      if (String(e).includes('429') && i === 0) {
        console.log(`[429 限频保护] 稍候 ${delay / 1000} 秒后自动重试...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw e;
      }
    }
  }
}

// 启动 WhatsApp Gateway
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

// 核心业务中枢路由
async function handleIncomingMessage(msg) {
  const chatId = msg.key.remoteJid;
  if (!chatId || chatId === 'status@broadcast') return;

  const isFromMe = msg.key.fromMe;
  const pushName = msg.pushName || '未知用户';
  const { text, quotedText, mentions } = extractMessageContent(msg);
  const adminJid = `${ADMIN_NUMBER}@s.whatsapp.net`;

  if (!text) return;

  // 1. 管理员指令交互 (回复任务编号如 "1" 或 "0" 取消)
  const isFromAdmin = chatId === adminJid || (isFromMe && chatId.includes(ADMIN_NUMBER));
  if (isFromAdmin && /^\d+$/.test(text)) {
    const actionId = parseInt(text, 10);
    if (actionId === 0) {
      await sock.sendMessage(chatId, { text: '❌ 已清空全部待办审批。' });
      pendingTasks.clear();
      return;
    }
    const task = pendingTasks.get(actionId);
    if (task) {
      const targetJid = await resolveContactOrGroupJid(TARGET_NAME);
      if (targetJid) {
        await sock.sendMessage(targetJid, { text: task.finalText });
        await sock.sendMessage(chatId, { text: `✅ [已转发] 任务 #${actionId} 已成功下发至 ${TARGET_NAME}！` });
      } else {
        await sock.sendMessage(chatId, { text: `⚠️ 未能匹配到目标【${TARGET_NAME}】，请确认通讯录已有聊天窗口。` });
      }
      pendingTasks.delete(actionId);
      return;
    }
  }

  if (isFromMe) return;

  appendChatHistory(chatId, pushName, text);

  // 2. 调度场景研判
  const scene = preClassifyMessage(text, quotedText, mentions);
  if (scene === 'IGNORE' || !model) return;

  // -------------------------------------------------------------
  // 场景 1：【有任务@Profast Jiale】（本地直推，零 API 消耗）
  // -------------------------------------------------------------
  if (scene === 'TASK_MENTION') {
    const taskNotice = `🔔【有任务@Profast Jiale】
------------------------------------
📌 派工来源: ${pushName}
💬 任务指示:
"${text}"
${quotedText ? `\n📎 关联引用原单:\n"${quotedText}"` : ''}
------------------------------------
⏰ 请及时在工作群跟进！`;

    await sock.sendMessage(adminJid, { text: taskNotice });
    console.log(`[已推送艾特任务] 来源: ${pushName}`);
    return;
  }

  // -------------------------------------------------------------
  // 场景 2：【货柜船期详情】（状态研判与盘托数学计算）
  // -------------------------------------------------------------
  if (scene === 'CONTAINER_STATUS') {
    const containerPrompt = `
你是一个专业的马来西亚五金紧固件海运进柜分析专家。
请仔细解析以下【货柜船期更新清单】，并严格按照规则研判并统计盘托数量：

【清单原文】:
${text}

【研判与计算规则】：
1. 状态分类：
   - "未到" (未就绪/在途/卡关状态)：
     包括但不限于："预计**到港"、"海关查验还未放行"、"询问运输几时派送中"、"预计**拉进运输仓库"、"ON SHIP"、"还未安排装柜"、"还未收到资料"。
   - "将到" (已确认派送)：
     明确注明 "运输安排**派送" (运输公司已定下派送日期准备送达)。
2. 盘托数量计算：
   - 提取每一行对应的托盘数（例如 "(4P)" -> 4，"3 NORMAL PALLET" -> 3，"2 LONG" -> 2）。
   - 将所有属于 "未到" 状态的 Normal 与 Long 盘托数值进行整型累加，计算出 "未到盘托总数"。
   - 将所有属于 "将到" 状态的 Normal 与 Long 盘托数值进行整型累加，计算出 "将到盘托总数"。
3. 生成一份规整精简的各口岸（广州/义乌等）单号状态摘要。

仅输出严格 JSON 格式：
{
  "undeliveredPallets": 0,
  "arrivingPallets": 0,
  "summaryList": "简洁分行清单(港口/单号/状态)"
}
`;

    try {
      const rawRes = await callGemini(containerPrompt);
      const data = JSON.parse(rawRes.replace(/```json|```/g, '').trim());

      const containerCard = `🚢【货柜船期详情】
------------------------------------
📊【盘托统计】：
⏳【未到货柜】: ${data.undeliveredPallets} 盘托 (船运中/海关查验/待拉仓)
🚚【将到货柜】: ${data.arrivingPallets} 盘托 (已安排派送中)
------------------------------------
📋【进柜状态概览】：
${data.summaryList}
------------------------------------
💡 此简报仅供过目与备货仓位规划。`;

      await sock.sendMessage(adminJid, { text: containerCard });
      console.log(`[已推送货柜船期] 未到: ${data.undeliveredPallets}, 将到: ${data.arrivingPallets}`);
    } catch (e) {
      console.error('货柜船期详情解析异常:', e);
    }
    return;
  }

  // -------------------------------------------------------------
  // 场景 3：【询价/物】（客户询价，纯过目监控）
  // -------------------------------------------------------------
  if (scene === 'INQUIRY') {
    const inquiryPrompt = `
你是一个专业的五金紧固件业务助理。分析以下群聊询价消息：
最新消息: "${text}"
引用内容: "${quotedText}"
群聊上下文:
${getRecentContext(chatId)}

请提炼：
1. customer: 客户或咨询方名称
2. items: 询问的具体产品、规格、牙型/头型、材质与数量 (例如 "SS304 CSK SDS #6x5/8 1 ctn", "Hex Bolt M10x1.5x30 11k")
3. internalReply: 内部同事是否已有回应或提供报价 (若有简要概述，没有则填 "暂未回复")

仅输出 JSON:
{
  "customer": "...",
  "items": "...",
  "internalReply": "..."
}
`;

    try {
      const rawRes = await callGemini(inquiryPrompt);
      const data = JSON.parse(rawRes.replace(/```json|```/g, '').trim());

      const inquiryCard = `💬【询价/物】
------------------------------------
👤 咨询客户: ${data.customer || pushName}
🔩 紧固件规格: ${data.items || '未注明'}
📌 内部跟进: ${data.internalReply}
------------------------------------
👀 询价动态已过目，无需转发。`;

      await sock.sendMessage(adminJid, { text: inquiryCard });
      console.log(`[已推送询价动态] 客户: ${data.customer}`);
    } catch (e) {
      console.error('询价解析异常:', e);
    }
    return;
  }

  // -------------------------------------------------------------
  // 场景 4：【出货/来货】（DO出货审批 或 进货到货入库）
  // -------------------------------------------------------------
  if (scene === 'LOGISTICS') {
    const logisticsPrompt = `
你是一个专业的五金紧固件仓储物流调度员。
请结合以下消息、引用内容以及群聊历史进行深度研判：

发件人: ${pushName}
当前消息: "${text}"
引用内容: "${quotedText}"
上下文记录:
${getRecentContext(chatId)}

研判规则：
1. 区分【出货】与【到货/来货】：
   - 【来货/到货通知】：消息中没有送货客户名称与地点，核心为中国直发单号（如 ZC2600858, GC26005152）以及托盘详情（如 3 NORMAL PALLET, 4 LONG PALLET）。
   - 【出货通知】：包含本地送货客户名称、区域（如 BATU CAVES）、DO单号、发货车牌号等。
2. 遇到车牌补充：如果当前消息或上下文补充了马来西亚车牌（如 ANA9306），务必与引用的单据合并生成完整文案，车牌不要误判为单号。

仅输出 JSON:
{
  "isLogistics": true/false,
  "type": "出货" 或 "来货",
  "date": "...",
  "time": "...",
  "doOrChinaNo": "DO单号或中国单号(ZC/GC)",
  "lorryPlate": "车牌号(如适用)",
  "pallets": "托盘/件数规格",
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
来源: ${pushName}
目标: ${TARGET_NAME}

预定发送文案:
------------------------------------
${output}
------------------------------------
👉 回复【${taskId}】确认立即转发
👉 回复【0】丢弃全部待办`;

        await sock.sendMessage(adminJid, { text: approvalCard });
        console.log(`[已推送审批 - 出货/来货] #${taskId} (${data.type})`);
      }
    } catch (e) {
      console.error('物流出货/来货解析异常:', e);
    }
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

app.get('/', (req, res) => res.send('Fastener Supply Chain AI Dispatch Center Live.'));

app.listen(PORT, () => {
  console.log(`调度中枢网关启动，监听端口: ${PORT}`);
  startBot();
});
