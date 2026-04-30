const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;

// ⚠️ 關鍵：這個路由必須存在
app.post('/webhook', async (req, res) => {
  console.log('收到 webhook 請求');
  
  const events = req.body.events;
  if (!events || events.length === 0) {
    return res.status(200).send('OK');
  }
  
  for (const event of events) {
    const replyToken = event.replyToken;
    const userMessage = event.message?.text;
    
    if (replyToken && userMessage) {
      try {
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
        console.log('回覆成功');
      } catch (error) {
        console.error('回覆失敗：', error.response?.data || error.message);
      }
    }
  }
  
  res.status(200).send('OK');
});

app.get('/', (req, res) => {
  res.status(200).send('LINE Bot is running');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`伺服器運作中，port: ${port}`);
});
