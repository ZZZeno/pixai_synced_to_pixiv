// PixAI → Pixiv Publisher - Popup (Queue Manager)

const app = document.getElementById('app');

async function render() {
  const res = await chrome.runtime.sendMessage({ action: 'getQueue' });
  const queue = res?.data || [];

  if (queue.length === 0) {
    app.innerHTML = `
      <div class="header">
        <h2>🎨 PixAI → Pixiv</h2>
      </div>
      <p class="subtitle">作品をPixivに一括投稿</p>
      <div class="empty">
        <div class="empty-icon">📭</div>
        <div class="empty-text">投稿キューは空です</div>
        <div class="empty-sub">
          PixAIの作品ページで右下の<br>
          「Pixivキューに追加」ボタンをクリック
        </div>
      </div>
      <div class="help">
        <strong>使い方：</strong><br>
        1️⃣ PixAIで作品を開き、＋でキューに追加<br>
        2️⃣ 複数作品を追加可能（複数枚投稿）<br>
        3️⃣ ここで並び替えて投稿をクリック<br>
        4️⃣ Pixiv投稿ページに自動入力されます
      </div>
    `;
    return;
  }

  const itemsHtml = queue.map((item, i) => {
    const thumb = item.imageUrls?.[1] || item.imageUrls?.[0] || '';
    const title = item.title || item.prompt?.substring(0, 30) || '(untitled)';
    const dims = item.imageWidth && item.imageHeight ? `${item.imageWidth}×${item.imageHeight}` : '';
    const nsfw = item.isNsfw ? '<span class="badge-nsfw">R-18</span>' : '';

    return `
      <div class="queue-item" draggable="true" data-index="${i}" data-id="${esc(item.artworkId)}">
        <span class="queue-item-order">${i + 1}</span>
        ${thumb ? `<img class="queue-item-thumb" src="${esc(thumb)}" alt="">` : '<div class="queue-item-thumb"></div>'}
        <div class="queue-item-info">
          <div class="queue-item-title">${esc(title)}${nsfw}</div>
          <div class="queue-item-meta">${dims} · ${item.tags?.slice(0, 3).join(', ') || 'no tags'}</div>
        </div>
        <button class="queue-item-remove" data-id="${esc(item.artworkId)}" title="削除">×</button>
      </div>
    `;
  }).join('');

  app.innerHTML = `
    <div class="header">
      <h2>🎨 PixAI → Pixiv</h2>
      <span class="queue-count">${queue.length} 枚</span>
    </div>
    <p class="subtitle">ドラッグで並び替え、×で削除</p>
    <div class="queue-list" id="queue-list">${itemsHtml}</div>
    <div class="actions">
      <button class="btn btn-primary" id="publish-btn">📤 Pixivに投稿</button>
      <button class="btn btn-danger" id="clear-btn">クリア</button>
    </div>
    <div class="help">
      <strong>ヒント：</strong> 複数枚は1つの作品として投稿されます。1枚目が表紙になります。
    </div>
  `;

  // Bind events
  document.getElementById('publish-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openPixivCreate' });
    window.close();
  });

  document.getElementById('clear-btn').addEventListener('click', async () => {
    if (confirm(`キュー内の ${queue.length} 枚の作品をクリアしますか？`)) {
      await chrome.runtime.sendMessage({ action: 'clearQueue' });
      render();
    }
  });

  // Remove buttons
  document.querySelectorAll('.queue-item-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      await chrome.runtime.sendMessage({ action: 'removeFromQueue', artworkId: id });
      render();
    });
  });

  // Drag & drop reorder
  initDragDrop(queue);
}

function initDragDrop(queue) {
  const list = document.getElementById('queue-list');
  if (!list) return;

  let dragIdx = null;

  list.querySelectorAll('.queue-item').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      dragIdx = parseInt(item.dataset.index);
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      dragIdx = null;
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      const dropIdx = parseInt(item.dataset.index);
      if (dragIdx === null || dragIdx === dropIdx) return;

      // Reorder
      const newQueue = [...queue];
      const [moved] = newQueue.splice(dragIdx, 1);
      newQueue.splice(dropIdx, 0, moved);

      await chrome.runtime.sendMessage({ action: 'reorderQueue', queue: newQueue });
      render();
    });
  });
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

render();
