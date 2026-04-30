const express = require('express');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(express.json());

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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

// 啟動時載入一次
loadRoles();

// 每 60 秒重新載入一次（讓修改 roles.json 後自動生效，不用重啟服務）
setInterval(loadRoles, 60000);

// ========== AI 呼叫函數 ==========
async function callGemini(userMessage, systemPrompt) {
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [
          {
            role: "user",
            parts: [{ text: userMessage }]
          }
        ],
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 500
        }
      },
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    return response.data.candidates[0].content.parts[0].text;
  } catch (error) {
    console.error('Gemini API 錯誤：', error.response?.data || error.message);
    return '抱歉，AI 暫時無法回應，請稍後再試。';
  }
}

// ========== LINE Webhook（支援動態路徑）==========
app.post('/webhook/:role', async (req, res) => {
  const role = req.params.role;
  
  // 檢查角色是否存在
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
        // 呼叫 Gemini，帶入該角色的系統提示
        const aiReply = await callGemini(userMessage, roleConfig.systemPrompt);
        
        await axios.post('https://api.line.me/v2/bot/message/reply', {
          replyToken: replyToken,
          messages: [{
            type: 'text',
            text: aiReply
          }]
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
      // 如果不是文字訊息（例如貼圖、圖片），回傳歡迎訊息
      await axios.post('https://api.line.me/v2/bot/message/reply', {
        replyToken: replyToken,
        messages: [{
          type: 'text',
          text: roleConfig.welcome
        }]
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

// 健康檢查端點（列出可用角色）
app.get('/', (req, res) => {
  const availableRoles = Object.keys(ROLES);
  const roleList = availableRoles.map(r => `  - /webhook/${r} (${ROLES[r].name})`).join('\n');
  res.status(200).send(`
🤖 LINE Bot 多角色服務運作中

可用角色（5 個試用）：
${roleList}

使用方式：
將 LINE Bot 的 Webhook URL 設為：
https://你的服務名稱.onrender.com/webhook/角色名稱

例如：https://你的服務名稱.onrender.com/webhook/fitness
  `);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 伺服器運作中，port: ${port}`);
  console.log(`📋 已載入 ${Object.keys(ROLES).length} 個角色：${Object.keys(ROLES).join(', ')}`);
});
