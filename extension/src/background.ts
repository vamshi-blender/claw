chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(["backendUrl"], (items) => {
    if (!items.backendUrl) {
      chrome.storage.sync.set({ backendUrl: "http://localhost:3000" })
    }
  })

  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
})

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.windowId) {
    await chrome.sidePanel.open({ windowId: tab.windowId })
  }
})
