const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// LINE Channel Access Token（從環境變數讀取）
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;

// Webhook 端點
app.post('/webhook', async (req, res) => {
  console.log('收到 Webhook 請求');
  
  const events = req.body.events;
  if (!events || events.length === 0) {
    return res.status(200).send('OK');
  }
  
  for (const event of events) {
    const replyToken = event.replyToken;
    const userMessage = event.message?.text;
    
    if (replyToken && userMessage) {
      try {
        // 回覆訊息
        await axios.post('https://api.line.me/v2/bot/message/reply', {
          replyToken: replyToken,
          messages: [{
            type: 'text',
            text: `你說了：${userMessage}`
          }]
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
          }
        });
        console.log(`已回覆：${userMessage}`);
      } catch (error) {
        console.error('回覆失敗：', error.response?.data || error.message);
      }
    }
  }
  
  // LINE 要求回傳 200
  res.status(200).send('OK');
});

// 健康檢查端點（讓 Render 知道服務活著）
app.get('/', (req, res) => {
  res.status(200).send('LINE Bot is running');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`伺服器運作中，port: ${port}`);
});
