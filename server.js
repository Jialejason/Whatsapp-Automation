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
const TARGET_NAME = 'MinKoNaing';    // 出货/取货单转发目标
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

// 待处理询价跟踪池
const activeInquiries = new Map();
const groupNameCache = new Map();
const chatHistoryMap = new Map();

// 规格公制 M 规范化兜底函数 (如把 m27 自动转为 M27)
function normalizeFastenerSpec(spec) {
  if (!spec) return '';
  return spec.replace(/\bm(?=\d)/gi, 'M');
}

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

function preClassifyMessage(text, quotedText, mentions) {
  const raw = `${text} ${quotedText}`;
  const lower = raw.toLowerCase();

  // 1. @Profast Jiale
  const isMentioned = lower.includes('@profast jiale') || mentions.some(jid => jid.includes(ADMIN_NUMBER));
  if (isMentioned) return 'TASK_MENTION';

  // 2. 货柜船期
  if ((raw.includes('广州') || raw.includes('义乌') || lower.includes('update')) && (lower.includes('gc') || lower.includes('zc'))) {
    return 'CONTAINER_STATUS';
  }

  // 3. 客户询价
  const inquiryKeywords = ['quote', '询价', '现货', '多少钱', 'washer', 'csk', 'sds', 'bolt', 'screw', 'price', 'nut'];
  const hasInquiryWord = inquiryKeywords.some(k => lower.includes(k));
  const isInternalReplyToQuote = quotedText && (lower.includes('@0.') || lower.includes('能等') || lower.includes('有货') || lower.includes('ctn') || lower.includes('pcs') || lower.includes('rm'));

  if (hasInquiryWord || isInternalReplyToQuote) return 'INQUIRY';

  // 4. 物流动作（出货、取货、到货）
  const logisticsKeywords = [
    'do', 'pallet', 'normal pallet', 'long pallet', 'lorry', 'plate',
    'zc', 'gc', '出货', '到货', 'incoming', '送货', 'pickup', 'pickup from',
    'delivery to', '载回来', '取货', '提货', 'batu caves', 'balakong', 'jawi profast'
  ];
  const hasLogisticsKeyword = logisticsKeywords.some(kw => lower.includes(kw));
  const hasPlateNumber = /\b[A-Za-z]{1,3}\s*\d{1,4}\b/.test(raw);

  if (hasLogisticsKeyword || hasPlateNumber) return 'LOGISTICS';

  return 'IGNORE';
}

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

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version, isLatest } = await fetchLatestBaileysVersion();

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

  const scene = preClassifyMessage(text, quotedText, mentions);
  if (scene === 'IGNORE' || !model) return;

  const groupCompany = await resolveChatGroupName(chatId);

  // 场景 1：【有任务@Profast Jiale】
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
    return;
  }

  // 场景 2：【货柜船期详情】
  if (scene === 'CONTAINER_STATUS') {
    const containerPrompt = `
解析以下货柜更新，统计盘托：
${text}

规则：
1. "未到"：预计**到港、海关查验还未放行、询问运输几时派送中、预计**拉进运输仓库、ON SHIP、还未安排装柜、还未收到资料。
2. "将到"：运输安排**派送。
3. 盘托求和：Normal 与 Long 累加。

输出严格 JSON:
{"undeliveredPallets": 0, "arrivingPallets": 0, "summaryList": "..."}
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
      console.error(e);
    }
    return;
  }

  // 场景 3：【询价/物】双向闭环与超时
  if (scene === 'INQUIRY') {
    const inquiryPrompt = `
你是一个专业的五金紧固件业务助理。分析询价或报价消息：
发件人: ${pushName}
消息: "${text}"
引用: "${quotedText}"
上下文: ${getRecentContext(chatId)}

【提取规范】：
1. itemName: 品名 (如 FLAT WASHER, HEX BOLT, HEX NUT, CSK SDS, SDS PH 等紧固件品类)
2. specSize: 规格 (必须精准对应尺寸Size参数，公制M必须大写，例如 M27 x 52 x 3.2mm, M10x30, #6x5/8, 3/8x1-1/2)
3. quantity: 数量/箱数 (如 10 ctn, 1000 pcs, 16k 等)
4. customer: 询价发件人姓名
5. isReplyUpdate: 内部同事是否正在回复报价 (true/false)
6. replyContent: 详细提取回复报价内容 (未回复填 "暂未回复")

输出严格 JSON:
{
  "isReplyUpdate": bool,
  "customer": "...",
  "itemName": "品名",
  "specSize": "规格",
  "quantity": "数量/箱数",
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

      // 对规格统一执行大写 M 处理
      const formattedSpec = normalizeFastenerSpec(data.specSize);

      // 格式化输出行
      let itemLines = '';
      if (data.itemName) itemLines += `🔩 品名 (Item name): ${data.itemName}\n`;
      if (formattedSpec) itemLines += `📏 规格: ${formattedSpec}\n`;
      if (data.quantity) itemLines += `📦 数量/箱数 (QTY/Carton): ${data.quantity}\n`;
      if (!itemLines) itemLines = `🔩 品名/规格: 未注明\n`;

      if (data.isReplyUpdate) {
        if (activeInquiries.has(chatId)) {
          clearTimeout(activeInquiries.get(chatId).timer);
          activeInquiries.delete(chatId);
        }
        const replyCard = `💬【询价跟进 / 内部已回复】
------------------------------------
👤 咨询客户: ${customerDisplay}
${itemLines.trim()}
📌 内部回复: ${data.replyContent} (由 ${pushName} 回复)
------------------------------------
✅ 报价闭环已完成，超时预警自动解除。`;

        await sock.sendMessage(adminJid, { text: replyCard });
      } else {
        if (activeInquiries.has(chatId)) {
          clearTimeout(activeInquiries.get(chatId).timer);
        }

        const timeoutTimer = setTimeout(async () => {
          const alertMsg = `⚠️【超时未回复预警 / Inquiry Alert】
------------------------------------
🏢 客户群组: ${groupCompany || '普通群聊'}
👤 咨询客户: ${customerDisplay}
${itemLines.trim()}
⏳ 等待时长: 已超过 15 分钟未响应！
------------------------------------
📢 办公室内台暂无人员跟进，请协调尽快报价！`;

          try {
            await sock.sendMessage(adminJid, { text: alertMsg });
          } catch (err) {}
          activeInquiries.delete(chatId);
        }, INQUIRY_TIMEOUT_MS);

        activeInquiries.set(chatId, {
          customerDisplay,
          itemLines,
          timer: timeoutTimer,
          timestamp: Date.now()
        });

        const newInquiryCard = `💬【询价/物】
------------------------------------
👤 咨询客户: ${customerDisplay}
${itemLines.trim()}
📌 内部回复: 暂未回复 (⏳ 15分钟应答倒计时中)
------------------------------------
👀 询价动态已过目，超时未回复将自动预警。`;

        await sock.sendMessage(adminJid, { text: newInquiryCard });
      }
    } catch (e) {
      console.error(e);
    }
    return;
  }

  // 场景 4：【出货 / 取货 / 到货】三大物流模型
  if (scene === 'LOGISTICS') {
    const logisticsPrompt = `
你是一个专业的五金紧固件仓储物流调度专家。
请深度研判以下消息、引用及上下文，按行业标准拆解物流信息：

发件人: ${pushName}
消息: "${text}"
引用: "${quotedText}"
群聊上下文: ${getRecentContext(chatId)}

【核心分类规则】：
1. 【取货通知 (Pickup)】：
   - 特征：出现 "Pickup From"、"取货地点"、"载回来"、外部供应商（如 Everlast Bolts），送回 Profast。
2. 【出货通知 (Delivery)】：
   - 特征：Profast 送货给外部客户，含 DO 单号、客户名、送货区域、车牌号等。
3. 【到货通知 (Incoming)】：
   - 特征：中国直发海运柜（ZC/GC 编号）进入仓库入库。

【字段定义规则】：
- itemName: 品名 (如 HEX BOLT, FLAT WASHER, CSK SDS, SDS PH 等品类)
- specSize: 规格 (对应尺寸Size参数，公制M必须大写，如 M10x30, #6x5/8, M27x52x3.2mm)
- quantity: 数量/箱数 (如 10 ctn, 20 箱, 1000 pcs)
- pallets: 盘托数量 (指代Pallet卡板包装单位，如 1 NORMAL PALLET, 2 LONG PALLET, 4P)

输出严格 JSON:
{
  "isLogistics": true,
  "category": "取货" | "出货" | "到货",
  "date": "...",
  "time": "...",
  "pickupFrom": "取货公司与详细地址",
  "pickupContact": "取货联系人及电话",
  "deliveryTo": "目的地(通常为 Profast)",
  "customer": "送货客户名称",
  "area": "送货区域/地址",
  "doNumber": "DO单号",
  "chinaNo": "中国单号(ZC/GC)",
  "lorryPlate": "车牌号",
  "pallets": "盘托(如 1 NORMAL PALLET)",
  "itemName": "品名",
  "specSize": "规格",
  "quantity": "数量/箱数",
  "notes": "额外备注说明"
}
`;

    try {
      const rawRes = await callGemini(logisticsPrompt);
      const data = JSON.parse(rawRes.replace(/```json|```/g, '').trim());

      if (data.isLogistics) {
        const taskId = taskCounter++;
        let output = '';
        const formattedSpec = normalizeFastenerSpec(data.specSize);

        if (data.category === '取货') {
          output = `【取货通知 / Pickup Order】\n`;
          if (data.date) output += `📅 取货日期: ${data.date}\n`;
          if (data.pickupFrom) output += `🏭 取货单位: ${data.pickupFrom}\n`;
          if (data.pickupContact) output += `📞 取货联络: ${data.pickupContact}\n`;
          if (data.pallets) output += `🪵 盘托: ${data.pallets}\n`;
          if (data.itemName) output += `🔩 品名 (Item name): ${data.itemName}\n`;
          if (formattedSpec) output += `📏 规格: ${formattedSpec}\n`;
          if (data.quantity) output += `📦 数量/箱数 (QTY/Carton): ${data.quantity}\n`;
          if (data.deliveryTo) output += `📍 送回地点: ${data.deliveryTo}\n`;
          if (data.notes) output += `💬 备注说明: ${data.notes}\n`;
          output += `\n请运输司机安排前往取货并拉回仓库，谢谢！`;
        } else if (data.category === '到货') {
          output = `【到货通知】\n`;
          if (data.date) output += `📅 日期: ${data.date}\n`;
          if (data.chinaNo) output += `📦 中国单号: ${data.chinaNo}\n`;
          if (data.pallets) output += `🪵 盘托: ${data.pallets}\n`;
          if (data.itemName) output += `🔩 品名 (Item name): ${data.itemName}\n`;
          if (formattedSpec) output += `📏 规格: ${formattedSpec}\n`;
          if (data.quantity) output += `📦 数量/箱数 (QTY/Carton): ${data.quantity}\n`;
          output += `\n请仓库注意接卸核对入库！`;
        } else {
          output = `【出货通知 / Delivery Notice】\n`;
          if (data.date) output += `📅 日期: ${data.date}\n`;
          if (data.time) output += `⏰ 时间/地点: ${data.time}\n`;
          if (data.doNumber) output += `📄 DO 单号: ${data.doNumber}\n`;
          if (data.lorryPlate) output += `🚛 车牌号: ${data.lorryPlate}\n`;
          if (data.pallets) output += `🪵 盘托: ${data.pallets}\n`;
          if (data.itemName) output += `🔩 品名 (Item name): ${data.itemName}\n`;
          if (formattedSpec) output += `📏 规格: ${formattedSpec}\n`;
          if (data.quantity) output += `📦 数量/箱数 (QTY/Carton): ${data.quantity}\n`;
          if (data.area) output += `📍 送货区域: ${data.area}\n`;
          if (data.customer) output += `🏢 客户名称: ${data.customer}\n`;
          output += `\n请相关人员跟进安排，谢谢！`;
        }

        pendingTasks.set(taskId, {
          finalText: output,
          originalChatId: chatId
        });

        const approvalCard = `📋【待审批 - ${data.category}通知 #${taskId}】
类型: ${data.category}操作
来源: ${groupCompany ? `${pushName} (${groupCompany})` : pushName}
目标: ${TARGET_NAME}

预定发送文案:
------------------------------------
${output}
------------------------------------
👉 回复【${taskId}】确认立即转发
👉 回复【0】丢弃全部待办`;

        await sock.sendMessage(adminJid, { text: approvalCard });
      }
    } catch (e) {
      console.error('物流处理异常:', e);
    }
  }
}

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

app.get('/qr', (req, res) => {
  if (currentQR) {
    res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>WhatsApp 扫码中枢</title><meta http-equiv="refresh" content="5"></head>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;font-family:sans-serif;">
          <h2>请使用 WhatsApp 扫描二维码连接调度中枢</h2>
          <img src="${currentQR}" style="width:300px;height:300px;" />
        </body>
      </html>
    `);
  } else {
    res.send(`<h2>🎉 紧固件供应链业务调度中枢正在运行！</h2>`);
  }
});

app.get('/status', (req, res) => res.json({ status: 'ok', live: true }));
app.get('/', (req, res) => res.send('Fastener Supply Chain AI Dispatch Center Live.'));

app.listen(PORT, () => {
  console.log(`调度中枢网关启动，监听端口: ${PORT}`);
  startBot();
});
