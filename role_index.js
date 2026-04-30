const express = require('express');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(express.json());

// ========== 環境變數檢查 ==========
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
if (!DEEPSEEK_API_KEY) {
  console.error('❌ 錯誤：未設定 DEEPSEEK_API_KEY 環境變數');
}

// ========== 從 customers.json 載入角色設定 ==========
let CUSTOMERS = {};

function loadCustomers() {
  try {
    const data = fs.readFileSync('./customers.json', 'utf8');
    CUSTOMERS = JSON.parse(data);
    console.log(`✅ ${new Date().toLocaleString()} - 已載入 ${Object.keys(CUSTOMERS).length} 個角色：${Object.keys(CUSTOMERS).join(', ')}`);
  } catch (error) {
    console.error('❌ 讀取 customers.json 失敗：', error.message);
  }
}

loadCustomers();
setInterval(loadCustomers, 60000); // 每 60 秒重新載入

// ========== 對話記憶（純記憶體） ==========
const userConversations = {};
const MAX_HISTORY_MESSAGES = 20; // 10 組對話

function getConversationHistory(userId, roleId) {
  const key = `${roleId}:${userId}`;
  if (!userConversations[key]) {
    userConversations[key] = [];
  }
  return userConversations[key];
}

function addToHistory(userId, roleId, role, content) {
  const key = `${roleId}:${userId}`;
  const history = getConversationHistory(userId, roleId);
  history.push({ role, content });
  
  while (history.length > MAX_HISTORY_MESSAGES) {
    history.shift();
  }
}

// 每天凌晨清理一次記憶體
setInterval(() => {
  const keys = Object.keys(userConversations);
  if (keys.length > 0) {
    console.log(`🧹 定期清理記憶體，清除 ${keys.length} 位使用者的對話記錄`);
    for (const key of keys) {
      delete userConversations[key];
    }
  }
}, 24 * 60 * 60 * 1000);

// ========== DeepSeek 呼叫函數（含對話記憶） ==========
async function callDeepSeekWithMemory(userId, roleId, userMessage, systemPrompt) {
  console.log(`📡 呼叫 DeepSeek API（角色：${roleId}，使用者：${userId.substring(0, 8)}...）`);
  
  const history = getConversationHistory(userId, roleId);
  console.log(`   📝 記憶長度：${history.length} 則訊息`);
  
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage }
  ];
  
  try {
    const response = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-chat',
        messages: messages,
        temperature: 0.8,
        max_tokens: 1000
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
    
    addToHistory(userId, roleId, 'user', userMessage);
    addToHistory(userId, roleId, 'assistant', reply);
    
    console.log(`   ✅ 回覆成功，長度：${reply.length} 字元`);
    return reply;
    
  } catch (error) {
    console.error('❌ DeepSeek API 錯誤：', error.response?.data || error.message);
    return '抱歉，我暫時無法回應，請稍後再試。';
  }
}

// ========== LINE 回覆輔助函數 ==========
async function replyToLine(replyToken, text, lineAccessToken) {
  await axios.post('https://api.line.me/v2/bot/message/reply', {
    replyToken: replyToken,
    messages: [{ type: 'text', text: text }]
  }, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${lineAccessToken}`
    }
  });
}

// ========== LINE Webhook（多客戶支援） ==========
app.post('/webhook/:role', async (req, res) => {
  const roleId = req.params.role;
  
  // 1. 檢查角色是否存在
  const customer = CUSTOMERS[roleId];
  if (!customer) {
    console.log(`❌ 未知角色：${roleId}`);
    return res.status(404).send('Role not found');
  }
  
  // 2. 檢查該角色的 LINE Token 環境變數
  const envTokenName = `${roleId.toUpperCase()}_LINE_ACCESS_TOKEN`;
  const lineAccessToken = process.env[envTokenName];
  if (!lineAccessToken) {
    console.error(`❌ 未設定環境變數：${envTokenName}`);
    return res.status(500).send('Server config error');
  }
  
  const events = req.body.events;
  if (!events || events.length === 0) {
    return res.status(200).send('OK');
  }
  
  for (const event of events) {
    const replyToken = event.replyToken;
    const userMessage = event.message?.text;
    const userId = event.source?.userId;
    
    if (!userId) {
      console.log('⚠️ 無法取得使用者 ID');
      continue;
    }
    
    console.log(`\n🎭 [${new Date().toLocaleString()}] 角色「${customer.name}」(ID: ${roleId})`);
    console.log(`   👤 使用者：${userId.substring(0, 8)}...`);
    
    if (replyToken && userMessage) {
      try {
        const aiReply = await callDeepSeekWithMemory(userId, roleId, userMessage, customer.systemPrompt);
        await replyToLine(replyToken, aiReply, lineAccessToken);
        console.log(`   💬 用戶：${userMessage.substring(0, 50)}`);
        console.log(`   🤖 ${customer.name}：${aiReply.substring(0, 50)}...\n`);
      } catch (error) {
        console.error('回覆失敗：', error.message);
        await replyToLine(replyToken, '抱歉，發生錯誤，請稍後再試。', lineAccessToken);
      }
    } else if (replyToken && !userMessage) {
      // 非文字訊息（貼圖、圖片等），回傳歡迎訊息
      await replyToLine(replyToken, customer.welcome, lineAccessToken);
    }
  }
  
  res.status(200).send('OK');
});

// 健康檢查端點
app.get('/', (req, res) => {
  const roles = Object.keys(CUSTOMERS);
  res.status(200).send(`
🤖 LINE Bot 多角色服務運作中

已載入角色：${roles.join(', ')}

使用方式：
將 LINE Bot 的 Webhook 設為：
https://你的服務.onrender.com/webhook/角色ID

並在環境變數設定：{角色ID大寫}_LINE_ACCESS_TOKEN
  `);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 伺服器運作中，port: ${port}`);
  console.log(`📋 已載入角色：${Object.keys(CUSTOMERS).join(', ')}`);
});
