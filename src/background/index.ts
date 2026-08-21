// Service worker — Phase 0 stub. Will become the router in Phase 2.
console.log('[foodmask][sw] service worker booted');

chrome.runtime.onInstalled.addListener(() => {
  console.log('[foodmask][sw] onInstalled');
});
