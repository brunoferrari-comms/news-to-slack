// background.js - PaxNews service worker
// Adds right-click context menus and forwards them to the content script.

try {
  importScripts('config.js');
} catch (e) {
  console.error('[Background] Failed to load config.js', e);
}

console.log('[Background] PaxNews script loaded');

async function ensureContentScriptInjected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    return true;
  } catch (error) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['config.js', 'content.js']
      });
      return true;
    } catch (injectError) {
      console.error('[Background] Failed to inject content script:', injectError);
      return false;
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Background] PaxNews installed');

  chrome.contextMenus.create({
    id: 'paxnewsAnalyzePage',
    title: 'Send page to PaxNews 📰',
    contexts: ['page']
  });

  chrome.contextMenus.create({
    id: 'paxnewsAnalyzeSelection',
    title: 'Send selection to PaxNews 📰',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId !== 'paxnewsAnalyzePage' && info.menuItemId !== 'paxnewsAnalyzeSelection') {
    return;
  }

  try {
    const tabInfo = await chrome.tabs.get(tab.id);
    if (tabInfo.status !== 'complete') {
      console.warn('[Background] Tab not complete, skipping');
      return;
    }

    const isInjected = await ensureContentScriptInjected(tab.id);
    if (!isInjected) {
      console.error('[Background] Could not inject content script');
      return;
    }

    setTimeout(async () => {
      try {
        const message =
          info.menuItemId === 'paxnewsAnalyzeSelection'
            ? { action: 'analyzeSelection', selectedText: info.selectionText }
            : { action: 'analyzePage' };

        const response = await chrome.tabs.sendMessage(tab.id, message);
        console.log('[Background] Message response:', response);
      } catch (error) {
        console.error('[Background] Message error:', error);
      }
    }, 100);
  } catch (error) {
    console.error('[Background] Error:', error);
  }
});
