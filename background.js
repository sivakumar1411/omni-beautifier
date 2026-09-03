/**
 * Beautifier service worker.
 *
 * The extension is a single page, so all this does is open it — from the
 * toolbar button, or from a right-click on selected text (which arrives via
 * chrome.storage so the page can pick it up on load).
 */
const PAGE_URL = chrome.runtime.getURL('beautify.html');

/**
 * Open (or re-focus) the Beautifier page immediately to the right of the tab
 * you were on, rather than at the end of the strip.
 *
 * Both the toolbar click and the keyboard shortcut land here: a shortcut bound
 * to Chrome's "Activate the extension" fires _execute_action, which dispatches
 * chrome.action.onClicked for extensions without a popup.
 */
function openPage(paramString) {
  const url = PAGE_URL + (paramString || '');

  chrome.tabs.query({ active: true, currentWindow: true }, (activeTabs) => {
    const anchor = activeTabs && activeTabs[0];

    chrome.tabs.query({ url: PAGE_URL + '*' }, (existing) => {
      const reuse = existing && existing[0];

      if (reuse) {
        const focus = () => {
          chrome.tabs.update(reuse.id, { active: true, url });
          chrome.windows.update(reuse.windowId, { focused: true });
        };
        // Only reposition within the same window; yanking a tab across windows
        // would be more disruptive than leaving it where it is.
        if (anchor && reuse.windowId === anchor.windowId && reuse.id !== anchor.id) {
          // Chrome applies the move index *after* removing the tab, so a tab
          // currently left of the anchor needs one less to land on its right.
          const target = reuse.index < anchor.index ? anchor.index : anchor.index + 1;
          if (reuse.index !== target) {
            chrome.tabs.move(reuse.id, { index: target }, focus);
            return;
          }
        }
        focus();
        return;
      }

      chrome.tabs.create({
        url,
        index: anchor ? anchor.index + 1 : undefined,
        openerTabId: anchor ? anchor.id : undefined
      });
    });
  });
}

chrome.action.onClicked.addListener(() => openPage());

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'beautify-selection',
      title: 'Beautify selected text',
      contexts: ['selection']
    });
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== 'beautify-selection' || !info.selectionText) return;
  // Selections can be far larger than a URL will carry, so hand it over
  // through storage and let the page collect it.
  chrome.storage.local.set({ pendingInput: info.selectionText }, () => openPage('?pending=1'));
});
