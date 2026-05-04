const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// ========== Google Sheets 設定 ==========
let googleSheetReady = false;
let photosSheet = null;

async function initGoogleSheets() {
  try {
    console.log('🔧 開始初始化 Google Sheets...');
    
    const client_email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const private_key = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
    const sheetId = process.env.GOOGLE_SHEET_ID;
    
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
    
    console.log('📋 目前標題列：', currentHeaders);
    
    if (currentHeaders.length === 0 || currentHeaders[0] !== '時間') {
      console.log('🔄 重新設定標題列...');
      await photosSheet.clear();
      photosSheet.headerValues = expectedHeaders;
      await photosSheet.setHeaderRow(expectedHeaders);
      console.log('✅ 標題列已設定為：', expectedHeaders);
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

// ========== ImgBB 上傳 ==========
async function uploadToImgBB(imageBuffer) {
  const apiKey = process.env.IMGBB_API_KEY;
  if (!apiKey) {
    console.log('⚠️ 未設定 IMGBB_API_KEY');
    return null;
  }
  
  try {
    const base64Image = imageBuffer.toString('base64');
    const response = await axios.post(
      `https://api.imgbb.com/1/upload?key=${apiKey}`,
      new URLSearchParams({
        image: base64Image,
        expiration: 0
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 30000
      }
    );
    
    if (response.data && response.data.data && response.data.data.url) {
      console.log(`✅ ImgBB 上傳成功`);
      return response.data.data.url;
    }
    return null;
  } catch (error) {
    console.error('❌ ImgBB 上傳失敗：', error.message);
    return null;
  }
}

// ========== 儲存圖片到 Google Sheets ==========
async function savePhotoToSheet(userId, imageUrl, role, userMessage = '') {
  if (!googleSheetReady || !photosSheet) {
    console.log('⚠️ Google Sheets 未就緒');
    return false;
  }
  
  try {
    await photosSheet.loadHeaderRow();
    const headers = photosSheet.headerValues;
    console.log('📋 目前工作表欄位：', headers);
    
    const expectedHeaders = ['時間', '使用者ID', '圖片URL', '角色', '原始訊息'];
    let needReset = false;
    
    if (headers.length === 0 || headers[0] !== '時間') {
      needReset = true;
    }
    
    if (needReset) {
      console.log('🔄 重新設定工作表欄位...');
      await photosSheet.clear();
      photosSheet.headerValues = expectedHeaders;
      await photosSheet.setHeaderRow(expectedHeaders);
      console.log('✅ 欄位已重新設定為：', expectedHeaders);
    }
    
    const rowData = {
      '時間': new Date().toISOString(),
      '使用者ID': userId,
      '圖片URL': imageUrl,
      '角色': role,
      '原始訊息': userMessage || ''
    };
    
    console.log('📝 寫入資料：', rowData);
    await photosSheet.addRow(rowData);
    console.log(`✅ 照片已儲存！`);
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
        
        const imageUrl = await uploadToImgBB(imageResponse.data);
        
        if (imageUrl) {
          await savePhotoToSheet(userId, imageUrl, role, userMessage || '圖片分享');
          await replyToUser(replyToken, `📸 照片已上傳到照片牆！\n🔗 ${imageUrl}\n\n👉 照片牆：https://fbtestbot.onrender.com/photowall`);
          console.log(`   ✅ 完成！`);
        } else {
          await replyToUser(replyToken, `❌ 圖片上傳失敗，請稍後再試`);
        }
      }
      // 處理文字
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
app.get('/api/photos', async (req, res) => {
  if (!googleSheetReady || !photosSheet) {
    console.log('⚠️ Google Sheets 未就緒');
    return res.json([]);
  }
  
  try {
    await photosSheet.loadHeaderRow();
    const rows = await photosSheet.getRows();
    
    console.log(`📸 讀取到 ${rows.length} 筆資料`);
    
    const photos = [];
    for (const row of rows) {
      const time = row.get('時間') || '';
      const userId = row.get('使用者ID') || '匿名';
      const imageUrl = row.get('圖片URL') || '';
      const role = row.get('角色') || '未知角色';
      const message = row.get('原始訊息') || '';
      
      if (imageUrl) {
        photos.push({
          time: time,
          userId: userId,
          imageUrl: imageUrl,
          role: role,
          message: message
        });
      }
    }
    
    photos.reverse();
    console.log(`✅ 成功讀取 ${photos.length} 張照片`);
    res.json(photos);
  } catch (error) {
    console.error('❌ 讀取失敗：', error.message);
    res.status(500).json({ error: '讀取失敗', detail: error.message });
  }
});

// 照片牆網頁
app.get('/photowall', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'photowall.html'));
});

// 健康檢查
app.get('/', (req, res) => {
  res.status(200).send('OK');
});

// 測試端點
app.get('/test-google', async (req, res) => {
  console.log('🧪 開始測試 Google Sheets...');
  
  const results = {
    step1_checkEnv: { status: 'pending', message: '' },
    step2_auth: { status: 'pending', message: '' },
    step3_connect: { status: 'pending', message: '' },
    step4_write: { status: 'pending', message: '' }
  };
  
  try {
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const key = process.env.GOOGLE_PRIVATE_KEY;
    const sheetId = process.env.GOOGLE_SHEET_ID;
    
    results.step1_checkEnv.message = `EMAIL: ${email ? '✅' : '❌'} | KEY: ${key ? `✅ (長度: ${key.length})` : '❌'} | SHEET_ID: ${sheetId ? '✅' : '❌'}`;
    results.step1_checkEnv.status = (email && key && sheetId) ? 'success' : 'failed';
    
    if (!email || !key || !sheetId) {
      throw new Error('缺少必要的環境變數');
    }
    
    const privateKey = key.replace(/\\n/g, '\n');
    const auth = new JWT({
      email: email,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    results.step2_auth.status = 'success';
    results.step2_auth.message = '認證建立成功';
    
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    results.step3_connect.status = 'success';
    results.step3_connect.message = `連線成功！試算表：${doc.title}`;
    
    let sheet = doc.sheetsByTitle['照片牆'];
    if (!sheet) {
      sheet = await doc.addSheet({ 
        title: '照片牆', 
        headerValues: ['時間', '使用者ID', '圖片URL', '角色', '原始訊息'] 
      });
    }
    
    await sheet.addRow({
      '時間': new Date().toISOString(),
      '使用者ID': 'test_user',
      '圖片URL': 'https://test.com/test.jpg',
      '角色': '測試',
      '原始訊息': '測試連線'
    });
    results.step4_write.status = 'success';
    results.step4_write.message = '寫入測試成功！';
    
    res.json({
      success: true,
      message: '🎉 Google Sheets 完全正常！',
      results: results
    });
    
  } catch (error) {
    res.json({
      success: false,
      message: `❌ 測試失敗：${error.message}`,
      results: results
    });
  }
});

// 啟動伺服器
const port = process.env.PORT || 3000;

app.listen(port, async () => {
  console.log(`🚀 伺服器啟動，port: ${port}`);
  console.log(`📋 角色：${Object.keys(ROLES).join(', ')}`);
  
  await initGoogleSheets();
  
  if (googleSheetReady) {
    console.log(`📸 照片牆：https://fbtestbot.onrender.com/photowall`);
  }
});
