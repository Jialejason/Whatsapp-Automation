const express = require('express');
const qrcode = require('qrcode');
const axios = require('axios');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GAS_WEBHOOK_URL = process.env.GAS_WEBHOOK_URL || '';

let sock = null;
let currentQR = '';
let isConnected = false;

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      isConnected = false;
      console.log('>>> [QR] 二维码已刷新');
    }

    if (connection === 'close') {
      isConnected = false;
      currentQR = '';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`连接断开 (Status: ${statusCode})，5秒后重试...`);
      if (shouldReconnect) {
        setTimeout(startWhatsApp, 5000);
      }
    } else if (connection === 'open') {
      isConnected = true;
      currentQR = '';
      console.log('>>> [SUCCESS] WhatsApp 已成功连接！');
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

// 供前端动态获取 QR 字符串
app.get('/qr-raw', (req, res) => {
  res.json({ connected: isConnected, qr: currentQR });
});

// 二维码前端页面
app.get('/qr', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>WhatsApp 扫码授权</title>
      <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
      <style>
        body { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 90vh; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f7f9fa; }
        .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); text-align: center; }
        #canvas { margin: 15px 0; border: 1px solid #eee; padding: 10px; border-radius: 8px; }
        .status { color: #666; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2 id="title">WhatsApp 扫码登录</h2>
        <div id="loading">⏳ 正在获取二维码，请稍候...</div>
        <canvas id="canvas" style="display:none;"></canvas>
        <p class="status" id="desc">请使用手机 WhatsApp 扫描屏幕上的二维码</p>
      </div>

      <script>
        let lastQR = '';
        async function checkStatus() {
          try {
            const res = await fetch('/qr-raw');
            const data = await res.json();
            
            if (data.connected) {
              document.getElementById('title').innerText = '✅ 连接成功！';
              document.getElementById('title').style.color = '#2e7d32';
              document.getElementById('loading').style.display = 'none';
              document.getElementById('canvas').style.display = 'none';
              document.getElementById('desc').innerText = 'WhatsApp 网关已就绪，可关闭此页面。';
              return;
            }

            if (data.qr && data.qr !== lastQR) {
              lastQR = data.qr;
              document.getElementById('loading').style.display = 'none';
              const canvas = document.getElementById('canvas');
              canvas.style.display = 'block';
              QRCode.toCanvas(canvas, data.qr, { width: 260, margin: 2 });
            }
          } catch (e) {}
        }
        setInterval(checkStatus, 2000);
        checkStatus();
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
