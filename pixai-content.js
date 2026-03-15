// PixAI → Pixiv Publisher - PixAI Content Script
// Runs on pixai.art/artwork/* pages
// Adds artwork to the publish queue via GraphQL API

(function () {
  'use strict';

  // Top-level debug - this should ALWAYS print if the script is injected
  console.log('[PixAI→Pixiv] Content script LOADED on:', window.location.href);
  console.log('[PixAI→Pixiv] Pathname:', window.location.pathname);

  const BUTTON_ID = 'pixai-to-pixiv-btn';
  const PERSISTED_QUERY_HASH = '4f22907317f62a16165260fb32306f98adf084f10d18eac3ed9bc9c2ff6ed2fe';

  // ── API Data Extraction ─────────────────────────────────────────

  async function fetchArtworkData(artworkId) {
    const variables = JSON.stringify({ id: artworkId });
    const extensions = JSON.stringify({
      clientLibrary: { name: '@apollo/client', version: '4.1.4' },
      persistedQuery: { version: 1, sha256Hash: PERSISTED_QUERY_HASH }
    });

    const udToken = getCookie('_udt') || '';
    const params = new URLSearchParams({
      operation: 'getArtworkWithTaskDetail',
      operationName: 'getArtworkWithTaskDetail',
      variables,
      extensions,
    });
    if (udToken) params.set('u3t', udToken);

    const url = `https://api.pixai.art/graphql?${params.toString()}`;
    const authToken = getCookie('user_token') || '';

    const headers = {
      'accept': 'application/graphql-response+json,application/json;q=0.9',
      'content-type': 'application/json',
    };
    if (authToken) headers['authorization'] = `Bearer ${authToken}`;

    const res = await fetch(url, { headers, credentials: 'include' });
    const json = await res.json();

    if (!json.data?.artwork) {
      throw new Error('API 返回空数据，请确认作品存在且可访问');
    }

    return parseArtworkResponse(json.data.artwork);
  }

  function parseArtworkResponse(artwork) {
    const imageUrls = [];
    if (artwork.media?.urls) {
      const publicUrl = artwork.media.urls.find(u => u.variant === 'PUBLIC');
      const thumbUrl = artwork.media.urls.find(u => u.variant === 'THUMBNAIL');
      if (publicUrl) imageUrls.push(publicUrl.url);
      if (thumbUrl) imageUrls.push(thumbUrl.url);
    }

    const tags = [];
    if (artwork.tacks?.length) {
      for (const tack of artwork.tacks) {
        const jaName = tack.tackTerms?.find(t => t.category === 'ja')?.name;
        const enName = tack.tackTerms?.find(t => t.category === 'en')?.name;
        if (jaName) tags.push(jaName);
        if (enName && enName !== jaName) tags.push(enName);
      }
    }

    return {
      source: 'pixai',
      sourceUrl: `https://pixai.art/artwork/${artwork.id}`,
      artworkId: artwork.id,
      title: artwork.title || '',
      prompt: artwork.prompts || '',
      tags,
      imageUrls,
      imageWidth: artwork.media?.width || 0,
      imageHeight: artwork.media?.height || 0,
      imageType: artwork.media?.imageType || 'webp',
      isNsfw: artwork.isNsfw || false,
      isSensitive: artwork.isSensitive || false,
      extractedAt: new Date().toISOString(),
    };
  }

  function extractFromDOM() {
    const data = {
      source: 'pixai',
      sourceUrl: window.location.href,
      artworkId: window.location.pathname.split('/').pop(),
      title: '', prompt: '', naturalPrompt: '',
      tags: [], imageUrls: [],
      imageWidth: 0, imageHeight: 0,
      isNsfw: false, isSensitive: false,
      author: '', params: {},
      extractedAt: new Date().toISOString(),
    };

    const allPres = document.querySelectorAll('pre, code, [class*="prompt" i]');
    for (const el of allPres) {
      const text = el.textContent?.trim();
      if (text && text.length > 20 && !text.includes('function')) {
        if (!data.prompt || text.length > data.prompt.length) data.prompt = text;
      }
    }

    const imgs = document.querySelectorAll('img[src*="pixai"], img[src*="cloudfront"]');
    for (const img of imgs) {
      const rect = img.getBoundingClientRect();
      if (rect.width > 200 && rect.height > 200) data.imageUrls.push(img.src);
    }

    const h1 = document.querySelector('h1');
    if (h1) data.title = h1.textContent?.trim() || '';
    if (!data.title && data.prompt) {
      data.title = data.prompt.substring(0, 60).replace(/[,.\n].*/s, '').trim();
    }

    return data;
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : '';
  }

  // ── UI ───────────────────────────────────────────────────────────

  function createButton() {
    if (document.getElementById(BUTTON_ID)) return;

    const btn = document.createElement('div');
    btn.id = BUTTON_ID;
    btn.innerHTML = `
      <div class="p2p-btn-inner" id="p2p-add-btn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M12 5v14M5 12h14"/>
        </svg>
        <span>添加到 Pixiv 队列</span>
        <span class="p2p-queue-badge" id="p2p-badge" style="display:none;">0</span>
      </div>
      <div class="p2p-status" style="display:none;"></div>
    `;

    btn.querySelector('#p2p-add-btn').addEventListener('click', handleAddClick);
    document.body.appendChild(btn);

    // Show current queue count
    updateQueueBadge();
  }

  async function updateQueueBadge() {
    const res = await chrome.runtime.sendMessage({ action: 'getQueue' });
    const count = res?.data?.length || 0;
    const badge = document.getElementById('p2p-badge');
    if (badge) {
      badge.textContent = count;
      badge.style.display = count > 0 ? 'inline-flex' : 'none';
    }
  }

  async function handleAddClick() {
    const inner = document.getElementById('p2p-add-btn');
    const status = document.querySelector('#' + BUTTON_ID + ' .p2p-status');
    const originalHtml = inner.innerHTML;

    inner.innerHTML = `<div class="p2p-spinner"></div><span>读取中...</span>`;

    try {
      // Extract ID from /artwork/ID or /lang/artwork/ID
      const artworkId = window.location.pathname.match(/\/artwork\/([^/?]+)/)?.[1];
      if (!artworkId) throw new Error('无法获取作品 ID');

      let data;
      try {
        data = await fetchArtworkData(artworkId);
      } catch (e) {
        console.warn('[PixAI→Pixiv] API failed, DOM fallback:', e);
        data = extractFromDOM();
      }

      if (!data.prompt && data.imageUrls.length === 0) {
        throw new Error('无法读取作品信息');
      }

      // Add to queue
      const result = await chrome.runtime.sendMessage({ action: 'addToQueue', data });
      const queueLen = result.queueLength;

      // Show success
      inner.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4CAF50" stroke-width="2.5">
          <path d="M20 6L9 17l-5-5"/>
        </svg>
        <span>已添加 (队列: ${queueLen})</span>
        <span class="p2p-queue-badge">${queueLen}</span>
      `;

      // Show preview
      const thumbUrl = data.imageUrls[1] || data.imageUrls[0] || '';
      status.style.display = 'block';
      status.innerHTML = `
        <div class="p2p-preview">
          ${thumbUrl ? `<img src="${thumbUrl}" class="p2p-thumb">` : ''}
          <div class="p2p-preview-item"><strong>${escapeHtml(data.title || '(untitled)')}</strong></div>
          <div class="p2p-preview-item">${escapeHtml(truncate(data.prompt, 80))}</div>
          <div class="p2p-preview-item">📐 ${data.imageWidth}×${data.imageHeight}</div>
          <div class="p2p-mini-actions">
            <button class="p2p-go-btn" id="p2p-go-pixiv">📤 发布 ${queueLen} 张到 Pixiv</button>
            <button class="p2p-edit-btn" id="p2p-continue">继续添加其他作品</button>
          </div>
        </div>
      `;

      document.getElementById('p2p-go-pixiv').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'openPixivCreate' });
      });
      document.getElementById('p2p-continue').addEventListener('click', () => {
        resetButton();
      });

    } catch (err) {
      inner.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f44336" stroke-width="2">
          <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
        <span>${escapeHtml(err.message)}</span>
      `;
      setTimeout(resetButton, 3000);
    }
  }

  function resetButton() {
    const inner = document.getElementById('p2p-add-btn');
    const status = document.querySelector('#' + BUTTON_ID + ' .p2p-status');
    if (inner) {
      inner.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M12 5v14M5 12h14"/>
        </svg>
        <span>添加到 Pixiv 队列</span>
        <span class="p2p-queue-badge" id="p2p-badge" style="display:none;">0</span>
      `;
    }
    if (status) { status.style.display = 'none'; status.innerHTML = ''; }
    updateQueueBadge();
  }

  function truncate(s, len) {
    return !s ? '' : s.length > len ? s.substring(0, len) + '...' : s;
  }
  function escapeHtml(s) {
    return !s ? '' : s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escapeAttr(s) {
    return !s ? '' : s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Init ─────────────────────────────────────────────────────────

  function init() {
    // Support /artwork/ID and /lang/artwork/ID (e.g. /ja/artwork/123)
    if (!window.location.pathname.match(/\/artwork\//)) return;
    console.log('[PixAI→Pixiv] Init on:', window.location.href);
    setTimeout(createButton, 800);
  }

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      document.getElementById(BUTTON_ID)?.remove();
      init();
    }
  }).observe(document.body, { childList: true, subtree: true });

  init();
})();
