const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GAS_WEBHOOK_URL = process.env.GAS_WEBHOOK_URL || '';

let sock = null;
let qrBase64Image = '';
let isConnected = false;

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        qrBase64Image = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
        isConnected = false;
        console.log('>>> [QR] 二维码 Base64 生成成功');
      } catch (err) {
        console.error('二维码转换失败:', err);
      }
    }

    if (connection === 'close') {
      isConnected = false;
      qrBase64Image = '';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`连接断开 (Status: ${statusCode})，5秒后重试...`);
      if (shouldReconnect) {
        setTimeout(startWhatsApp, 5000);
      }
    } else if (connection === 'open') {
      isConnected = true;
      qrBase64Image = '';
      console.log('>>> [SUCCESS] WhatsApp 已成功连接上线！');
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
          console.error('Webhook 推送失败:', err.message);
        }
      }
    }
  });
}

// 供前端轮询二维码图片数据
app.get('/qr-data', (req, res) => {
  res.json({ connected: isConnected, qrImage: qrBase64Image });
});

// 二维码扫码页面
app.get('/qr', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>WhatsApp 扫码授权</title>
      <style>
        body { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 90vh; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f7f9fa; margin: 0; }
        .card { background: white; padding: 32px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); text-align: center; width: 320px; }
        .qr-box { width: 280px; height: 280px; margin: 16px auto; display: flex; align-items: center; justify-content: center; border: 1px solid #eee; border-radius: 8px; background: #fafafa; }
        .qr-box img { width: 100%; height: 100%; border-radius: 8px; display: block; }
        .status { color: #666; font-size: 14px; margin-top: 12px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2 id="title" style="margin-top:0;">WhatsApp 扫码登录</h2>
        <div class="qr-box">
          <div id="loading">⏳ 获取中...</div>
          <img id="qr-img" style="display:none;" />
        </div>
        <p class="status" id="desc">请使用手机 WhatsApp 扫码绑定</p>
      </div>

      <script>
        let currentImg = '';
        async function pollQR() {
          try {
            const res = await fetch('/qr-data');
            const data = await res.json();
            
            if (data.connected) {
              document.getElementById('title').innerText = '✅ 连接成功！';
              document.getElementById('title').style.color = '#2e7d32';
              document.getElementById('loading').style.display = 'none';
              document.getElementById('qr-img').style.display = 'none';
              document.getElementById('desc').innerText = 'WhatsApp 网关已在线，可以关闭本页面。';
              return;
            }

            if (data.qrImage && data.qrImage !== currentImg) {
              currentImg = data.qrImage;
              document.getElementById('loading').style.display = 'none';
              const img = document.getElementById('qr-img');
              img.src = data.qrImage;
              img.style.display = 'block';
            }
          } catch (e) {}
        }
        setInterval(pollQR, 1500);
        pollQR();
      </script>
    </body>
    </html>
  `);
});

app.post('/send', async (req, res) => {
  const { to, text } = req.body;
  if (!isConnected || !sock) {
    return res.status(503).json({ success: false, error: 'WhatsApp 尚未连接' });
  }
  if (!to || !text) {
    return res.status(400).json({ success: false, error: '缺少 to 或 text' });
  }

  try {
    let targetJid = to.trim();
    if (!targetJid.includes('@')) {
      targetJid = `${targetJid}@s.whatsapp.net`;
    }
    const result = await sock.sendMessage(targetJid, { text: text });
    res.json({ success: true, messageId: result.key.id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Gateway 正在监听端口: ${PORT}`);
  startWhatsApp();
});
