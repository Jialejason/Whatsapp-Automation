const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const ADMIN_PHONE = process.env.ADMIN_PHONE || '601137169383';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// 初始化 Gemini 客户端
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
  generationConfig: { responseMimeType: 'application/json' }
});

// 群聊映射表
const GROUP_MAP = {
  "Profast业务群": "120363228706613997@g.us",
  "测试号": `${ADMIN_PHONE}@s.whatsapp.net`
};

let sock = null;
let latestQrString = null;
let isConnected = false;

// 待审批队列存储 (存于内存)
const pendingApprovals = new Map();

// 启动 WhatsApp 连接
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      latestQrString = qr;
      isConnected = false;
      console.log('>>> [QR] 已更新，请扫码');
    }
    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('>>> 连接断开，5秒后重连...');
      if (shouldReconnect) setTimeout(startWhatsApp, 5000);
    } else if (connection === 'open') {
      isConnected = true;
      latestQrString = null;
      console.log('🎉🎉 WhatsApp AI Agent 已就绪！');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const senderJid = msg.key.remoteJid;
    const text = msg.message.conversation || 
                 msg.message.extendedTextMessage?.text || '';

    if (!text.trim()) return;

    const adminJid = `${ADMIN_PHONE}@s.whatsapp.net`;

    // 1. 如果是来自管理员的私聊指令 (审批逻辑)
    if (senderJid === adminJid) {
      const trimmed = text.trim().toLowerCase();
      if (pendingApprovals.has(trimmed)) {
        const item = pendingApprovals.get(trimmed);
        try {
          await sock.sendMessage(item.targetChatId, { text: item.draftMessage });
          await sock.sendMessage(adminJid, { text: `✅ 已成功转发至【${item.targetGroupName}】！` });
          pendingApprovals.delete(trimmed);
        } catch (err) {
          await sock.sendMessage(adminJid, { text: `❌ 转发失败: ${err.message}` });
        }
        return;
      } else if (trimmed.startsWith('0') || trimmed === 'cancel' || trimmed === '取消') {
        const taskNum = trimmed.replace(/[^0-9]/g, '');
        if (pendingApprovals.has(taskNum)) {
          pendingApprovals.delete(taskNum);
          await sock.sendMessage(adminJid, { text: `🗑️ 任务 #${taskNum} 已取消。` });
        } else {
          pendingApprovals.clear();
          await sock.sendMessage(adminJid, { text: `🗑️ 已清空待审批队列。` });
        }
        return;
      }
    }

    // 2. 收到进站消息 -> AI 提炼与审批卡片生成
    console.log(`[消息进站] 来源: ${senderJid} 内容: ${text.slice(0, 30)}...`);
    handleIncomingMessage(senderJid, text, msg.pushName || '未知发送者');
  });
}

// AI 提炼与生成审批请求
async function handleIncomingMessage(sourceJid, text, senderName) {
  if (!GEMINI_API_KEY) {
    console.error('未配置 GEMINI_API_KEY');
    return;
  }

  const groupKeys = Object.keys(GROUP_MAP).join('、');
  const prompt = `你是一名专业紧固件/工业品物流出货助理。请分析以下进站消息：
发件人: ${senderName}
原始文本:
"""
${text}
"""

任务：
1. 判断是否包含出货通知、提货、DO单号、托盘数等业务信息。若是闲聊客套，isMeaningful 设为 false。
2. 提取核心事实，排版为工整专业、准备发给下游群的正式通知文案（保留DO号、托盘数、地点、联系人等，格式美观）。
3. 候选目标群聊名称：${groupKeys}。选择最适合的目标群（默认选 Profast业务群）。

严格按 JSON 输出：
{
  "isMeaningful": true,
  "draftMessage": "排版工整的最终通知文案",
  "suggestedGroupName": "Profast业务群"
}`;

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const resJson = JSON.parse(response.text());
    
    if (!resJson.isMeaningful) return;

    // 分配编号 (1~9)
    const taskNum = String((pendingApprovals.size % 9) + 1);
    const targetGroupName = resJson.suggestedGroupName || 'Profast业务群';
    const targetChatId = GROUP_MAP[targetGroupName] || GROUP_MAP['Profast业务群'];

    pendingApprovals.set(taskNum, {
      draftMessage: resJson.draftMessage,
      targetGroupName: targetGroupName,
      targetChatId: targetChatId
    });

    // 推送审批卡片到你的私聊 WhatsApp
    const adminJid = `${ADMIN_PHONE}@s.whatsapp.net`;
    const approvalPrompt = `📋 *【待审批出货通知 #${taskNum}】*
*来源*: ${senderName}
*目标群*: ${targetGroupName}

*预定发送文案*:
--------------------------------
${resJson.draftMessage}
--------------------------------
👉 *回复【${taskNum}】确认立即转发*
👉 *回复【0】或【取消】丢弃*`;

    await sock.sendMessage(adminJid, { text: approvalPrompt });
    console.log(`[已推送审批] 任务编号: #${taskNum}`);

  } catch (err) {
    console.error('AI 解析异常:', err);
  }
}

// 网页状态与二维码接口
app.get('/status', (req, res) => {
  res.json({ connected: isConnected, pendingTasks: pendingApprovals.size });
});

app.get('/qr', async (req, res) => {
  if (isConnected) return res.send('<h2 style="color:green;text-align:center;">✅ 已经成功连接！</h2>');
  if (!latestQrString) return res.send('<h2 style="text-align:center;">二维码生成中，请刷新...</h2>');
  const qrImage = await QRCode.toDataURL(latestQrString);
  res.send(`
    <div style="display:flex;flex-direction:column;align-items:center;margin-top:50px;">
      <h2>请用 WhatsApp 扫码连接 AI Agent</h2>
      <img src="${qrImage}" style="width:300px;height:300px;border:1px solid #ccc;" />
    </div>
  `);
});

app.listen(PORT, () => {
  console.log(`Gateway 监听端口: ${PORT}`);
  startWhatsApp();
});
