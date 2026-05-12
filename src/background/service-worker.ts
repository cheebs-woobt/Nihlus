// MV3 service worker. Two smoke-check listeners for the scaffold:
//   - onInstalled fires once per install/update so the install log
//     surfaces the moment the extension is loaded unpacked.
//   - onUpdated fires every time a tab transitions through any state
//     (loading, complete, title change). We log only when the URL is
//     present so the noisy in-progress events stay quiet.

chrome.runtime.onInstalled.addListener(() => {
  console.log("Nihlus service worker installed");
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.url !== undefined) {
    console.log("Nihlus tab updated:", changeInfo.url);
    return;
  }
  if (tab.url !== undefined && changeInfo.status === "complete") {
    console.log("Nihlus tab updated:", tab.url);
  }
});
