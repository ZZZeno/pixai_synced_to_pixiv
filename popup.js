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
      <p class="subtitle">批量同步作品到 Pixiv</p>
      <div class="empty">
        <div class="empty-icon">📭</div>
        <div class="empty-text">发布队列为空</div>
        <div class="empty-sub">
          打开 PixAI 作品页面，点击右下角<br>
          「添加到 Pixiv 队列」按钮
        </div>
      </div>
      <div class="help">
        <strong>使用流程：</strong><br>
        1️⃣ 在 PixAI 浏览作品，点击 ＋ 添加到队列<br>
        2️⃣ 可添加多个作品（多图投稿）<br>
        3️⃣ 在这里调整顺序，点击发布<br>
        4️⃣ Pixiv 发布页自动填入所有信息
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
        <button class="queue-item-remove" data-id="${esc(item.artworkId)}" title="移除">×</button>
      </div>
    `;
  }).join('');

  app.innerHTML = `
    <div class="header">
      <h2>🎨 PixAI → Pixiv</h2>
      <span class="queue-count">${queue.length} 张</span>
    </div>
    <p class="subtitle">拖拽调整顺序，点击 × 移除</p>
    <div class="queue-list" id="queue-list">${itemsHtml}</div>
    <div class="actions">
      <button class="btn btn-primary" id="publish-btn">📤 发布到 Pixiv</button>
      <button class="btn btn-danger" id="clear-btn">清空</button>
    </div>
    <div class="help">
      <strong>提示：</strong> 多图将作为一个多页作品发布。第一张图为封面。
    </div>
  `;

  // Bind events
  document.getElementById('publish-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'openPixivCreate' });
    window.close();
  });

  document.getElementById('clear-btn').addEventListener('click', async () => {
    if (confirm(`确定清空队列中的 ${queue.length} 张作品？`)) {
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
