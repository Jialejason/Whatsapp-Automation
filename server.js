const express = require('express');
const QRCode = require('qrcode');
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

const PORT = process.env.PORT || 10000;
const GAS_WEBHOOK_URL = process.env.GAS_WEBHOOK_URL || '';

let sock = null;
let currentQR = '';
let isConnected = false;

async function startWhatsApp() {
  console.log('>>> 正在启动 WhatsApp 客户端...');
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  
  let version = [2, 3000, 1015901307];
  try {
    const v = await fetchLatestBaileysVersion();
    version = v.version;
  } catch (e) {
    console.log('使用默认 Baileys 版本');
  }

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['Ubuntu', 'Chrome', '120.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      isConnected = false;
      console.log('>>> [QR] 收到新 QR 码字符，已准备就绪');
    }

    if (connection === 'close') {
      isConnected = false;
      currentQR = '';
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`连接断开 (状态码: ${statusCode})，5秒后自动重连...`);
      if (shouldReconnect) {
        setTimeout(startWhatsApp, 5000);
      }
    } else if (connection === 'open') {
      isConnected = true;
      currentQR = '';
      console.log('🎉🎉 WhatsApp 已成功连接！');
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

      console.log(`[消息进站] ${chatId} | ${senderName}: ${text}`);

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
          console.error('推送 Google Apps Script 失败:', err.message);
        }
      }
    }
  });
}

// 获取即时二维码图片（直接返回图片流，不依赖复杂轮询）
app.get('/qr.png', async (req, res) => {
  if (!currentQR) {
    return res.status(404).send('QR code not ready yet');
  }
  try {
    const qrBuffer = await QRCode.toBuffer(currentQR, { width: 300, margin: 2 });
    res.setHeader('Content-Type', 'image/png');
    res.send(qrBuffer);
  } catch (err) {
    res.status(500).send('Error generating QR');
  }
});

// 状态查询
app.get('/status', (req, res) => {
  res.json({ connected: isConnected, hasQR: !!currentQR });
});

// 主扫码页面
app.get('/qr', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>WhatsApp 扫码授权</title>
      <style>
        body { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 90vh; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f2f5; margin: 0; }
        .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); text-align: center; width: 320px; }
        .qr-wrapper { width: 280px; height: 280px; margin: 15px auto; display: flex; align-items: center; justify-content: center; border: 1px solid #e0e0e0; border-radius: 8px; background: #fafafa; }
        img { width: 100%; height: 100%; border-radius: 8px; }
        p { color: #555; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2 id="msg" style="margin-top:0;">WhatsApp 扫码登录</h2>
        <div class="qr-wrapper">
          <div id="loading">⏳ 连接建立中...</div>
          <img id="qr-image" style="display:none;" />
        </div>
        <p id="sub">请打开 WhatsApp -> 已关联的设备 扫码</p>
      </div>

      <script>
        async function check() {
          try {
            const res = await fetch('/status');
            const data = await res.json();
            if (data.connected) {
              document.getElementById('msg').innerText = '✅ 已经成功连接！';
              document.getElementById('msg').style.color = '#1b5e20';
              document.getElementById('loading').style.display = 'none';
              document.getElementById('qr-image').style.display = 'none';
              document.getElementById('sub').innerText = '网关正在运行中，可以关闭此网页。';
              return;
            }
            if (data.hasQR) {
              document.getElementById('loading').style.display = 'none';
              const img = document.getElementById('qr-image');
              img.src = '/qr.png?t=' + Date.now();
              img.style.display = 'block';
            }
          } catch(e) {}
        }
        setInterval(check, 2000);
        check();
      </script>
    </body>
    </html>
  `);
});

app.post('/send', async (req, res) => {
  const { to, text } = req.body;
  if (!isConnected || !sock) {
    return res.status(503).json({ success: false, error: 'WhatsApp 未连接' });
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
