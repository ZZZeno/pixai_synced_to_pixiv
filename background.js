// PixAI → Pixiv / Twitter Publisher - Background Service Worker
// Supports dual queues: pixivQueue and twitterQueue

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const target = message.target || 'pixiv'; // 'pixiv' or 'twitter'
  const queueKey = target === 'twitter' ? 'twitterQueue' : 'pixivQueue';

  // ── Legacy compat: getQueue without target returns both ──
  if (message.action === 'getQueue') {
    if (message.target) {
      // Specific queue
      chrome.storage.local.get({ [queueKey]: [] }, (result) => {
        sendResponse({ data: result[queueKey] });
      });
    } else {
      // Return both queues (for popup)
      chrome.storage.local.get({ pixivQueue: [], twitterQueue: [] }, (result) => {
        sendResponse({
          pixiv: result.pixivQueue,
          twitter: result.twitterQueue,
          // Legacy compat: data = pixiv queue
          data: result.pixivQueue,
        });
      });
    }
    return true;
  }

  // Add artwork to a specific queue
  if (message.action === 'addToQueue') {
    chrome.storage.local.get({ [queueKey]: [] }, (result) => {
      const queue = result[queueKey];
      const exists = queue.findIndex(a => a.artworkId === message.data.artworkId);
      if (exists >= 0) {
        queue[exists] = message.data;
      } else {
        queue.push(message.data);
      }
      chrome.storage.local.set({ [queueKey]: queue }, () => {
        updateBadge();
        sendResponse({ success: true, queueLength: queue.length });
      });
    });
    return true;
  }

  // Remove one item from queue by artworkId
  if (message.action === 'removeFromQueue') {
    chrome.storage.local.get({ [queueKey]: [] }, (result) => {
      const queue = result[queueKey].filter(a => a.artworkId !== message.artworkId);
      chrome.storage.local.set({ [queueKey]: queue }, () => {
        updateBadge();
        sendResponse({ success: true, queueLength: queue.length });
      });
    });
    return true;
  }

  // Reorder queue
  if (message.action === 'reorderQueue') {
    chrome.storage.local.set({ [queueKey]: message.queue }, () => {
      updateBadge();
      sendResponse({ success: true });
    });
    return true;
  }

  // Clear a specific queue
  if (message.action === 'clearQueue') {
    chrome.storage.local.set({ [queueKey]: [] }, () => {
      updateBadge();
      sendResponse({ success: true });
    });
    return true;
  }

  // Open Pixiv create page
  if (message.action === 'openPixivCreate') {
    chrome.tabs.create({ url: 'https://www.pixiv.net/illustration/create' }, (tab) => {
      sendResponse({ success: true, tabId: tab.id });
    });
    return true;
  }

  // Open Twitter compose page
  if (message.action === 'openTwitterCompose') {
    chrome.tabs.create({ url: 'https://x.com/compose/tweet' }, (tab) => {
      sendResponse({ success: true, tabId: tab.id });
    });
    return true;
  }

  // Download image and convert webp → png
  if (message.action === 'downloadImage') {
    fetch(message.url, { mode: 'cors' })
      .then(res => res.blob())
      .then(async (blob) => {
        console.log('[PixAI] Downloaded image:', blob.type, blob.size, 'bytes');
        if (blob.type === 'image/webp' || message.url.includes('webp') || message.forceConvert) {
          console.log('[PixAI] Converting WebP → PNG...');
          const result = await convertToPng(blob);
          sendResponse(result);
        } else {
          const reader = new FileReader();
          reader.onloadend = () => sendResponse({ success: true, dataUrl: reader.result, converted: false });
          reader.readAsDataURL(blob);
        }
      })
      .catch(err => {
        console.error('[PixAI] Download failed:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }
});

// Convert webp blob to PNG using OffscreenCanvas
async function convertToPng(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
    const reader = new FileReader();
    return new Promise((resolve) => {
      reader.onloadend = () => resolve({ success: true, dataUrl: reader.result, converted: true });
      reader.readAsDataURL(pngBlob);
    });
  } catch (err) {
    console.error('[PixAI] WebP→PNG conversion failed:', err);
    const reader = new FileReader();
    return new Promise((resolve) => {
      reader.onloadend = () => resolve({ success: true, dataUrl: reader.result, converted: false });
      reader.readAsDataURL(blob);
    });
  }
}

function updateBadge() {
  chrome.storage.local.get({ pixivQueue: [], twitterQueue: [] }, (result) => {
    const total = result.pixivQueue.length + result.twitterQueue.length;
    if (total > 0) {
      chrome.action.setBadgeText({ text: String(total) });
      chrome.action.setBadgeBackgroundColor({ color: '#FF6B35' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  });
}

// Restore badge on startup
updateBadge();
