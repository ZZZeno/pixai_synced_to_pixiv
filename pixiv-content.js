// PixAI → Pixiv Publisher - Pixiv Content Script
// Runs on pixiv.net/illustration/create
// Auto-fills with queued artworks (supports multi-image uploads)

(function () {
  'use strict';

  const MAX_RETRIES = 40;
  const RETRY_INTERVAL = 800;

  async function init() {
    const res = await chrome.runtime.sendMessage({ action: 'getQueue' });
    const queue = res?.data;
    if (!queue?.length) {
      console.log('[PixAI→Pixiv] Queue is empty');
      return;
    }

    console.log(`[PixAI→Pixiv] Found ${queue.length} artworks in queue`);
    showBanner(queue);
  }

  function showBanner(queue) {
    const banner = document.createElement('div');
    banner.id = 'p2p-pixiv-banner';
    const title = queue.length === 1
      ? `1枚の作品を投稿予定: ${queue[0].title || '(untitled)'}`
      : `${queue.length} 枚の作品を一括投稿`;

    banner.innerHTML = `
      <div class="p2p-banner-inner">
        <div class="p2p-banner-left">
          <strong>🎨 PixAI</strong>
          <span class="p2p-banner-title">${escapeHtml(title)}</span>
        </div>
        <div class="p2p-banner-actions" id="p2p-banner-actions">
          <button id="p2p-fill-all" class="p2p-fill-btn primary">一括入力</button>
          <button id="p2p-fill-dismiss" class="p2p-fill-btn secondary">無視</button>
        </div>
      </div>
    `;
    document.body.prepend(banner);

    document.getElementById('p2p-fill-all').addEventListener('click', async () => {
      const actions = document.getElementById('p2p-banner-actions');
      actions.innerHTML = '<span class="p2p-filling">⏳ 入力中 ' + queue.length + ' 枚の作品...</span>';
      await fillAll(queue);
    });

    document.getElementById('p2p-fill-dismiss').addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'clearQueue' });
      banner.remove();
    });
  }

  async function fillAll(queue) {
    const formReady = await waitForForm();
    if (!formReady) {
      showNotification('ページの読み込みがタイムアウトしました', 'error');
      return;
    }

    const results = [];

    // ── 1. Upload all images ──────────────────────────────────────
    const imageUrls = queue.map(a => a.imageUrls?.[0]).filter(Boolean);
    if (imageUrls.length > 0) {
      showNotification(`画像をダウンロード&アップロード中 ${imageUrls.length} 枚...`, 'loading');
      const imgOk = await uploadImages(imageUrls, queue);
      results.push({ field: `画像(${imageUrls.length})`, ok: imgOk });
      if (imgOk) await sleep(2000);
    }

    // ── 2. Title ──────────────────────────────────────────────────
    // Use first artwork's title, or combine titles
    const title = queue.length === 1
      ? queue[0].title
      : queue[0].title || queue.map(a => a.title).filter(Boolean).join(' / ');

    if (title) {
      const ok = await fillField('title', title, [
        'input[placeholder*="タイトル"]',
        'input[placeholder*="title" i]',
        'input[name="title"]',
        'input[name*="title" i]',
      ]);
      results.push({ field: 'タイトル', ok });
    }

    // ── 3. Caption / Description ──────────────────────────────────
    const caption = buildCaption(queue);
    if (caption) {
      const ok = await fillField('caption', caption, [
        'textarea[placeholder*="キャプション"]',
        'textarea[placeholder*="caption" i]',
        'textarea[placeholder*="説明"]',
        'textarea[name="caption"]',
        'textarea[name*="caption" i]',
        'textarea[name*="description" i]',
      ], true);
      results.push({ field: '説明', ok });
    }

    // ── 4. Tags ───────────────────────────────────────────────────
    const allTags = buildMergedTags(queue);
    if (allTags.length > 0) {
      const ok = await fillTags(allTags);
      results.push({ field: 'タグ', ok });
    }

    // ── 5. Age rating - always 全年龄
    const ageOk = await setAgeRating('all');
    results.push({ field: '年齢制限', ok: ageOk });

    // ── 6. Sexual content - always 無
    const sexOk = await setSexualContent('none');
    results.push({ field: '性描写', ok: sexOk });

    // ── 7. AI generated flag ──────────────────────────────────────
    const aiOk = await setAIFlag();
    results.push({ field: 'AI生成', ok: aiOk });

    // ── Done ──────────────────────────────────────────────────────
    const okCount = results.filter(r => r.ok).length;
    const failedFields = results.filter(r => !r.ok).map(r => r.field);

    if (failedFields.length === 0) {
      showNotification(`✅ ${queue.length} 枚の作品...全部填入！请检查后发布`, 'success');
    } else {
      showNotification(`入力済み ${okCount} 件，${failedFields.join('、')} は手動で入力してください`, 'warning');
    }

    // Remove banner
    document.getElementById('p2p-pixiv-banner')?.remove();
    // Clear queue
    chrome.runtime.sendMessage({ action: 'clearQueue' });
  }

  // ── Multi-image Upload ──────────────────────────────────────────

  async function uploadImages(imageUrls, queue) {
    try {
      // Download all images
      const files = [];
      for (let i = 0; i < imageUrls.length; i++) {
        showNotification(`画像をダウンロード中 ${i + 1}/${imageUrls.length}...`, 'loading');
        const response = await chrome.runtime.sendMessage({
          action: 'downloadImage',
          url: imageUrls[i]
        });

        if (!response?.success || !response.dataUrl) {
          console.error(`[PixAI→Pixiv] Failed to download image ${i + 1}`);
          continue;
        }

        const blob = dataUrlToBlob(response.dataUrl);
        // Background script already converts webp→png, so always use png
        const mime = response.converted ? 'image/png' : (blob.type || 'image/png');
        const ext = mime.includes('png') ? 'png' : 'jpg';
        files.push(new File([blob], `pixai_${i + 1}.${ext}`, { type: mime }));
      }

      if (files.length === 0) return false;

      showNotification(`アップロード中 ${files.length} 枚...`, 'loading');

      // Method 1: File input (supports multiple files)
      const fileInput = document.querySelector('input[type="file"][accept*="image"]')
        || document.querySelector('input[type="file"]');

      if (fileInput) {
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(f);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        console.log(`[PixAI→Pixiv] ${files.length} images set via file input`);
        return true;
      }

      // Method 2: Drag & drop
      const dropZone = document.querySelector(
        '[class*="upload" i], [class*="drop" i], [class*="dragArea" i]'
      );
      if (dropZone) {
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(f);
        ['dragenter', 'dragover'].forEach(type => {
          dropZone.dispatchEvent(new DragEvent(type, { bubbles: true, dataTransfer: dt }));
        });
        dropZone.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
        console.log(`[PixAI→Pixiv] ${files.length} images dropped`);
        return true;
      }

      // Method 3: If single file input, upload sequentially
      // Some sites need you to upload one at a time
      if (files.length > 1) {
        console.log('[PixAI→Pixiv] Trying sequential upload...');
        for (let i = 0; i < files.length; i++) {
          const inp = document.querySelector('input[type="file"]');
          if (!inp) break;
          const dt = new DataTransfer();
          dt.items.add(files[i]);
          inp.files = dt.files;
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(1500);
        }
        return true;
      }

      return false;
    } catch (err) {
      console.error('[PixAI→Pixiv] Upload error:', err);
      return false;
    }
  }

  // ── Caption Builder ─────────────────────────────────────────────

  function buildCaption(queue) {
    if (queue.length === 1) {
      const a = queue[0];
      // Just the title/prompt + source link, no generation params
      let parts = [];
      if (a.title) parts.push(a.title);
      if (a.sourceUrl) parts.push(a.sourceUrl);
      return parts.join('\n');
    }

    // Multi-image: just titles + source links
    let lines = [];
    queue.forEach((a, i) => {
      if (a.title) lines.push(`[${i + 1}] ${a.title}`);
      if (a.sourceUrl) lines.push(a.sourceUrl);
    });
    return lines.join('\n').trim();
  }

  // ── Tag Merger ──────────────────────────────────────────────────

  function buildMergedTags(queue) {
    let tags;

    if (queue.length === 1) {
      // Single artwork: use all its tags
      tags = [...(queue[0].tags || [])];
    } else {
      // Multiple artworks: intersection only (tags present in ALL artworks)
      const tagSets = queue.map(a => new Set(a.tags || []));
      const intersection = [...tagSets[0]].filter(t => tagSets.every(s => s.has(t)));
      tags = intersection;
    }

    // Always add PixAI tag
    if (!tags.includes('PixAI')) tags.push('PixAI');

    return tags.slice(0, 10); // Pixiv max 10
  }

  // ── Form Fillers ────────────────────────────────────────────────

  async function waitForForm() {
    for (let i = 0; i < MAX_RETRIES; i++) {
      if (document.querySelector('input[type="file"], form, main input, main textarea')) {
        await sleep(800);
        return true;
      }
      await sleep(RETRY_INTERVAL);
    }
    return false;
  }

  async function fillField(name, value, selectors, isTextarea = false) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        await setReactValue(el, value);
        console.log(`[PixAI→Pixiv] Filled ${name}`);
        return true;
      }
    }

    if (isTextarea) {
      const editables = document.querySelectorAll('[contenteditable="true"], [role="textbox"]');
      for (const el of editables) {
        if (el.getBoundingClientRect().height > 60) {
          el.focus();
          el.innerHTML = value.replace(/\n/g, '<br>');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
      }
    }

    const allEls = document.querySelectorAll(isTextarea ? 'textarea' : 'input[type="text"]');
    if (allEls.length > 0) {
      await setReactValue(allEls[0], value);
      return true;
    }

    console.warn(`[PixAI→Pixiv] ${name} field not found`);
    return false;
  }

  async function fillTags(tags) {
    const tagSelectors = [
      'input[placeholder*="タグ"]',
      'input[placeholder*="tag" i]',
      'input[placeholder*="タグ"]',
      '[class*="tag" i] input[type="text"]',
    ];

    let tagInput = null;
    for (const sel of tagSelectors) {
      tagInput = document.querySelector(sel);
      if (tagInput) break;
    }

    if (tagInput) {
      for (const tag of tags) {
        await setReactValue(tagInput, tag);
        await sleep(150);
        for (const et of ['keydown', 'keypress', 'keyup']) {
          tagInput.dispatchEvent(new KeyboardEvent(et, {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
          }));
        }
        await sleep(200);
      }
      return true;
    }

    return false;
  }

  async function setAIFlag() {
    console.log('[PixAI→Pixiv] Looking for AI flag...');

    // AI flag is a yes/no radio group
    // zh: 是/否  ja: はい/いいえ  en: Yes/No
    const yesLabels = ['是', 'はい', 'yes'];
    const noLabels = ['否', 'いいえ', 'no'];

    const radioGroups = document.querySelectorAll('.charcoal-radio-group');

    for (const group of radioGroups) {
      const labels = group.querySelectorAll('.charcoal-radio__label');
      if (labels.length !== 2) continue;

      const t0 = labels[0].textContent?.trim().toLowerCase() || '';
      const t1 = labels[1].textContent?.trim().toLowerCase() || '';

      // Check if this is a yes/no group
      const isYesNo = (
        yesLabels.some(y => t0 === y.toLowerCase()) && noLabels.some(n => t1 === n.toLowerCase())
      ) || (
        noLabels.some(n => t0 === n.toLowerCase()) && yesLabels.some(y => t1 === y.toLowerCase())
      );

      if (isYesNo) {
        // Click the "yes" label
        for (const label of labels) {
          const t = label.textContent?.trim().toLowerCase();
          if (yesLabels.some(y => t === y.toLowerCase())) {
            label.click();
            await sleep(100);
            const input = label.querySelector('input');
            if (input) input.click();
            await sleep(200);
            console.log(`[PixAI→Pixiv] AI flag set to "${label.textContent?.trim()}" ✓`);
            return true;
          }
        }
      }
    }

    console.warn('[PixAI→Pixiv] AI flag (yes/no) group not found');
    return false;
  }

  async function setSexualContent(level) {
    console.log(`[PixAI→Pixiv] Setting sexual content: ${level}`);

    // Sexual content group has 2 options:
    // zh: 无 / 有（含有轻度描写）
    // ja: 無 / 有（軽度な描写を含む）
    // en: No / Yes (contains mild depictions)
    // Identify by: 2 options, one contains 描写/depiction
    const noneLabels = ['无', '無', 'no', 'none'];

    const radioGroups = document.querySelectorAll('.charcoal-radio-group');

    for (const group of radioGroups) {
      const groupText = group.textContent || '';

      // Match by keyword: 描写 (zh/ja) or "depiction"/"description" (en)
      if (groupText.includes('描写') || groupText.toLowerCase().includes('depiction')) {
        const labels = group.querySelectorAll('.charcoal-radio__label');
        if (labels.length !== 2) continue;

        // Click the "none" option (first one)
        for (const label of labels) {
          const t = label.textContent?.trim().toLowerCase();
          if (noneLabels.some(n => t === n)) {
            label.click();
            await sleep(100);
            const input = label.querySelector('input');
            if (input) input.click();
            await sleep(200);
            console.log(`[PixAI→Pixiv] Sexual content set to: ${label.textContent?.trim()} ✓`);
            return true;
          }
        }
      }
    }

    console.warn('[PixAI→Pixiv] Sexual content radio group not found');
    return false;
  }

  async function setAgeRating(rating) {
    console.log(`[PixAI→Pixiv] Setting age rating: ${rating}`);

    // Age rating group: 全年龄/全年齢/All ages + R-18 + R-18G
    const allAgesLabels = ['全年龄', '全年齢', 'all ages'];
    const radioGroups = document.querySelectorAll('.charcoal-radio-group');

    for (const group of radioGroups) {
      const groupText = group.textContent || '';
      if (!groupText.includes('R-18')) continue;

      const labels = group.querySelectorAll('.charcoal-radio__label');
      if (rating === 'all') {
        for (const label of labels) {
          const t = label.textContent?.trim().toLowerCase();
          if (allAgesLabels.some(a => t === a.toLowerCase())) {
            label.click();
            await sleep(100);
            const input = label.querySelector('input');
            if (input) input.click();
            await sleep(200);
            console.log(`[PixAI→Pixiv] Age rating set to: ${label.textContent?.trim()} ✓`);
            return true;
          }
        }
      } else {
        const target = rating === 'r18' ? 'R-18' : 'R-18G';
        for (const label of labels) {
          if (label.textContent?.trim() === target) {
            label.click();
            await sleep(100);
            const input = label.querySelector('input');
            if (input) input.click();
            await sleep(200);
            console.log(`[PixAI→Pixiv] Age rating set to: ${target} ✓`);
            return true;
          }
        }
      }
    }

    console.warn(`[PixAI→Pixiv] Age rating group not found`);
    return false;
  }

  // ── Helpers ─────────────────────────────────────────────────────

  async function setReactValue(el, value) {
    el.focus();
    await sleep(50);
    const proto = el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(50);
  }

  function dataUrlToBlob(dataUrl) {
    const [h, b64] = dataUrl.split(',');
    const mime = h.match(/:(.*?);/)[1];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function escapeHtml(s) {
    return !s ? '' : s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function showNotification(msg, type = 'info') {
    document.getElementById('p2p-notification')?.remove();
    const colors = { loading: '#2196F3', success: '#4CAF50', error: '#f44336', warning: '#FF9800' };
    const icons = { loading: '⏳', success: '✅', error: '❌', warning: '⚠️' };
    const el = document.createElement('div');
    el.id = 'p2p-notification';
    el.textContent = `${icons[type] || ''} ${msg}`;
    el.style.cssText = `
      position:fixed;top:16px;right:16px;z-index:999999;
      padding:12px 20px;border-radius:10px;font-size:14px;
      background:${colors[type] || colors.info};color:white;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      box-shadow:0 4px 20px rgba(0,0,0,.3);animation:p2p-slideIn .3s ease;
    `;
    document.body.appendChild(el);
    if (type !== 'loading') setTimeout(() => el.remove(), 6000);
  }

  setTimeout(init, 1500);
})();
