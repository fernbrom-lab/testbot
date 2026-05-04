const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// 從環境變數讀取設定
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

class GoogleSheetsManager {
  constructor() {
    this.doc = null;
    this.sheet = null;
  }

  async initialize() {
    try {
      const auth = new JWT({
        email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: GOOGLE_PRIVATE_KEY,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });

      this.doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, auth);
      await this.doc.loadInfo();
      
      // 取得或建立工作表
      this.sheet = this.doc.sheetsByTitle['照片牆'];
      if (!this.sheet) {
        this.sheet = await this.doc.addSheet({ title: '照片牆', headerValues: ['時間', '使用者ID', '圖片URL', '角色', '原始訊息'] });
      }
      
      console.log('✅ Google Sheets 連線成功');
      return true;
    } catch (error) {
      console.error('❌ Google Sheets 連線失敗：', error.message);
      return false;
    }
  }

  async addPhoto(userId, imageUrl, role, userMessage = '') {
    try {
      await this.sheet.addRow({
        '時間': new Date().toISOString(),
        '使用者ID': userId,
        '圖片URL': imageUrl,
        '角色': role,
        '原始訊息': userMessage || ''
      });
      console.log(`📸 照片已儲存到 Google Sheets - 使用者：${userId}`);
      return true;
    } catch (error) {
      console.error('❌ 儲存照片到 Google Sheets 失敗：', error.message);
      return false;
    }
  }

  async getAllPhotos(limit = 100) {
    try {
      const rows = await this.sheet.getRows();
      const photos = rows.map(row => ({
        time: row['時間'],
        userId: row['使用者ID'],
        imageUrl: row['圖片URL'],
        role: row['角色'],
        message: row['原始訊息']
      })).reverse(); // 最新的在前面
      
      return photos.slice(0, limit);
    } catch (error) {
      console.error('❌ 讀取照片失敗：', error.message);
      return [];
    }
  }
}

module.exports = GoogleSheetsManager;
