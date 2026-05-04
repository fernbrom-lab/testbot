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
        .stats {
            background: white;
            border-radius: 15px;
            padding: 15px;
            margin-bottom: 30px;
            text-align: center;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        .stats span { font-size: 1.5em; font-weight: bold; color: #667eea; }
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
        .photo-image { width: 100%; height: 300px; object-fit: cover; background: #f0f0f0; }
        .photo-info { padding: 15px; }
        .photo-user { font-weight: bold; color: #333; margin-bottom: 5px; display: flex; align-items: center; gap: 5px; }
        .photo-user::before { content: "👤"; }
        .photo-role { display: inline-block; background: linear-gradient(135deg, #667eea, #764ba2); color: white; padding: 4px 10px; border-radius: 12px; font-size: 0.85em; margin: 8px 0; }
        .photo-message { color: #666; font-size: 0.9em; margin-top: 8px; line-height: 1.4; }
        .photo-time { color: #999; font-size: 0.8em; margin-top: 10px; display: flex; align-items: center; gap: 5px; }
        .photo-time::before { content: "🕒"; }
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
            animation: fadeIn 0.3s;
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
            transition: transform 0.2s;
        }
        .refresh-btn:hover { transform: scale(1.05); }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        @media (max-width: 768px) {
            .photo-grid { grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 15px; }
            .header h1 { font-size: 2em; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📸 回憶照片牆</h1>
            <p>和AI機器人的美好時光</p>
        </div>
        <div class="stats" id="stats">載入中...</div>
        <div class="photo-grid" id="photoGrid"><div class="loading">📷 載入照片中...</div></div>
    </div>
    <button class="refresh-btn" onclick="loadPhotos()">🔄 重新整理</button>
    <div id="modal" class="modal"><span class="close">&times;</span><div class="modal-content"><img class="modal-image" id="modalImage"></div></div>
    <script>
        let modal = document.getElementById('modal');
        let modalImg = document.getElementById('modalImage');
        let span = document.getElementsByClassName('close')[0];
        
        span.onclick = function() { modal.style.display = "none"; }
        modal.onclick = function(e) { if(e.target === modal) modal.style.display = "none"; };
        
        function formatTime(isoString) {
            if (!isoString) return '未知時間';
            const date = new Date(isoString);
            return date.toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        }
        
        function truncateUserId(userId) {
            if (!userId) return '匿名使用者';
            if (userId.length > 15) return userId.substring(0, 10) + '...';
            return userId;
        }
        
        async function loadPhotos() {
            const grid = document.getElementById('photoGrid');
            const statsDiv = document.getElementById('stats');
            
            grid.innerHTML = '<div class="loading">📷 載入照片中...</div>';
            
            try {
                const response = await fetch('/api/photos');
                const photos = await response.json();
                
                if (!photos || photos.length === 0) {
                    grid.innerHTML = '<div class="loading">📸 暫無照片，快上傳第一張吧！</div>';
                    statsDiv.innerHTML = '📸 目前共有 <span>0</span> 張照片';
                    return;
                }
                
                statsDiv.innerHTML = `📸 目前共有 <span>${photos.length}</span> 張珍貴回憶`;
                
                grid.innerHTML = '';
                photos.forEach(photo => {
                    const card = document.createElement('div');
                    card.className = 'photo-card';
                    card.onclick = () => { modal.style.display = "block"; modalImg.src = photo.imageUrl; };
                    
                    card.innerHTML = `
                        <img class="photo-image" src="${photo.imageUrl}" alt="回憶照片" loading="lazy" onerror="this.src='https://via.placeholder.com/300?text=圖片+載入+失敗'">
                        <div class="photo-info">
                            <div class="photo-user">${truncateUserId(photo.userId)}</div>
                            <div class="photo-role">🎭 ${photo.role || '未知角色'}</div>
                            ${photo.message ? `<div class="photo-message">💬 ${photo.message.substring(0, 50)}${photo.message.length > 50 ? '...' : ''}</div>` : ''}
                            <div class="photo-time">${formatTime(photo.time)}</div>
                        </div>
                    `;
                    grid.appendChild(card);
                });
            } catch(error) {
                console.error('載入失敗：', error);
                grid.innerHTML = '<div class="loading">❌ 載入失敗，請稍後再試</div>';
            }
        }
        
        loadPhotos();
        setInterval(loadPhotos, 30000);
    </script>
</body>
</html>
