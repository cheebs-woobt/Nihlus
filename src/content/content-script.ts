// Smoke-check content script. Logs once per page-load so the user can
// verify the script is wired into every <all_urls> tab. Anything beyond
// this banner belongs to a later phase.

console.log("Nihlus content script active on:", window.location.href);
