chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(["backendUrl"], (items) => {
    if (!items.backendUrl) {
      chrome.storage.sync.set({ backendUrl: "http://localhost:3000" })
    }
  })
})
