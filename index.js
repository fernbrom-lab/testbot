const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const cloudinary = require('cloudinary').v2;

const app = express();
app.use(express.json());
app.use(express.static('public'));

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// ========== Cloudinary 設定 ==========
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ========== Google Sheets 設定 ==========
let googleSheetReady = false;
let photosSheet = null;

async function initGoogleSheets() {
  try {
    console.log('🔧 開始初始化 Google Sheets...');
    
    const client_email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const private_key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    const sheetId = process.env.GOOGLE_SHEET_ID;
    
    if (!client_email || !private_key || !sheetId) {
      console.log('⚠️ 缺少 Google Sheets 環境變數');
      return false;
    }
    
    const auth = new JWT({
      email: client_email,
      key: private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    console.log('✅ 文件載入成功');
    
    photosSheet = doc.sheetsByTitle['照片牆'];
    if (!photosSheet) {
      photosSheet = await doc.addSheet({ title: '照片牆' });
      console.log('✅ 已建立「照片牆」工作表');
    }
    
    const expectedHeaders = ['時間', '使用者ID', '圖片URL', '角色', '原始訊息'];
    
    await photosSheet.loadHeaderRow();
    const currentHeaders = photosSheet.headerValues;
    
    if (currentHeaders.length === 0 || currentHeaders[0] !== '時間') {
      console.log('🔄 重新設定標題列...');
      await photosSheet.clear();
      photosSheet.headerValues = expectedHeaders;
      await photosSheet.setHeaderRow(expectedHeaders);
      console.log('✅ 標題列已設定');
    }
    
    googleSheetReady = true;
    console.log('✅ Google Sheets 連線成功！');
    return true;
  } catch (error) {
    console.error('❌ Google Sheets 連線失敗：', error.message);
    googleSheetReady = false;
    return false;
  }
}

// ========== Cloudinary 上傳圖片 ==========
async function uploadToCloudinary(imageBuffer, retries = 3) {
  console.log(`☁️ 上傳到 Cloudinary... (剩餘嘗試次數: ${retries})`);
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: 'linebot_photos',
            timeout: 30000,
          },
          (error, uploadResult) => {
            if (error) {
              return reject(error);
            }
            if (uploadResult && uploadResult.secure_url) {
              resolve(uploadResult);
            } else {
              reject(new Error('Cloudinary 未回傳圖片網址'));
            }
          }
        );
        uploadStream.end(imageBuffer);
      });
      
      console.log(`✅ Cloudinary 上傳成功 (嘗試 ${attempt} 次)`);
      return result.secure_url;
      
    } catch (error) {
      console.error(`❌ Cloudinary 上傳失敗 (嘗試 ${attempt}/${retries}):`, error.message);
      if (attempt === retries) {
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return null;
}

// ========== 儲存圖片到 Google Sheets ==========
async function savePhotoToSheet(userId, imageUrl, role, userMessage = '') {
  if (!googleSheetReady || !photosSheet) {
    console.log('⚠️ Google Sheets 未就緒');
    return false;
  }
  
  try {
    await photosSheet.loadHeaderRow();
    
    const rowData = {
      '時間': new Date().toISOString(),
      '使用者ID': userId,
      '圖片URL': imageUrl,
      '角色': role,
      '原始訊息': userMessage || ''
    };
    
    await photosSheet.addRow(rowData);
    console.log(`📸 照片已儲存`);
    return true;
  } catch (error) {
    console.error('❌ 儲存失敗：', error.message);
    return false;
  }
}

// ========== 對話記憶 ==========
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

setInterval(() => {
  const users = Object.keys(userConversations);
  if (users.length > 0) {
    console.log(`🧹 清理 ${users.length} 位使用者的對話記錄`);
    for (const userId of users) {
      delete userConversations[userId];
    }
  }
}, 24 * 60 * 60 * 1000);

// ========== 角色設定 ==========
let ROLES = {};

function loadRoles() {
  try {
    const data = fs.readFileSync('./roles.json', 'utf8');
    ROLES = JSON.parse(data);
    console.log(`✅ 已載入 ${Object.keys(ROLES).length} 個角色：${Object.keys(ROLES).join(', ')}`);
  } catch (error) {
    console.error('❌ 讀取 roles.json 失敗：', error.message);
    ROLES = {};
  }
}

loadRoles();
setInterval(loadRoles, 60000);

// ========== DeepSeek 呼叫 ==========
async function callDeepSeekWithMemory(userId, userMessage, systemPrompt) {
  const history = getConversationHistory(userId);
  
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
    
    return reply;
  } catch (error) {
    console.error('❌ DeepSeek 錯誤：', error.response?.data || error.message);
    return '抱歉，AI 暫時無法回應，請稍後再試。';
  }
}

// ========== 回覆訊息的輔助函數 ==========
async function replyToUser(replyToken, message) {
  if (!replyToken) return;
  
  try {
    await axios.post('https://api.line.me/v2/bot/message/reply', {
      replyToken: replyToken,
      messages: [{ type: 'text', text: message }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
      }
    });
  } catch (error) {
    console.error('回覆失敗：', error.response?.data || error.message);
  }
}

// ========== 根目錄：轉址到照片牆 ==========
app.get('/', (req, res) => {
  res.redirect('/photowall');
});

// ========== 個人相簿專屬頁面 ==========
app.get('/user/:userId', (req, res) => {
  const userId = req.params.userId;
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>我的相簿</title>
        <script>
            localStorage.setItem('userId', '${userId}');
            window.location.href = '/photowall';
        </script>
    </head>
    <body>載入中...</body>
    </html>
  `);
});

// ========== LINE Webhook ==========
app.post('/webhook/:role', async (req, res) => {
  res.status(200).send('OK');
  
  const role = req.params.role;
  const roleConfig = ROLES[role];
  
  if (!roleConfig) {
    console.log(`❌ 未知角色：${role}`);
    return;
  }
  
  const events = req.body.events;
  if (!events || events.length === 0) return;
  
  for (const event of events) {
    const replyToken = event.replyToken;
    const userMessage = event.message?.text;
    const userId = event.source?.userId;
    const messageType = event.message?.type;
    
    if (!userId) continue;
    
    console.log(`\n🎭 [${new Date().toLocaleString()}] 角色「${roleConfig.name}」`);
    console.log(`   👤 使用者：${userId.substring(0, 8)}...`);
    
    try {
      // 處理圖片
      if (messageType === 'image') {
        const messageId = event.message.id;
        console.log(`   📸 收到圖片：${messageId}`);
        
        const imageResponse = await axios.get(
          `https://api-data.line.me/v2/bot/message/${messageId}/content`,
          {
            headers: { 'Authorization': `Bearer ${LINE_ACCESS_TOKEN}` },
            responseType: 'arraybuffer',
            timeout: 30000
          }
        );
        console.log(`   ✅ 下載完成：${(imageResponse.data.length / 1024).toFixed(2)} KB`);
        
        const imageUrl = await uploadToCloudinary(imageResponse.data);
        
        if (imageUrl) {
          await savePhotoToSheet(userId, imageUrl, roleConfig.name, userMessage || '圖片分享');
          
          // 回覆包含個人相簿專屬連結
          const replyText = `📸 照片已上傳成功！\n\n` +
            `🏠 全部照片牆：\nhttps://fbtestbot.onrender.com/photowall\n\n` +
            `👤 你的個人相簿（可刪除照片）：\nhttps://fbtestbot.onrender.com/user/${userId}`;
          
          await replyToUser(replyToken, replyText);
          console.log(`   ✅ 完成！`);
        } else {
          await replyToUser(replyToken, `❌ 圖片上傳失敗，請稍後再試`);
        }
      }
      // 處理文字訊息
      else if (messageType === 'text' && userMessage) {
        const aiReply = await callDeepSeekWithMemory(userId, userMessage, roleConfig.systemPrompt);
        await replyToUser(replyToken, aiReply);
        console.log(`   💬 用戶：${userMessage.substring(0, 50)}`);
        console.log(`   🤖 回應：${aiReply.substring(0, 50)}`);
      }
      // 其他訊息
      else if (replyToken) {
        await replyToUser(replyToken, roleConfig.welcome);
      }
      
    } catch (error) {
      console.error(`   ❌ 錯誤：`, error.message);
      if (replyToken) {
        await replyToUser(replyToken, `❌ 處理失敗：${error.message}`);
      }
    }
  }
});

// ========== 照片牆 API ==========

// 取得全部照片
app.get('/api/photos', async (req, res) => {
  if (!googleSheetReady || !photosSheet) {
    return res.json([]);
  }
  
  try {
    await photosSheet.loadHeaderRow();
    const rows = await photosSheet.getRows();
    
    const photos = [];
    for (const row of rows) {
      const userId = row.get('使用者ID') || '';
      const imageUrl = row.get('圖片URL') || '';
      
      if (userId === 'test_user') continue;
      if (!imageUrl || imageUrl === 'https://test.com/test.jpg') continue;
      
      photos.push({
        time: row.get('時間') || '',
        userId: userId,
        imageUrl: imageUrl,
        role: row.get('角色') || '未知角色',
        message: row.get('原始訊息') || ''
      });
    }
    
    photos.reverse();
    console.log(`✅ 讀取 ${photos.length} 張照片`);
    res.json(photos);
  } catch (error) {
    console.error('❌ 讀取失敗：', error.message);
    res.status(500).json({ error: '讀取失敗' });
  }
});

// 取得特定使用者的照片
app.get('/api/photos/user/:userId', async (req, res) => {
  if (!googleSheetReady || !photosSheet) {
    return res.json([]);
  }
  
  try {
    const targetUserId = req.params.userId;
    console.log(`🔍 查詢使用者：${targetUserId.substring(0, 8)}...`);
    
    await photosSheet.loadHeaderRow();
    const rows = await photosSheet.getRows();
    
    const photos = [];
    for (const row of rows) {
      const userId = row.get('使用者ID') || '';
      const imageUrl = row.get('圖片URL') || '';
      
      if (userId !== targetUserId) continue;
      if (!imageUrl || imageUrl === 'https://test.com/test.jpg') continue;
      
      photos.push({
        time: row.get('時間') || '',
        userId: userId,
        imageUrl: imageUrl,
        role: row.get('角色') || '未知角色',
        message: row.get('原始訊息') || ''
      });
    }
    
    photos.sort((a, b) => new Date(b.time) - new Date(a.time));
    console.log(`✅ 找到 ${photos.length} 張照片`);
    res.json(photos);
  } catch (error) {
    console.error('❌ 讀取失敗：', error.message);
    res.status(500).json({ error: '讀取失敗' });
  }
});

// 取得所有使用者列表
app.get('/api/users', async (req, res) => {
  if (!googleSheetReady || !photosSheet) {
    return res.json([]);
  }
  
  try {
    await photosSheet.loadHeaderRow();
    const rows = await photosSheet.getRows();
    
    const usersMap = new Map();
    for (const row of rows) {
      const userId = row.get('使用者ID') || '';
      const imageUrl = row.get('圖片URL') || '';
      const role = row.get('角色') || '';
      
      if (!userId || userId === 'test_user') continue;
      if (!imageUrl || imageUrl === 'https://test.com/test.jpg') continue;
      
      if (!usersMap.has(userId)) {
        usersMap.set(userId, {
          userId: userId,
          role: role,
          photoCount: 0,
          latestPhoto: imageUrl,
          latestTime: row.get('時間') || ''
        });
      }
      
      const user = usersMap.get(userId);
      user.photoCount++;
      
      const photoTime = row.get('時間') || '';
      if (photoTime > user.latestTime) {
        user.latestTime = photoTime;
        user.latestPhoto = imageUrl;
      }
    }
    
    const users = Array.from(usersMap.values());
    users.sort((a, b) => b.photoCount - a.photoCount);
    
    console.log(`✅ 讀取到 ${users.length} 位使用者`);
    res.json(users);
  } catch (error) {
    console.error('❌ 讀取使用者失敗：', error.message);
    res.json([]);
  }
});

// ========== 刪除照片 API ==========
// ========== 刪除照片 API（修復版：用圖片 URL 刪除） ==========
app.delete('/api/photo', async (req, res) => {
  if (!googleSheetReady || !photosSheet) {
    return res.status(503).json({ success: false, message: '服務未就緒' });
  }
  
  try {
    const imageUrl = req.query.imageUrl;
    const userId = req.query.userId;
    
    if (!userId || !imageUrl) {
      return res.status(400).json({ success: false, message: '缺少必要參數' });
    }
    
    console.log(`🔍 嘗試刪除照片 - 使用者: ${userId.substring(0,8)}...`);
    console.log(`🔍 圖片網址: ${imageUrl.substring(0, 50)}...`);
    
    // 確保工作表已載入
    await photosSheet.loadHeaderRow();
    const rows = await photosSheet.getRows();
    
    console.log(`📊 總共 ${rows.length} 筆資料，開始搜尋...`);
    
    let targetRow = null;
    let targetIndex = -1;
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowImageUrl = row.get('圖片URL');
      const rowUserId = row.get('使用者ID');
      
      // 比對圖片 URL 和使用者 ID（兩者都要相符）
      if (rowImageUrl === imageUrl && rowUserId === userId) {
        targetRow = row;
        targetIndex = i;
        console.log(`✅ 找到目標照片，位於第 ${i} 行`);
        break;
      }
    }
    
    if (!targetRow) {
      console.log(`❌ 找不到相符的照片`);
      return res.status(404).json({ success: false, message: '找不到該筆照片' });
    }
    
    // 執行刪除
    await targetRow.delete();
    console.log(`✅ 已刪除照片 (原行號: ${targetIndex})`);
    
    res.json({ success: true, message: '照片已刪除' });
    
  } catch (error) {
    console.error('❌ 刪除失敗：', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});
// ========== 照片牆網頁 ==========
app.get('/photowall', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'photowall.html'));
});

// ========== 測試端點 ==========
app.get('/test-google', async (req, res) => {
  try {
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const key = process.env.GOOGLE_PRIVATE_KEY;
    const sheetId = process.env.GOOGLE_SHEET_ID;
    
    if (!email || !key || !sheetId) {
      return res.json({ success: false, message: '缺少環境變數' });
    }
    
    const privateKey = key.replace(/\\n/g, '\n');
    const auth = new JWT({
      email: email,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    
    res.json({ success: true, message: `連線成功！試算表：${doc.title}` });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// ========== 啟動伺服器 ==========
const port = process.env.PORT || 3000;

app.listen(port, async () => {
  console.log(`🚀 伺服器啟動，port: ${port}`);
  console.log(`📋 角色：${Object.keys(ROLES).join(', ')}`);
  
  await initGoogleSheets();
  
  if (googleSheetReady) {
    console.log(`📸 照片牆：https://fbtestbot.onrender.com/photowall`);
  }
});
