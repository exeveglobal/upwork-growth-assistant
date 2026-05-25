// Service worker for the Upwork Growth Assistant Chrome Extension

chrome.runtime.onInstalled.addListener(() => {
  // Enable opening the side panel on clicking the extension icon
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .then(() => {
      console.log("Upwork Growth Assistant side panel behavior configured successfully.");
    })
    .catch((error) => {
      console.error("Error configuring side panel behavior:", error);
    });
});
