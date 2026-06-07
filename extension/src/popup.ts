import "./popup.css"

const DEFAULT_BACKEND_URL = "http://localhost:3000"

const form = document.querySelector<HTMLFormElement>("#backend-form")
const input = document.querySelector<HTMLInputElement>("#backend-url")
const statusEl = document.querySelector<HTMLParagraphElement>("#status")
const testButton = document.querySelector<HTMLButtonElement>("#test-connection")

function setStatus(message: string, tone: "neutral" | "success" | "error" = "neutral") {
  if (!statusEl) {
    return
  }

  statusEl.textContent = message
  statusEl.dataset.tone = tone
}

function normalizeBackendUrl(value: string) {
  const url = new URL(value.trim())

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Use an http or https URL.")
  }

  url.pathname = url.pathname.replace(/\/+$/, "")
  url.search = ""
  url.hash = ""

  return url.toString().replace(/\/$/, "")
}

async function getBackendUrl() {
  const items = await chrome.storage.sync.get(["backendUrl"])
  return typeof items.backendUrl === "string" ? items.backendUrl : DEFAULT_BACKEND_URL
}

async function saveBackendUrl(value: string) {
  const backendUrl = normalizeBackendUrl(value)
  await chrome.storage.sync.set({ backendUrl })
  return backendUrl
}

async function loadBackendUrl() {
  if (!input) {
    return
  }

  input.value = await getBackendUrl()
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault()

  if (!input) {
    return
  }

  try {
    const backendUrl = await saveBackendUrl(input.value)
    input.value = backendUrl
    setStatus("Backend URL saved.", "success")
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Unable to save URL.", "error")
  }
})

testButton?.addEventListener("click", async () => {
  if (!input || !testButton) {
    return
  }

  testButton.disabled = true
  setStatus("Testing connection...")

  try {
    const backendUrl = await saveBackendUrl(input.value)
    input.value = backendUrl

    const response = await fetch(`${backendUrl}/api/health`)
    if (!response.ok) {
      throw new Error(`Health check failed with ${response.status}.`)
    }

    const data = (await response.json()) as { ok?: boolean; service?: string }
    if (!data.ok) {
      throw new Error("Health check returned an unexpected response.")
    }

    setStatus(`Connected to ${data.service ?? "backend"}.`, "success")
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Connection failed.", "error")
  } finally {
    testButton.disabled = false
  }
})

void loadBackendUrl()
