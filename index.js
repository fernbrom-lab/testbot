const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const app = express();
app.use(express.json());
app.use(express.static('public')); // 讓照片牆網頁可以被訪問

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// ========== Google Sheets 設定 ==========
let googleSheetDoc = null;
let googleSheetReady = false;

async function initGoogleSheets() {
  try {
    // 從環境變數或金鑰檔案讀取設定
    let client_email, private_key;
    
    if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
      client_email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
      private_key = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
    } else if (fs.existsSync('./service-account-key.json')) {
      const keyFile = JSON.parse(fs.readFileSync('./service-account-key.json', 'utf8'));
      client_email = keyFile.client_email;
      private_key = keyFile.private_key;
    } else {
      console.log('⚠️ 未找到 Google Sheets 設定，圖片儲存功能將停用');
      return false;
    }
    
    const auth = new JWT({
      email: client_email,
      key: private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
      console.log('⚠️ 未設定 GOOGLE_SHEET_ID，圖片儲存功能將停用');
      return false;
    }
    
    googleSheetDoc = new GoogleSpreadsheet(sheetId, auth);
    await googleSheetDoc.loadInfo();
    
    // 建立照片牆工作表（如果不存在）
    let sheet = googleSheetDoc.sheetsByTitle['照片牆'];
    if (!sheet) {
      sheet = await googleSheetDoc.addSheet({ 
        title: '照片牆', 
        headerValues: ['時間', '使用者ID', '圖片URL', '角色', '原始訊息'] 
      });
      console.log('✅ 已建立「照片牆」工作表');
    }
    
    console.log('✅ Google Sheets 連線成功');
    return true;
  } catch (error) {
    console.error('❌ Google Sheets 連線失敗：', error.message);
    return false;
  }
}

// ========== ImgBB 上傳 ==========
async function uploadToImgBB(imageBuffer) {
  const apiKey = process.env.IMGBB_API_KEY;
  if (!apiKey) {
    console.log('⚠️ 未設定 IMGBB_API_KEY，無法上傳圖片');
    return null;
  }
  
  try {
    const base64Image = imageBuffer.toString('base64');
    const response = await axios.post(
      `https://api.imgbb.com/1/upload?key=${apiKey}`,
      new URLSearchParams({
        image: base64Image,
        expiration: 0 // 永久儲存
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 30000
      }
    );
    
    return response.data.data.url;
  } catch (error) {
    console.error('❌ ImgBB 上傳失敗：', error.message);
    return null;
  }
}

// ========== 儲存圖片到 Google Sheets ==========
async function savePhotoToSheet(userId, imageUrl, role, userMessage = '') {
  if (!googleSheetDoc) {
    console.log('⚠️ Google Sheets 未就緒，無法儲存圖片');
    return false;
  }
  
  try {
    const sheet = googleSheetDoc.sheetsByTitle['照片牆'];
    await sheet.addRow({
      '時間': new Date().toISOString(),
      '使用者ID': userId,
      '圖片URL': imageUrl,
      '角色': role,
      '原始訊息': userMessage || ''
    });
    console.log(`📸 照片已儲存到 Google Sheets - 使用者：${userId}`);
    return true;
  } catch (error) {
    console.error('❌ 儲存到 Google Sheets 失敗：', error.message);
    return false;
  }
}

// ========== 對話記憶（純記憶體，不用資料庫） ==========
const userConversations = {};
const MAX_HISTORY_MESSAGES = 20;

function getConversationHistory(userId) {
  if (!userConversations[userId]) {
    userConversations[userId] = [];
  }
  return userConversations[userId];
}

function addToHistory(userId, role, content) {
  const history = getConversationHistory(userId);
  history.push({ role, content });
  while (history.length > MAX_HISTORY_MESSAGES) {
    history.shift();
  }
}

// 定期清理記憶體
setInterval(() => {
  const users = Object.keys(userConversations);
  if (users.length > 0) {
    console.log(`🧹 定期清理記憶體，清除 ${users.length} 位使用者的對話記錄`);
    for (const userId of users) {
      delete userConversations[userId];
    }
  }
}, 24 * 60 * 60 * 1000);

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

// ========== DeepSeek 呼叫函數（原有功能，完全不變） ==========
async function callDeepSeekWithMemory(userId, userMessage, systemPrompt) {
  console.log(`📡 呼叫 DeepSeek API（使用者 ${userId.substring(0, 8)}...，有記憶模式）`);
  
  const history = getConversationHistory(userId);
  console.log(`   📝 記憶長度：${history.length} 則訊息（最多 ${MAX_HISTORY_MESSAGES} 則）`);
  
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
    addToHistory(userId, 'user', userMessage);
    addToHistory(userId, 'assistant', reply);
    
    console.log(`   ✅ DeepSeek 回覆成功，新記憶長度：${history.length + 2} 則`);
    return reply;
    
  } catch (error) {
    console.error('❌ DeepSeek API 錯誤：', error.response?.data || error.message);
    if (error.response?.data?.error?.message) {
      return `DeepSeek 錯誤：${error.response.data.error.message}`;
    }
    return '抱歉，AI 暫時無法回應，請稍後再試。';
  }
}

// ========== LINE Webhook（新增圖片處理） ==========
app.post('/webhook/:role', async (req, res) => {
  const role = req.params.role;
  const roleConfig = ROLES[role];
  
  if (!roleConfig) {
    console.log(`❌ 未知角色：${role}`);
    return res.status(404).send('Role not found');
  }
  
  const events = req.body.events;
  if (!events || events.length === 0) {
    return res.status(200).send('OK');
  }
  
  for (const event of events) {
    const replyToken = event.replyToken;
    const userMessage = event.message?.text;
    const userId = event.source?.userId;
    const messageType = event.message?.type;
    
    if (!userId) {
      console.log('⚠️ 無法取得使用者 ID');
      continue;
    }
    
    console.log(`\n🎭 [${new Date().toLocaleString()}] 角色「${roleConfig.name}」`);
    console.log(`   👤 使用者 ID：${userId.substring(0, 8)}...`);
    
    if (!replyToken) continue;
    
    try {
      // ========== 處理圖片訊息（新增功能） ==========
      if (messageType === 'image') {
        const messageId = event.message.id;
        console.log(`   📸 收到圖片訊息，ID：${messageId}`);
        
        try {
          // 1. 從 LINE 下載圖片
          console.log(`   🔄 下載圖片中...`);
          const imageResponse = await axios.get(
            `https://api-data.line.me/v2/bot/message/${messageId}/content`,
            {
              headers: { 'Authorization': `Bearer ${LINE_ACCESS_TOKEN}` },
              responseType: 'arraybuffer',
              timeout: 30000
            }
          );
          
          console.log(`   ✅ 圖片下載成功，大小：${(imageResponse.data.length / 1024).toFixed(2)} KB`);
          
          // 2. 上傳到 ImgBB
          console.log(`   📤 上傳到 ImgBB...`);
          const imageUrl = await uploadToImgBB(imageResponse.data);
          
          if (imageUrl) {
            // 3. 儲存到 Google Sheets
            await savePhotoToSheet(userId, imageUrl, role, userMessage || '圖片分享');
            
            // 4. 回覆成功訊息
            const replyText = `📸 照片已上傳到照片牆！\n🔗 ${imageUrl}\n\n💡 查看照片牆：${process.env.PHOTOWALL_URL || 'http://localhost:' + port + '/photowall'}`;
            
            await axios.post('https://api.line.me/v2/bot/message/reply', {
              replyToken: replyToken,
              messages: [{ type: 'text', text: replyText }]
            }, {
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
              }
            });
            
            console.log(`   ✅ 圖片處理完成！`);
          } else {
            // 圖片上傳失敗
            await axios.post('https://api.line.me/v2/bot/message/reply', {
              replyToken: replyToken,
              messages: [{ type: 'text', text: '❌ 圖片上傳失敗，請稍後再試。' }]
            }, {
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
              }
            });
          }
          
        } catch (imageError) {
          console.error('   ❌ 圖片處理錯誤：', imageError.message);
          await axios.post('https://api.line.me/v2/bot/message/reply', {
            replyToken: replyToken,
            messages: [{ type: 'text', text: `❌ 圖片處理失敗：${imageError.message}` }]
          }, {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
            }
          });
        }
      }
      // ========== 處理文字訊息（原有功能，完全不變） ==========
      else if (messageType === 'text' && userMessage) {
        const aiReply = await callDeepSeekWithMemory(userId, userMessage, roleConfig.systemPrompt);
        
        await axios.post('https://api.line.me/v2/bot/message/reply', {
          replyToken: replyToken,
          messages: [{ type: 'text', text: aiReply }]
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
          }
        });
        
        console.log(`   💬 用戶：${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}`);
        console.log(`   🤖 ${roleConfig.name}：${aiReply.substring(0, 50)}${aiReply.length > 50 ? '...' : ''}\n`);
      }
      // ========== 其他訊息（貼圖等） ==========
      else {
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
      
    } catch (error) {
      console.error('回覆失敗：', error.response?.data || error.message);
    }
  }
  
  res.status(200).send('OK');
});

// ========== 照片牆 API 和網頁 ==========
app.get('/api/photos', async (req, res) => {
  if (!googleSheetDoc) {
    return res.json([]);
  }
  
  try {
    const sheet = googleSheetDoc.sheetsByTitle['照片牆'];
    const rows = await sheet.getRows();
    const photos = rows.map(row => ({
      time: row['時間'],
      userId: row['使用者ID'],
      imageUrl: row['圖片URL'],
      role: row['角色'],
      message: row['原始訊息']
    })).reverse(); // 最新的在前面
    
    res.json(photos.slice(0, 100));
  } catch (error) {
    console.error('讀取照片失敗：', error.message);
    res.status(500).json({ error: '讀取失敗' });
  }
});

// 照片牆網頁
app.get('/photowall', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>📸 回憶照片牆</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        .header {
            text-align: center;
            color: white;
            margin-bottom: 40px;
            padding: 20px;
        }
        .header h1 { font-size: 3em; margin-bottom: 10px; text-shadow: 2px 2px 4px rgba(0,0,0,0.2); }
        .photo-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 25px;
            padding: 10px;
        }
        .photo-card {
            background: white;
            border-radius: 15px;
            overflow: hidden;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            transition: transform 0.3s ease;
            cursor: pointer;
        }
        .photo-card:hover { transform: translateY(-5px); }
        .photo-image { width: 100%; height: 300px; object-fit: cover; }
        .photo-info { padding: 15px; }
        .photo-user { font-weight: bold; color: #333; margin-bottom: 5px; }
        .photo-role { display: inline-block; background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 4px 10px; border-radius: 12px; font-size: 0.85em; margin: 8px 0; }
        .photo-time { color: #999; font-size: 0.8em; margin-top: 10px; }
        .loading { text-align: center; color: white; font-size: 1.2em; padding: 50px; }
        .modal {
            display: none;
            position: fixed;
            z-index: 1000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0,0,0,0.95);
        }
        .modal-content { position: relative; margin: auto; padding: 20px; width: 90%; max-width: 1200px; top: 50%; transform: translateY(-50%); }
        .modal-image { width: 100%; height: auto; border-radius: 10px; }
        .close { position: absolute; top: 20px; right: 35px; color: #f1f1f1; font-size: 40px; font-weight: bold; cursor: pointer; }
        .refresh-btn {
            position: fixed;
            bottom: 30px;
            right: 30px;
            background: white;
            border: none;
            border-radius: 50px;
            padding: 15px 25px;
            cursor: pointer;
            font-size: 16px;
            font-weight: bold;
            color: #667eea;
            box-shadow: 0 4px 15px rgba(0,0,0,0.2);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📸 回憶照片牆</h1>
            <p>和AI機器人的美好時光</p>
        </div>
        <div class="photo-grid" id="photoGrid"><div class="loading">📷 載入照片中...</div></div>
    </div>
    <button class="refresh-btn" onclick="loadPhotos()">🔄 重新整理</button>
    <div id="modal" class="modal"><span class="close">&times;</span><div class="modal-content"><img class="modal-image" id="modalImage"></div></div>
    <script>
        let modal = document.getElementById('modal');
        let modalImg = document.getElementById('modalImage');
        document.querySelector('.close').onclick = () => modal.style.display = "none";
        modal.onclick = (e) => { if(e.target === modal) modal.style.display = "none"; };
        
        async function loadPhotos() {
            const grid = document.getElementById('photoGrid');
            grid.innerHTML = '<div class="loading">📷 載入照片中...</div>';
            try {
                const response = await fetch('/api/photos');
                const photos = await response.json();
                if (!photos || photos.length === 0) {
                    grid.innerHTML = '<div class="loading">📸 暫無照片，快上傳第一張吧！</div>';
                    return;
                }
                grid.innerHTML = '';
                photos.forEach(photo => {
                    const card = document.createElement('div');
                    card.className = 'photo-card';
                    card.onclick = () => { modal.style.display = "block"; modalImg.src = photo.imageUrl; };
                    card.innerHTML = \`
                        <img class="photo-image" src="\${photo.imageUrl}" alt="回憶照片" onerror="this.src='https://via.placeholder.com/300?text=載入失敗'">
                        <div class="photo-info">
                            <div class="photo-user">👤 \${photo.userId?.substring(0, 15) || '匿名'}</div>
                            <div class="photo-role">🎭 \${photo.role || '未知角色'}</div>
                            <div class="photo-time">🕒 \${new Date(photo.time).toLocaleString('zh-TW')}</div>
                        </div>
                    \`;
                    grid.appendChild(card);
                });
            } catch(error) {
                grid.innerHTML = '<div class="loading">❌ 載入失敗</div>';
            }
        }
        loadPhotos();
        setInterval(loadPhotos, 30000);
    </script>
</body>
</html>
  `);
});

// 健康檢查端點
app.get('/', (req, res) => {
  res.status(200).send('別偷看我屁股');
});

const port = process.env.PORT || 3000;

// 啟動伺服器
app.listen(port, async () => {
  console.log(`🚀 伺服器運作中，port: ${port}`);
  console.log(`📋 已載入角色：${Object.keys(ROLES).join(', ')}`);
  console.log(`🧠 對話記憶模式：每個使用者最多記住 ${MAX_HISTORY_MESSAGES} 則訊息（10 組對話）`);
  
  // 初始化 Google Sheets
  await initGoogleSheets();
  
  console.log(`📸 照片牆網址：http://localhost:${port}/photowall`);
});
