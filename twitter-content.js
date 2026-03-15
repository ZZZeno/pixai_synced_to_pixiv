// PixAI → Twitter/X Publisher - Twitter Content Script
// Runs on x.com/compose/tweet and x.com/intent/tweet
// Auto-fills tweet text and attaches images from queued artworks

(function () {
  'use strict';

  const MAX_RETRIES = 30;
  const RETRY_INTERVAL = 800;

  async function init() {
    const res = await chrome.runtime.sendMessage({ action: 'getQueue', target: 'twitter' });
    const queue = res?.data;
    if (!queue?.length) {
      console.log('[PixAI→Twitter] Twitter queue is empty');
      return;
    }

    console.log(`[PixAI→Twitter] Found ${queue.length} artworks in queue`);
    showBanner(queue);
  }

  // ── Banner UI ────────────────────────────────────────────────

  function showBanner(queue) {
    const banner = document.createElement('div');
    banner.id = 'p2t-twitter-banner';
    const title = queue.length === 1
      ? `1枚の作品を投稿: ${queue[0].title || '(untitled)'}`
      : `${queue.length} 枚の作品を投稿`;

    banner.innerHTML = `
      <div class="p2t-banner-inner">
        <div class="p2t-banner-left">
          <strong>🎨 PixAI → 𝕏</strong>
          <span class="p2t-banner-title">${escapeHtml(title)}</span>
        </div>
        <div class="p2t-banner-actions" id="p2t-banner-actions">
          <button id="p2t-fill-all" class="p2t-fill-btn primary">ツイートに入力</button>
          <button id="p2t-fill-dismiss" class="p2t-fill-btn secondary">無視</button>
        </div>
      </div>
    `;
    document.body.prepend(banner);

    document.getElementById('p2t-fill-all').addEventListener('click', async () => {
      const actions = document.getElementById('p2t-banner-actions');
      actions.innerHTML = '<span class="p2t-filling">⏳ 入力中...</span>';
      await fillTweet(queue);
    });

    document.getElementById('p2t-fill-dismiss').addEventListener('click', () => {
      banner.remove();
    });
  }

  // ── Main fill logic ──────────────────────────────────────────

  async function fillTweet(queue) {
    // Wait for the tweet compose area
    const editor = await waitForEditor();
    if (!editor) {
      showNotification('ツイート入力欄が見つかりません', 'error');
      return;
    }

    const results = [];

    // ── 1. Build tweet text ──────────────────────────────────
    const tweetText = buildTweetText(queue);
    const textOk = await setTweetText(editor, tweetText);
    results.push({ field: 'テキスト', ok: textOk });
    await sleep(500);

    // ── 2. Upload images (max 4 for Twitter) ─────────────────
    const imageUrls = queue
      .map(a => a.imageUrls?.[0])
      .filter(Boolean)
      .slice(0, 4); // Twitter max 4 images

    if (imageUrls.length > 0) {
      showNotification(`画像をアップロード中 ${imageUrls.length} 枚...`, 'loading');
      const imgOk = await uploadImages(imageUrls);
      results.push({ field: `画像(${imageUrls.length})`, ok: imgOk });
    }

    // ── Show results ─────────────────────────────────────────
    const allOk = results.every(r => r.ok);
    const summary = results.map(r => `${r.ok ? '✅' : '❌'} ${r.field}`).join('  ');

    if (allOk) {
      showNotification(`入力完了! ${summary}`, 'success');
    } else {
      showNotification(`一部失敗: ${summary}`, 'error');
    }

    // Update banner
    const banner = document.getElementById('p2t-twitter-banner');
    if (banner) {
      const inner = banner.querySelector('.p2t-banner-inner');
      if (inner) {
        inner.innerHTML = `
          <div class="p2t-banner-left">
            <strong>${allOk ? '✅' : '⚠️'} 入力完了</strong>
            <span class="p2t-banner-title">${summary}</span>
          </div>
          <div class="p2t-banner-actions">
            <button class="p2t-fill-btn secondary" onclick="this.closest('#p2t-twitter-banner').remove()">閉じる</button>
          </div>
        `;
      }
    }
  }

  // ── Tweet text builder ───────────────────────────────────────

  function buildTweetText(queue) {
    const parts = [];

    // Title
    if (queue.length === 1) {
      const title = queue[0].title;
      if (title) parts.push(title);
    } else {
      const titles = queue.map(a => a.title).filter(Boolean);
      if (titles.length) parts.push(titles.join(' / '));
    }

    // Source link (first artwork)
    const artworkId = queue[0].artworkId || queue[0].id;
    if (artworkId) {
      parts.push(`https://pixai.art/artwork/${artworkId}`);
    }

    // Tags as hashtags (intersection for multi, skip spaces, max ~5 for twitter)
    const tags = getTagsForTweet(queue);
    if (tags.length > 0) {
      parts.push(tags.map(t => `#${t}`).join(' '));
    }

    // Always add #PixAI
    if (!tags.includes('PixAI')) {
      parts.push('#PixAI');
    }

    return parts.join('\n');
  }

  function getTagsForTweet(queue) {
    // Same logic as Pixiv: intersection for multi, skip spaces
    const allTagSets = queue.map(artwork => {
      const tags = (artwork.tags || [])
        .filter(t => !t.includes(' '))  // skip tags with spaces
        .filter(t => t !== 'PixAI');
      return new Set(tags);
    });

    if (allTagSets.length === 0) return [];
    if (allTagSets.length === 1) return [...allTagSets[0]].slice(0, 5);

    // Intersection
    let common = allTagSets[0];
    for (let i = 1; i < allTagSets.length; i++) {
      common = new Set([...common].filter(t => allTagSets[i].has(t)));
    }
    return [...common].slice(0, 5);
  }

  // ── Twitter DOM interaction ──────────────────────────────────

  async function waitForEditor() {
    for (let i = 0; i < MAX_RETRIES; i++) {
      // Twitter compose uses contenteditable div with role="textbox"
      const editor = document.querySelector('[data-testid="tweetTextarea_0"] [role="textbox"]')
        || document.querySelector('[data-testid="tweetTextarea_0"]')
        || document.querySelector('.public-DraftEditor-content [contenteditable="true"]')
        || document.querySelector('[contenteditable="true"][role="textbox"]');
      if (editor) return editor;
      await sleep(RETRY_INTERVAL);
    }
    console.warn('[PixAI→Twitter] Editor not found after retries');
    return null;
  }

  async function setTweetText(editor, text) {
    try {
      // Focus the editor
      editor.focus();
      await sleep(100);

      // Clear existing content
      document.execCommand('selectAll', false, null);
      await sleep(50);

      // Use insertText to work with React/Draft.js
      document.execCommand('insertText', false, text);
      await sleep(100);

      // Also dispatch input event
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(100);

      console.log(`[PixAI→Twitter] Tweet text set ✓`);
      return true;
    } catch (e) {
      console.error('[PixAI→Twitter] Failed to set text:', e);
      return false;
    }
  }

  async function uploadImages(imageUrls) {
    try {
      // Find the file input for image upload
      // Twitter uses a hidden file input
      let fileInput = document.querySelector('input[data-testid="fileInput"]')
        || document.querySelector('input[type="file"][accept*="image"]');

      if (!fileInput) {
        // Try clicking the media button to reveal the input
        const mediaBtn = document.querySelector('[data-testid="tweetMediaButton"]')
          || document.querySelector('[aria-label*="Media"]')
          || document.querySelector('[aria-label*="メディア"]')
          || document.querySelector('[aria-label*="media"]');
        if (mediaBtn) {
          mediaBtn.click();
          await sleep(500);
          fileInput = document.querySelector('input[data-testid="fileInput"]')
            || document.querySelector('input[type="file"][accept*="image"]');
        }
      }

      if (!fileInput) {
        console.warn('[PixAI→Twitter] File input not found');
        return false;
      }

      // Download all images and convert to File objects
      const files = [];
      for (let i = 0; i < imageUrls.length; i++) {
        const url = imageUrls[i];
        console.log(`[PixAI→Twitter] Downloading image ${i + 1}/${imageUrls.length}: ${url}`);

        try {
          // Use background script to download (avoid CORS)
          const response = await chrome.runtime.sendMessage({
            action: 'downloadImage',
            url: url,
          });

          if (response?.data) {
            // Convert base64 to File
            const binary = atob(response.data);
            const bytes = new Uint8Array(binary.length);
            for (let j = 0; j < binary.length; j++) {
              bytes[j] = binary.charCodeAt(j);
            }

            // Determine content type
            const contentType = response.contentType || 'image/jpeg';
            const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';

            // Convert WebP to PNG if needed
            let blob;
            if (contentType.includes('webp')) {
              console.log('[PixAI→Twitter] Converting WebP to PNG...');
              const converted = await chrome.runtime.sendMessage({
                action: 'convertWebpToPng',
                data: response.data,
              });
              if (converted?.data) {
                const pngBinary = atob(converted.data);
                const pngBytes = new Uint8Array(pngBinary.length);
                for (let j = 0; j < pngBinary.length; j++) {
                  pngBytes[j] = pngBinary.charCodeAt(j);
                }
                blob = new Blob([pngBytes], { type: 'image/png' });
              } else {
                blob = new Blob([bytes], { type: contentType });
              }
            } else {
              blob = new Blob([bytes], { type: contentType });
            }

            const file = new File([blob], `pixai_${i + 1}.${ext === 'webp' ? 'png' : ext}`, {
              type: blob.type,
              lastModified: Date.now(),
            });
            files.push(file);
            console.log(`[PixAI→Twitter] Image ${i + 1} ready: ${file.name} (${(file.size / 1024).toFixed(1)}KB)`);
          }
        } catch (e) {
          console.error(`[PixAI→Twitter] Failed to download image ${i + 1}:`, e);
        }
      }

      if (files.length === 0) {
        console.warn('[PixAI→Twitter] No images downloaded');
        return false;
      }

      // Create DataTransfer and set files
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));

      // Set files on the input
      Object.defineProperty(fileInput, 'files', {
        value: dt.files,
        writable: true,
        configurable: true,
      });

      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(1000);

      console.log(`[PixAI→Twitter] ${files.length} images uploaded ✓`);
      return true;
    } catch (e) {
      console.error('[PixAI→Twitter] Image upload failed:', e);
      return false;
    }
  }

  // ── Utilities ────────────────────────────────────────────────

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function showNotification(message, type = 'success') {
    const existing = document.querySelectorAll('.p2t-notification');
    existing.forEach(n => n.remove());

    const notif = document.createElement('div');
    notif.className = `p2t-notification ${type}`;
    notif.textContent = message;
    document.body.appendChild(notif);

    if (type !== 'loading') {
      setTimeout(() => notif.remove(), 5000);
    }
  }

  // ── SPA Navigation handling ──────────────────────────────────
  // Twitter is an SPA, so we need to watch for URL changes

  let lastUrl = location.href;

  function checkUrl() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (isComposePage()) {
        // Remove old banner if exists
        const old = document.getElementById('p2t-twitter-banner');
        if (old) old.remove();
        setTimeout(() => init(), 1000);
      }
    }
  }

  function isComposePage() {
    return location.pathname.includes('/compose') || location.pathname.includes('/intent/tweet');
  }

  // Watch for SPA navigation
  const observer = new MutationObserver(() => checkUrl());
  observer.observe(document.body, { childList: true, subtree: true });

  // Also check periodically
  setInterval(checkUrl, 2000);

  // Initial run
  if (isComposePage()) {
    setTimeout(() => init(), 1500);
  }
})();
