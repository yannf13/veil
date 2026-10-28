// The vault lives in chrome.storage.session: kept in memory only, never written to disk,
// and cleared when the browser closes. By default only extension pages can read it;
// this lets Veil's own content scripts read it too (page scripts never can).
const allowContentScripts = (): void => {
  chrome.storage.session
    .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
    .catch((err: unknown) => console.error('Veil: could not open session storage to content scripts', err));
};

chrome.runtime.onInstalled.addListener(allowContentScripts);
chrome.runtime.onStartup.addListener(allowContentScripts);
allowContentScripts();
