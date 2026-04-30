const express = require('express');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(express.json());

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// ========== 從 JSON 檔案載入角色設定 ==========
let ROLES = {};

function loadRoles() {
  try {
    const data = fs.readFileSync('./roles.json', 'utf8');
    ROLES = JSON.parse(data);
    console.log(`✅ ${new Date().toLocaleString()} - 已載入 ${Object.keys(ROLES).length} 個角色：${Object.keys(ROLES).join(', ')}`);
  } catch (error) {
    console.error('❌ 讀取 roles.json 失敗：', error.message);
    ROLES = {};
  }
}

loadRoles();
setInterval(loadRoles, 60000);

// ========== DeepSeek 呼叫函數 ==========
async function callDeepSeek(userMessage, systemPrompt) {
  console.log('📡 呼叫 DeepSeek API...');
  
  try {
    const response = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        temperature: 0.8,
        max_tokens: 1500
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        },
        timeout: 15000
      }
    );
    
    const reply = response.data.choices[0].message.content;
    console.log(`✅ DeepSeek 回覆成功，長度：${reply.length} 字元`);
    return reply;
    
  } catch (error) {
    console.error('❌ DeepSeek API 錯誤：', error.response?.data || error.message);
    
    if (error.response?.data?.error?.code === 'insufficient_quota') {
      return 'DeepSeek 額度已用盡，請檢查帳單。';
    }
    return '抱歉，AI 暫時無法回應，請稍後再試。';
  }
}

// ========== LINE Webhook ==========
app.post('/webhook/:role', async (req, res) => {
  const role = req.params.role;
  const roleConfig = ROLES[role];
  
  if (!roleConfig) {
    console.log(`❌ 未知角色：${role}`);
    return res.status(404).send('Role not found');
  }
  
  console.log(`🎭 [${new Date().toLocaleString()}] 角色「${roleConfig.name}」被呼叫`);
  
  const events = req.body.events;
  if (!events || events.length === 0) {
    return res.status(200).send('OK');
  }
  
  for (const event of events) {
    const replyToken = event.replyToken;
    const userMessage = event.message?.text;
    
    if (replyToken && userMessage) {
      try {
        const aiReply = await callDeepSeek(userMessage, roleConfig.systemPrompt);
        
        await axios.post('https://api.line.me/v2/bot/message/reply', {
          replyToken: replyToken,
          messages: [{ type: 'text', text: aiReply }]
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
          }
        });
        
        console.log(`   💬 用戶：${userMessage.substring(0, 50)}`);
        console.log(`   🤖 ${roleConfig.name}：${aiReply.substring(0, 50)}...\n`);
        
      } catch (error) {
        console.error('回覆失敗：', error.response?.data || error.message);
      }
    } else if (replyToken && !userMessage) {
      await axios.post('https://api.line.me/v2/bot/message/reply', {
        replyToken: replyToken,
        messages: [{ type: 'text', text: roleConfig.welcome }]
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
        }
      });
    }
  }
  
  res.status(200).send('OK');
});

app.get('/', (req, res) => {
  const roles = Object.keys(ROLES);
  res.status(200).send(`
🤖 LINE Bot 多角色服務運作中（DeepSeek 版）

可用角色：${roles.join(', ')}

使用方式：
/webhook/角色名稱
  `);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 伺服器運作中，port: ${port}`);
  console.log(`📋 已載入角色：${Object.keys(ROLES).join(', ')}`);
});
