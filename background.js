// PixAI → Pixiv Publisher - Background Service Worker
// Supports batch mode: multiple artworks queued for publishing

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Add artwork to the queue (append, not replace)
  if (message.action === 'addToQueue') {
    chrome.storage.local.get({ artworkQueue: [] }, (result) => {
      const queue = result.artworkQueue;
      // Avoid duplicates by artworkId
      const exists = queue.findIndex(a => a.artworkId === message.data.artworkId);
      if (exists >= 0) {
        queue[exists] = message.data; // Update existing
      } else {
        queue.push(message.data);
      }
      chrome.storage.local.set({ artworkQueue: queue }, () => {
        updateBadge(queue.length);
        sendResponse({ success: true, queueLength: queue.length });
      });
    });
    return true;
  }

  // Get the full queue
  if (message.action === 'getQueue') {
    chrome.storage.local.get({ artworkQueue: [] }, (result) => {
      sendResponse({ data: result.artworkQueue });
    });
    return true;
  }

  // Remove one item from queue by artworkId
  if (message.action === 'removeFromQueue') {
    chrome.storage.local.get({ artworkQueue: [] }, (result) => {
      const queue = result.artworkQueue.filter(a => a.artworkId !== message.artworkId);
      chrome.storage.local.set({ artworkQueue: queue }, () => {
        updateBadge(queue.length);
        sendResponse({ success: true, queueLength: queue.length });
      });
    });
    return true;
  }

  // Reorder queue
  if (message.action === 'reorderQueue') {
    chrome.storage.local.set({ artworkQueue: message.queue }, () => {
      updateBadge(message.queue.length);
      sendResponse({ success: true });
    });
    return true;
  }

  // Clear entire queue
  if (message.action === 'clearQueue') {
    chrome.storage.local.set({ artworkQueue: [] }, () => {
      updateBadge(0);
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

  // Download image (for Pixiv content script to use)
  if (message.action === 'downloadImage') {
    fetch(message.url, { mode: 'cors' })
      .then(res => res.blob())
      .then(blob => {
        const reader = new FileReader();
        reader.onloadend = () => sendResponse({ success: true, dataUrl: reader.result });
        reader.readAsDataURL(blob);
      })
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

function updateBadge(count) {
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: '#FF6B35' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// Restore badge on startup
chrome.storage.local.get({ artworkQueue: [] }, (result) => {
  updateBadge(result.artworkQueue.length);
});
