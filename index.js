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
let googleSheetDoc = null;
let googleSheetReady = false;
let photosSheet = null;
let settingsSheet = null;
let messagesSheet = null;

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
    googleSheetDoc = doc;
    
    // 照片牆工作表
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
    
    // 使用者設定工作表
    settingsSheet = doc.sheetsByTitle['使用者設定'];
    if (!settingsSheet) {
      settingsSheet = await doc.addSheet({ title: '使用者設定', headerValues: ['使用者ID', '顯示名稱', '頭像URL', '自我介紹', 'IG帳號', 'FB帳號', '更新時間'] });
      console.log('✅ 已建立「使用者設定」工作表');
    } else {
      // 確保有新的欄位
      await settingsSheet.loadHeaderRow();
      const currentHeaders2 = settingsSheet.headerValues;
      if (!currentHeaders2.includes('自我介紹')) {
        settingsSheet.headerValues = [...currentHeaders2, '自我介紹', 'IG帳號', 'FB帳號'];
        await settingsSheet.setHeaderRow(settingsSheet.headerValues);
      }
    }
    
    // 留言板工作表
    messagesSheet = doc.sheetsByTitle['留言板'];
    if (!messagesSheet) {
      messagesSheet = await doc.addSheet({ title: '留言板', headerValues: ['留言ID', '目標使用者ID', '留言者ID', '留言內容', '時間', '按讚數'] });
      console.log('✅ 已建立「留言板」工作表');
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
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          { folder: 'linebot_photos', timeout: 30000 },
          (error, uploadResult) => {
            if (error) return reject(error);
            if (uploadResult && uploadResult.secure_url) resolve(uploadResult);
            else reject(new Error('Cloudinary 未回傳圖片網址'));
          }
        );
        uploadStream.end(imageBuffer);
      });
      console.log(`✅ Cloudinary 上傳成功 (嘗試 ${attempt} 次)`);
      return result.secure_url;
    } catch (error) {
      console.error(`❌ Cloudinary 上傳失敗 (嘗試 ${attempt}/${retries}):`, error.message);
      if (attempt === retries) return null;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return null;
}

// ========== 儲存圖片到 Google Sheets ==========
async function savePhotoToSheet(userId, imageUrl, role, userMessage = '') {
  if (!googleSheetReady || !photosSheet) return false;
  try {
    await photosSheet.addRow({
      '時間': new Date().toISOString(),
      '使用者ID': userId,
      '圖片URL': imageUrl,
      '角色': role,
      '原始訊息': userMessage || ''
    });
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
  if (!userConversations[userId]) userConversations[userId] = [];
  return userConversations[userId];
}
function addToHistory(userId, role, content) {
  const history = getConversationHistory(userId);
  history.push({ role, content });
  while (history.length > MAX_HISTORY_MESSAGES) history.shift();
}
setInterval(() => {
  const users = Object.keys(userConversations);
  if (users.length) {
    console.log(`🧹 清理 ${users.length} 位使用者的對話記錄`);
    for (const userId of users) delete userConversations[userId];
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
  const messages = [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: userMessage }];
  try {
    const response = await axios.post('https://api.deepseek.com/chat/completions', {
      model: 'deepseek-chat',
      messages,
      temperature: 0.8,
      max_tokens: 1000
    }, {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` },
      timeout: 15000
    });
    const reply = response.data.choices[0].message.content;
    addToHistory(userId, 'user', userMessage);
    addToHistory(userId, 'assistant', reply);
    return reply;
  } catch (error) {
    console.error('❌ DeepSeek 錯誤：', error.response?.data || error.message);
    return '抱歉，AI 暫時無法回應，請稍後再試。';
  }
}

// ========== 回覆輔助函數 ==========
async function replyToUser(replyToken, message) {
  if (!replyToken) return;
  try {
    await axios.post('https://api.line.me/v2/bot/message/reply', {
      replyToken,
      messages: [{ type: 'text', text: message }]
    }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_ACCESS_TOKEN}` } });
  } catch (error) {
    console.error('回覆失敗：', error.response?.data || error.message);
  }
}

// ========== 根目錄轉址 ==========
app.get('/', (req, res) => res.redirect('/photowall'));

// ========== 個人相簿專屬頁面 ==========
app.get('/user/:userId', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>我的相簿</title><script>localStorage.setItem('userId','${req.params.userId}');window.location.href='/photowall';</script></head><body>載入中...</body></html>`);
});

// ========== LINE Webhook ==========
app.post('/webhook/:role', async (req, res) => {
  res.status(200).send('OK');
  const role = req.params.role;
  const roleConfig = ROLES[role];
  if (!roleConfig) return;
  const events = req.body.events;
  if (!events) return;
  for (const event of events) {
    const replyToken = event.replyToken;
    const userMessage = event.message?.text;
    const userId = event.source?.userId;
    const messageType = event.message?.type;
    if (!userId) continue;
    console.log(`\n🎭 [${new Date().toLocaleString()}] 角色「${roleConfig.name}」👤 ${userId.substring(0,8)}...`);
    try {
      if (messageType === 'image') {
        const imageResponse = await axios.get(`https://api-data.line.me/v2/bot/message/${event.message.id}/content`, {
          headers: { 'Authorization': `Bearer ${LINE_ACCESS_TOKEN}` },
          responseType: 'arraybuffer',
          timeout: 30000
        });
        console.log(`   ✅ 下載完成：${(imageResponse.data.length/1024).toFixed(2)} KB`);
        const imageUrl = await uploadToCloudinary(imageResponse.data);
        if (imageUrl) {
          await savePhotoToSheet(userId, imageUrl, roleConfig.name, userMessage || '圖片分享');
          await replyToUser(replyToken, `📸 照片已上傳成功！\n\n🏠 全部照片牆：\nhttps://fbtestbot.onrender.com/photowall\n\n👤 你的個人相簿（可刪除照片）：\nhttps://fbtestbot.onrender.com/user/${userId}`);
        } else {
          await replyToUser(replyToken, `❌ 圖片上傳失敗，請稍後再試`);
        }
      } else if (messageType === 'text' && userMessage) {
        const aiReply = await callDeepSeekWithMemory(userId, userMessage, roleConfig.systemPrompt);
        await replyToUser(replyToken, aiReply);
      } else if (replyToken) {
        await replyToUser(replyToken, roleConfig.welcome);
      }
    } catch (error) {
      console.error(`   ❌ 錯誤：`, error.message);
      if (replyToken) await replyToUser(replyToken, `❌ 處理失敗：${error.message}`);
    }
  }
});

// ========== 照片牆 API ==========
// 取得全部照片
app.get('/api/photos', async (req, res) => {
  if (!googleSheetReady || !photosSheet) return res.json([]);
  try {
    const rows = await photosSheet.getRows();
    const photos = [];
    for (const row of rows) {
      const userId = row.get('使用者ID') || '';
      const imageUrl = row.get('圖片URL') || '';
      if (userId === 'test_user') continue;
      if (!imageUrl || imageUrl === 'https://test.com/test.jpg') continue;
      photos.push({
        time: row.get('時間') || '',
        userId,
        imageUrl,
        role: row.get('角色') || '未知角色',
        message: row.get('原始訊息') || ''
      });
    }
    photos.reverse();
    res.json(photos);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// 取得特定使用者的照片
app.get('/api/photos/user/:userId', async (req, res) => {
  if (!googleSheetReady || !photosSheet) return res.json([]);
  try {
    const targetUserId = req.params.userId;
    const rows = await photosSheet.getRows();
    const photos = [];
    for (const row of rows) {
      const userId = row.get('使用者ID') || '';
      const imageUrl = row.get('圖片URL') || '';
      if (userId !== targetUserId) continue;
      if (!imageUrl || imageUrl === 'https://test.com/test.jpg') continue;
      photos.push({
        time: row.get('時間') || '',
        userId,
        imageUrl,
        role: row.get('角色') || '未知角色',
        message: row.get('原始訊息') || ''
      });
    }
    photos.sort((a,b) => new Date(b.time) - new Date(a.time));
    res.json(photos);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// 取得所有使用者列表
app.get('/api/users', async (req, res) => {
  if (!googleSheetReady || !photosSheet) return res.json([]);
  try {
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
          userId,
          role,
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
    let settingsMap = new Map();
    if (settingsSheet) {
      const settingsRows = await settingsSheet.getRows();
      for (const row of settingsRows) {
        const uid = row.get('使用者ID');
        if (uid) {
          settingsMap.set(uid, {
            displayName: row.get('顯示名稱') || '',
            avatarUrl: row.get('頭像URL') || '',
            bio: row.get('自我介紹') || '',
            ig: row.get('IG帳號') || '',
            fb: row.get('FB帳號') || ''
          });
        }
      }
    }
    const users = Array.from(usersMap.values()).map(user => {
      const setting = settingsMap.get(user.userId) || {};
      return {
        userId: user.userId,
        role: user.role,
        photoCount: user.photoCount,
        latestPhoto: setting.avatarUrl || user.latestPhoto,
        displayName: setting.displayName || null,
        bio: setting.bio || '',
        ig: setting.ig || '',
        fb: setting.fb || '',
        latestTime: user.latestTime
      };
    });
    users.sort((a,b) => b.photoCount - a.photoCount);
    res.json(users);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// 儲存顯示名稱
app.post('/api/user/displayname', async (req, res) => {
  if (!googleSheetReady || !settingsSheet) return res.status(503).json({ success: false });
  try {
    const { userId, displayName } = req.body;
    if (!userId) return res.status(400).json({ success: false });
    const rows = await settingsSheet.getRows();
    let userRow = rows.find(r => r.get('使用者ID') === userId);
    if (userRow) {
      userRow.set('顯示名稱', displayName || '');
      userRow.set('更新時間', new Date().toISOString());
      await userRow.save();
    } else {
      await settingsSheet.addRow({
        '使用者ID': userId,
        '顯示名稱': displayName || '',
        '頭像URL': '',
        '更新時間': new Date().toISOString()
      });
    }
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// 儲存頭像 URL
app.post('/api/user/avatar', async (req, res) => {
  if (!googleSheetReady || !settingsSheet) return res.status(503).json({ success: false });
  try {
    const { userId, avatarUrl } = req.body;
    if (!userId) return res.status(400).json({ success: false });
    const rows = await settingsSheet.getRows();
    let userRow = rows.find(r => r.get('使用者ID') === userId);
    if (userRow) {
      userRow.set('頭像URL', avatarUrl || '');
      userRow.set('更新時間', new Date().toISOString());
      await userRow.save();
    } else {
      await settingsSheet.addRow({
        '使用者ID': userId,
        '顯示名稱': '',
        '頭像URL': avatarUrl || '',
        '更新時間': new Date().toISOString()
      });
    }
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// 刪除照片
app.delete('/api/photo', async (req, res) => {
  if (!googleSheetReady || !photosSheet) return res.status(503).json({ success: false });
  try {
    const { imageUrl, userId } = req.query;
    if (!userId || !imageUrl) return res.status(400).json({ success: false });
    const rows = await photosSheet.getRows();
    let targetRow = null;
    for (const row of rows) {
      if (row.get('圖片URL') === imageUrl && row.get('使用者ID') === userId) {
        targetRow = row;
        break;
      }
    }
    if (!targetRow) return res.status(404).json({ success: false, message: '找不到該筆照片' });
    await targetRow.delete();
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ========== 使用者個人資料 API ==========
app.get('/api/user/profile/:userId', async (req, res) => {
  if (!googleSheetReady || !settingsSheet) return res.status(503).json({ error: '服務未就緒' });
  try {
    const targetUserId = req.params.userId;
    const rows = await settingsSheet.getRows();
    const userRow = rows.find(row => row.get('使用者ID') === targetUserId);
    
    if (!userRow) {
      return res.json({ 
        userId: targetUserId, 
        displayName: null, 
        avatarUrl: null, 
        bio: '', 
        ig: '', 
        fb: '' 
      });
    }
    
    res.json({
      userId: targetUserId,
      displayName: userRow.get('顯示名稱') || null,
      avatarUrl: userRow.get('頭像URL') || null,
      bio: userRow.get('自我介紹') || '',
      ig: userRow.get('IG帳號') || '',
      fb: userRow.get('FB帳號') || ''
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/profile', async (req, res) => {
  if (!googleSheetReady || !settingsSheet) return res.status(503).json({ error: '服務未就緒' });
  try {
    const { userId, bio, ig, fb } = req.body;
    if (!userId) return res.status(400).json({ error: '缺少 userId' });
    
    const rows = await settingsSheet.getRows();
    let userRow = rows.find(row => row.get('使用者ID') === userId);
    
    if (userRow) {
      if (bio !== undefined) userRow.set('自我介紹', bio);
      if (ig !== undefined) userRow.set('IG帳號', ig);
      if (fb !== undefined) userRow.set('FB帳號', fb);
      userRow.set('更新時間', new Date().toISOString());
      await userRow.save();
    } else {
      await settingsSheet.addRow({
        '使用者ID': userId,
        '顯示名稱': '',
        '頭像URL': '',
        '自我介紹': bio || '',
        'IG帳號': ig || '',
        'FB帳號': fb || '',
        '更新時間': new Date().toISOString()
      });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== 留言板 API ==========
app.get('/api/messages/:userId', async (req, res) => {
  if (!googleSheetReady || !messagesSheet) return res.status(503).json({ error: '服務未就緒' });
  try {
    const targetUserId = req.params.userId;
    const rows = await messagesSheet.getRows();
    const messages = [];
    for (const row of rows) {
      if (row.get('目標使用者ID') === targetUserId) {
        messages.push({
          id: row.get('留言ID'),
          senderId: row.get('留言者ID'),
          content: row.get('留言內容'),
          time: row.get('時間'),
          likes: parseInt(row.get('按讚數')) || 0
        });
      }
    }
    messages.reverse();
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/messages', async (req, res) => {
  if (!googleSheetReady || !messagesSheet) return res.status(503).json({ error: '服務未就緒' });
  try {
    const { targetUserId, senderId, content } = req.body;
    if (!targetUserId || !senderId || !content) {
      return res.status(400).json({ error: '缺少必要參數' });
    }
    
    const rows = await messagesSheet.getRows();
    const newId = rows.length + 1;
    
    await messagesSheet.addRow({
      '留言ID': newId,
      '目標使用者ID': targetUserId,
      '留言者ID': senderId,
      '留言內容': content,
      '時間': new Date().toISOString(),
      '按讚數': 0
    });
    
    res.json({ success: true, messageId: newId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// ========== 留言按讚 API ==========
app.post('/api/messages/like', async (req, res) => {
    if (!googleSheetReady || !messagesSheet) return res.status(503).json({ error: '服務未就緒' });
    try {
        const { messageId, userId } = req.body;
        if (!messageId) return res.status(400).json({ error: '缺少留言ID' });
        
        const rows = await messagesSheet.getRows();
        const targetRow = rows.find(row => row.get('留言ID') == messageId);
        
        if (!targetRow) return res.status(404).json({ error: '留言不存在' });
        
        const currentLikes = parseInt(targetRow.get('按讚數')) || 0;
        targetRow.set('按讚數', currentLikes + 1);
        await targetRow.save();
        
        res.json({ success: true, likes: currentLikes + 1 });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== 刪除留言 API ==========
app.delete('/api/messages/:messageId', async (req, res) => {
    if (!googleSheetReady || !messagesSheet) return res.status(503).json({ error: '服務未就緒' });
    try {
        const messageId = req.params.messageId;
        const userId = req.query.userId;
        
        const rows = await messagesSheet.getRows();
        const targetRow = rows.find(row => row.get('留言ID') == messageId);
        
        if (!targetRow) return res.status(404).json({ error: '留言不存在' });
        
        await targetRow.delete();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========== 新增回覆留言 API ==========
app.post('/api/messages/reply', async (req, res) => {
    if (!googleSheetReady || !messagesSheet) return res.status(503).json({ error: '服務未就緒' });
    try {
        const { parentMessageId, targetUserId, senderId, content } = req.body;
        if (!parentMessageId || !content) return res.status(400).json({ error: '缺少必要參數' });
        
        const rows = await messagesSheet.getRows();
        const newId = rows.length + 1;
        
        await messagesSheet.addRow({
            '留言ID': newId,
            '目標使用者ID': targetUserId,
            '留言者ID': senderId,
            '留言內容': `🔁 回覆 #${parentMessageId}: ${content}`,
            '時間': new Date().toISOString(),
            '按讚數': 0,
            '父留言ID': parentMessageId
        });
        
        res.json({ success: true, messageId: newId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ========== 照片牆網頁 ==========
app.get('/photowall', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'photowall.html'));
});

// 健康檢查
app.get('/health', (req, res) => res.status(200).send('OK'));

// 啟動伺服器
const port = process.env.PORT || 3000;
app.listen(port, async () => {
  console.log(`🚀 伺服器啟動，port: ${port}`);
  console.log(`📋 角色：${Object.keys(ROLES).join(', ')}`);
  await initGoogleSheets();
  if (googleSheetReady) console.log(`📸 照片牆：https://fbtestbot.onrender.com/photowall`);
});
