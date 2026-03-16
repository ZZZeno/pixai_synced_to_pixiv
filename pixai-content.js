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
      throw new Error('APIデータが空です。作品が存在するか確認してください');
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
        // Skip tags containing spaces
        if (jaName && !jaName.includes(' ')) tags.push(jaName);
        if (enName && enName !== jaName && !enName.includes(' ')) tags.push(enName);
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
      <div class="p2p-btn-row">
        <div class="p2p-btn-inner" id="p2p-add-pixiv" data-target="pixiv">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          <span>Pixiv</span>
          <span class="p2p-queue-badge" id="p2p-badge-pixiv" style="display:none;">0</span>
        </div>
        <div class="p2p-btn-inner p2p-btn-twitter" id="p2p-add-twitter" data-target="twitter">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          <span>𝕏</span>
          <span class="p2p-queue-badge" id="p2p-badge-twitter" style="display:none;">0</span>
        </div>
      </div>
      <div class="p2p-status" style="display:none;"></div>
    `;

    btn.querySelector('#p2p-add-pixiv').addEventListener('click', () => handleAddClick('pixiv'));
    btn.querySelector('#p2p-add-twitter').addEventListener('click', () => handleAddClick('twitter'));
    document.body.appendChild(btn);

    // Show current queue count
    updateQueueBadge();
  }

  async function updateQueueBadge() {
    const res = await chrome.runtime.sendMessage({ action: 'getQueue' });
    const pixivCount = res?.pixiv?.length || res?.data?.length || 0;
    const twitterCount = res?.twitter?.length || 0;

    const bPixiv = document.getElementById('p2p-badge-pixiv');
    if (bPixiv) {
      bPixiv.textContent = pixivCount;
      bPixiv.style.display = pixivCount > 0 ? 'inline-flex' : 'none';
    }
    const bTwitter = document.getElementById('p2p-badge-twitter');
    if (bTwitter) {
      bTwitter.textContent = twitterCount;
      bTwitter.style.display = twitterCount > 0 ? 'inline-flex' : 'none';
    }
  }

  async function handleAddClick(target) {
    const inner = document.getElementById(target === 'twitter' ? 'p2p-add-twitter' : 'p2p-add-pixiv');
    const status = document.querySelector('#' + BUTTON_ID + ' .p2p-status');
    const originalHtml = inner.innerHTML;

    inner.innerHTML = `<div class="p2p-spinner"></div><span>読み込み中...</span>`;

    try {
      // Extract ID from /artwork/ID or /lang/artwork/ID
      const artworkId = window.location.pathname.match(/\/artwork\/([^/?]+)/)?.[1];
      if (!artworkId) throw new Error('作品IDを取得できません');

      let data;
      try {
        data = await fetchArtworkData(artworkId);
      } catch (e) {
        console.warn('[PixAI→Pixiv] API failed, DOM fallback:', e);
        data = extractFromDOM();
      }

      if (!data.prompt && data.imageUrls.length === 0) {
        throw new Error('作品情報を読み込めません');
      }

      // Add to queue
      const result = await chrome.runtime.sendMessage({ action: 'addToQueue', data, target });
      const queueLen = result.queueLength;

      // Show success
      const targetLabel = target === 'twitter' ? '𝕏' : 'Pixiv';
      inner.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4CAF50" stroke-width="2.5">
          <path d="M20 6L9 17l-5-5"/>
        </svg>
        <span>✓ ${queueLen}</span>
      `;

      // Show preview
      const thumbUrl = data.imageUrls[1] || data.imageUrls[0] || '';
      const openAction = target === 'twitter' ? 'openTwitterCompose' : 'openPixivCreate';
      status.style.display = 'block';
      status.innerHTML = `
        <div class="p2p-preview">
          ${thumbUrl ? `<img src="${thumbUrl}" class="p2p-thumb">` : ''}
          <div class="p2p-preview-item"><strong>${escapeHtml(data.title || '(untitled)')}</strong></div>
          <div class="p2p-preview-item">${escapeHtml(truncate(data.prompt, 80))}</div>
          <div class="p2p-preview-item">📐 ${data.imageWidth}×${data.imageHeight} → ${targetLabel}</div>
          <div class="p2p-mini-actions">
            <button class="p2p-go-btn" id="p2p-go-publish">📤 ${queueLen}枚を${targetLabel}に投稿</button>
            <button class="p2p-edit-btn" id="p2p-continue">他の作品を追加する</button>
          </div>
        </div>
      `;

      document.getElementById('p2p-go-publish').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: openAction });
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
    const pixivBtn = document.getElementById('p2p-add-pixiv');
    const twitterBtn = document.getElementById('p2p-add-twitter');
    const status = document.querySelector('#' + BUTTON_ID + ' .p2p-status');

    if (pixivBtn) {
      pixivBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M12 5v14M5 12h14"/>
        </svg>
        <span>Pixiv</span>
        <span class="p2p-queue-badge" id="p2p-badge-pixiv" style="display:none;">0</span>
      `;
    }
    if (twitterBtn) {
      twitterBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M12 5v14M5 12h14"/>
        </svg>
        <span>𝕏</span>
        <span class="p2p-queue-badge" id="p2p-badge-twitter" style="display:none;">0</span>
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

  // ── List Page: inject buttons on artwork cards ─────────────────

  function isListPage() {
    // Profile artworks, search results, explore, etc. — anything NOT a single artwork page
    return !window.location.pathname.match(/\/artwork\/\d/);
  }

  function injectListButtons() {
    // Find all artwork card links
    const links = document.querySelectorAll('a[href*="/artwork/"]');
    
    for (const link of links) {
      // Skip if already injected
      if (link.dataset.p2pInjected) continue;
      link.dataset.p2pInjected = '1';
      
      // Extract artwork ID from href
      const match = link.href.match(/\/artwork\/(\d+)/);
      if (!match) continue;
      const artworkId = match[1];
      
      // Find the image area: first div.relative with overflow-hidden inside the link
      const imageContainer = link.querySelector('div.relative.w-full') || link.querySelector('div.relative') || link;
      
      // Create button overlay
      const btns = document.createElement('div');
      btns.className = 'p2p-card-btns';
      btns.innerHTML = `
        <button class="p2p-card-btn p2p-card-pixiv" data-id="${artworkId}" data-target="pixiv" title="Pixivキューに追加">P</button>
        <button class="p2p-card-btn p2p-card-twitter" data-id="${artworkId}" data-target="twitter" title="𝕏キューに追加">𝕏</button>
      `;
      
      // Show/hide via JS mouseenter/mouseleave on the link
      link.addEventListener('mouseenter', () => btns.style.opacity = '1');
      link.addEventListener('mouseleave', () => {
        if (!btns.matches(':hover')) btns.style.opacity = '0';
      });
      btns.addEventListener('mouseleave', () => btns.style.opacity = '0');
      
      // Prevent link navigation when clicking buttons
      btns.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      
      btns.querySelectorAll('.p2p-card-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          const id = btn.dataset.id;
          const target = btn.dataset.target;
          btn.textContent = '…';
          btn.disabled = true;
          
          try {
            const data = await fetchArtworkData(id);
            const result = await chrome.runtime.sendMessage({ action: 'addToQueue', data, target });
            btn.textContent = '✓';
            btn.classList.add('p2p-card-btn-done');
            updateQueueBadge();
          } catch (err) {
            console.error(`[PixAI→Pixiv] Failed to add ${id}:`, err);
            btn.textContent = '✗';
            setTimeout(() => {
              btn.textContent = target === 'twitter' ? '𝕏' : 'P';
              btn.disabled = false;
            }, 2000);
          }
        });
      });
      
      imageContainer.appendChild(btns);
    }
  }

  // Batch select toolbar for list pages
  function createListToolbar() {
    if (document.getElementById('p2p-list-toolbar')) return;
    if (!isListPage()) return;
    
    // Check if there are any artwork links on page
    const hasArtworks = document.querySelector('a[href*="/artwork/"]');
    if (!hasArtworks) return;
    
    const toolbar = document.createElement('div');
    toolbar.id = 'p2p-list-toolbar';
    toolbar.innerHTML = `
      <div class="p2p-toolbar-inner">
        <span class="p2p-toolbar-label">🎨 PixAI Publisher</span>
        <span class="p2p-toolbar-badges">
          <span class="p2p-queue-badge" id="p2p-badge-pixiv-toolbar" style="display:none;">P: 0</span>
          <span class="p2p-queue-badge p2p-badge-twitter" id="p2p-badge-twitter-toolbar" style="display:none;">𝕏: 0</span>
        </span>
      </div>
    `;
    document.body.appendChild(toolbar);
    updateQueueBadge();
  }

  // Override updateQueueBadge to also update toolbar badges
  const _origUpdateQueueBadge = updateQueueBadge;
  updateQueueBadge = async function() {
    const res = await chrome.runtime.sendMessage({ action: 'getQueue' });
    const pixivCount = res?.pixiv?.length || res?.data?.length || 0;
    const twitterCount = res?.twitter?.length || 0;

    // Artwork page badges
    const bPixiv = document.getElementById('p2p-badge-pixiv');
    if (bPixiv) {
      bPixiv.textContent = pixivCount;
      bPixiv.style.display = pixivCount > 0 ? 'inline-flex' : 'none';
    }
    const bTwitter = document.getElementById('p2p-badge-twitter');
    if (bTwitter) {
      bTwitter.textContent = twitterCount;
      bTwitter.style.display = twitterCount > 0 ? 'inline-flex' : 'none';
    }
    
    // Toolbar badges
    const tbPixiv = document.getElementById('p2p-badge-pixiv-toolbar');
    if (tbPixiv) {
      tbPixiv.textContent = `P: ${pixivCount}`;
      tbPixiv.style.display = pixivCount > 0 ? 'inline-flex' : 'none';
    }
    const tbTwitter = document.getElementById('p2p-badge-twitter-toolbar');
    if (tbTwitter) {
      tbTwitter.textContent = `𝕏: ${twitterCount}`;
      tbTwitter.style.display = twitterCount > 0 ? 'inline-flex' : 'none';
    }
  };

  // ── Init ─────────────────────────────────────────────────────────

  function init() {
    if (window.location.pathname.match(/\/artwork\/\d/)) {
      // Single artwork page
      console.log('[PixAI→Pixiv] Init artwork page:', window.location.href);
      setTimeout(createButton, 800);
    } else {
      // List page (profile, search, explore, etc.)
      console.log('[PixAI→Pixiv] Init list page:', window.location.href);
      setTimeout(() => {
        injectListButtons();
        createListToolbar();
      }, 1500);
    }
  }

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      document.getElementById(BUTTON_ID)?.remove();
      document.getElementById('p2p-list-toolbar')?.remove();
      init();
    }
    // Re-inject on list pages as new cards load (infinite scroll)
    if (isListPage()) {
      injectListButtons();
    }
  }).observe(document.body, { childList: true, subtree: true });

  init();
})();
