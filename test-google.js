const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
require('dotenv').config();

async function testGoogleSheets() {
  console.log('═══════════════════════════════════════');
  console.log('🔍 開始測試 Google Sheets 連線');
  console.log('═══════════════════════════════════════\n');
  
  // 1. 檢查環境變數
  console.log('📋 檢查環境變數：');
  console.log(`   GOOGLE_SERVICE_ACCOUNT_EMAIL: ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? '✅ 已設定' : '❌ 未設定'}`);
  console.log(`   GOOGLE_PRIVATE_KEY: ${process.env.GOOGLE_PRIVATE_KEY ? `✅ 已設定 (長度: ${process.env.GOOGLE_PRIVATE_KEY.length})` : '❌ 未設定'}`);
  console.log(`   GOOGLE_SHEET_ID: ${process.env.GOOGLE_SHEET_ID ? '✅ 已設定' : '❌ 未設定'}`);
  console.log('');
  
  // 2. 檢查必要的變數是否存在
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
    console.error('❌ 缺少 GOOGLE_SERVICE_ACCOUNT_EMAIL');
    return;
  }
  if (!process.env.GOOGLE_PRIVATE_KEY) {
    console.error('❌ 缺少 GOOGLE_PRIVATE_KEY');
    return;
  }
  if (!process.env.GOOGLE_SHEET_ID) {
    console.error('❌ 缺少 GOOGLE_SHEET_ID');
    return;
  }
  
  try {
    // 3. 準備認證
    console.log('🔐 建立認證...');
    const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
    console.log(`   金鑰開頭: ${privateKey.substring(0, 30)}...`);
    
    const auth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    console.log('   ✅ 認證建立成功\n');
    
    // 4. 連線到試算表
    console.log('📊 連線到試算表...');
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
    await doc.loadInfo();
    console.log(`   ✅ 連線成功！`);
    console.log(`   試算表名稱: ${doc.title}`);
    console.log(`   試算表 ID: ${doc.spreadsheetId}\n`);
    
    // 5. 檢查或建立工作表
    console.log('📝 檢查「照片牆」工作表...');
    let sheet = doc.sheetsByTitle['照片牆'];
    
    if (!sheet) {
      console.log('   工作表不存在，正在建立...');
      sheet = await doc.addSheet({
        title: '照片牆',
        headerValues: ['時間', '使用者ID', '圖片URL', '角色', '原始訊息']
      });
      console.log('   ✅ 已建立「照片牆」工作表');
    } else {
      console.log('   ✅ 已找到「照片牆」工作表');
      console.log(`   現有資料筆數: ${sheet.rowCount - 1}`);
    }
    console.log('');
    
    // 6. 測試寫入一筆資料
    console.log('✍️ 測試寫入資料...');
    const testRow = await sheet.addRow({
      '時間': new Date().toISOString(),
      '使用者ID': 'test_user',
      '圖片URL': 'https://example.com/test.jpg',
      '角色': '測試角色',
      '原始訊息': '這是一筆測試資料'
    });
    console.log('   ✅ 寫入成功！');
    console.log(`   行索引: ${testRow.rowIndex}\n`);
    
    // 7. 測試讀取資料
    console.log('📖 測試讀取資料...');
    const rows = await sheet.getRows();
    console.log(`   ✅ 讀取成功！總共 ${rows.length} 筆資料`);
    console.log(`   最後一筆: ${rows[rows.length - 1]['原始訊息']}\n`);
    
    // 8. 清理測試資料（可選）
    console.log('🧹 清理測試資料...');
    const testRows = rows.filter(row => row['原始訊息'] === '這是一筆測試資料');
    for (const row of testRows) {
      await row.delete();
    }
    console.log('   ✅ 測試資料已刪除\n');
    
    // 9. 總結
    console.log('═══════════════════════════════════════');
    console.log('🎉 Google Sheets 完全正常！可以使用！');
    console.log('═══════════════════════════════════════');
    
  } catch (error) {
    console.error('\n❌ 測試失敗！');
    console.error('═══════════════════════════════════════');
    console.error(`錯誤訊息: ${error.message}`);
    console.error('═══════════════════════════════════════\n');
    
    // 提供解決方案建議
    console.log('🔧 可能的問題：');
    if (error.message.includes('permission')) {
      console.log('   ❌ 權限不足');
      console.log('   → 請確認試算表已共用給服務帳戶，並設定為「編輯者」');
      console.log(`   → 共用給: ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL}`);
    } else if (error.message.includes('invalid') || error.message.includes('JWT')) {
      console.log('   ❌ 金鑰格式錯誤');
      console.log('   → 請確認 GOOGLE_PRIVATE_KEY 格式正確');
      console.log('   → 必須包含 "-----BEGIN PRIVATE KEY-----" 和 "-----END PRIVATE KEY-----"');
    } else if (error.message.includes('not found')) {
      console.log('   ❌ 試算表不存在');
      console.log('   → 請確認 GOOGLE_SHEET_ID 是否正確');
    } else if (error.message.includes('API')) {
      console.log('   ❌ API 未啟用');
      console.log('   → 請在 Google Cloud Console 啟用 Google Sheets API');
    }
  }
}

// 執行測試
testGoogleSheets();
