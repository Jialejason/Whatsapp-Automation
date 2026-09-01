const express = require('express');
const qrcode = require('qrcode');
const axios = require('axios');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GAS_WEBHOOK_URL = process.env.GAS_WEBHOOK_URL || '';

let sock = null;
let qrCodeData = '';
let isConnected = false;

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = qr;
      isConnected = false;
      console.log('✅ 新二维码已成功生成！');
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`连接断开 (Code: ${statusCode})，是否尝试重连:`, shouldReconnect);
      if (shouldReconnect) {
        startWhatsApp();
      }
    } else if (connection === 'open') {
      isConnected = true;
      qrCodeData = '';
      console.log('🎉 WhatsApp 已成功连接上线！');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const chatId = msg.key.remoteJid;
      const messageId = msg.key.id;
      const sender = msg.key.participant || chatId;
      const senderName = msg.pushName || '未知用户';

      let text = '';
      if (msg.message.conversation) {
        text = msg.message.conversation;
      } else if (msg.message.extendedTextMessage?.text) {
        text = msg.message.extendedTextMessage.text;
      }

      if (!text || !text.trim()) continue;

      console.log(`[收到消息] ${chatId} | ${senderName}: ${text}`);

      if (GAS_WEBHOOK_URL) {
        try {
          await axios.post(GAS_WEBHOOK_URL, {
            idMessage: messageId,
            sourceChatId: chatId,
            sender: sender,
            senderName: senderName,
            text: text,
            timestamp: msg.messageTimestamp || Math.floor(Date.now() / 1000)
          }, { timeout: 15000 });
        } catch (err) {
          console.error('推送 Webhook 失败:', err.message);
        }
      }
    }
  });
}

// 二维码扫码页面（带自动刷新）
app.get('/qr', async (req, res) => {
  if (isConnected) {
    return res.send(`
      <div style="text-align:center;margin-top:50px;font-family:sans-serif;">
        <h2 style="color:green;">✅ WhatsApp 已经处于连接状态，无需扫码！</h2>
      </div>
    `);
  }

  if (!qrCodeData) {
    return res.send(`
      <div style="text-align:center;margin-top:50px;font-family:sans-serif;">
        <h2>⏳ 正在生成二维码，请稍候...</h2>
        <p>页面每 3 秒会自动刷新</p>
        <script>setTimeout(() => { location.reload(); }, 3000);</script>
      </div>
    `);
  }

  try {
    const qrImage = await qrcode.toDataURL(qrCodeData);
    res.send(`
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;font-family:sans-serif;">
        <h2>请使用手机 WhatsApp 扫码登录</h2>
        <img src="${qrImage}" style="width:300px;height:300px;border:1px solid #ccc;padding:12px;border-radius:10px;box-shadow:0 4px 10px rgba(0,0,0,0.1);"/>
        <p style="color:#666;margin-top:15px;">扫码成功后页面将自动更新</p>
        <script>setTimeout(() => { location.reload(); }, 6000);</script>
      </div>
    `);
  } catch (err) {
    res.status(500).send('生成二维码异常: ' + err.message);
  }
});

app.get('/status', (req, res) => {
  res.json({ status: isConnected ? 'connected' : 'disconnected' });
});

app.post('/send', async (req, res) => {
  const { to, text } = req.body;

  if (!isConnected || !sock) {
    return res.status(503).json({ success: false, error: 'WhatsApp 尚未连接' });
  }
  if (!to || !text) {
    return res.status(400).json({ success: false, error: '缺少 to 或 text 参数' });
  }

  try {
    let targetJid = to.trim();
    if (!targetJid.includes('@')) {
      targetJid = `${targetJid}@s.whatsapp.net`;
    }

    const result = await sock.sendMessage(targetJid, { text: text });
    res.json({ success: true, messageId: result.key.id });
  } catch (err) {
    console.error('发送失败:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Gateway 正在监听端口: ${PORT}`);
  startWhatsApp();
});
