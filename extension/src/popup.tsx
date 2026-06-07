import React from "react"
import { createRoot } from "react-dom/client"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

import { ExtensionThemeProvider } from "./extension-theme-provider"
import "./popup.css"

const DEFAULT_BACKEND_URL = "http://localhost:3000"

type StatusTone = "neutral" | "success" | "error"

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

function App() {
  const [backendUrl, setBackendUrl] = React.useState(DEFAULT_BACKEND_URL)
  const [status, setStatus] = React.useState<{
    message: string
    tone: StatusTone
  }>({
    message: "",
    tone: "neutral",
  })
  const [isTesting, setIsTesting] = React.useState(false)

  React.useEffect(() => {
    void getBackendUrl().then(setBackendUrl)
  }, [])

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    try {
      const savedUrl = await saveBackendUrl(backendUrl)
      setBackendUrl(savedUrl)
      setStatus({ message: "Backend URL saved.", tone: "success" })
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "Unable to save URL.",
        tone: "error",
      })
    }
  }

  async function testConnection() {
    setIsTesting(true)
    setStatus({ message: "Testing connection...", tone: "neutral" })

    try {
      const savedUrl = await saveBackendUrl(backendUrl)
      setBackendUrl(savedUrl)

      const response = await fetch(`${savedUrl}/api/health`)
      if (!response.ok) {
        throw new Error(`Health check failed with ${response.status}.`)
      }

      const data = (await response.json()) as { ok?: boolean; service?: string }
      if (!data.ok) {
        throw new Error("Health check returned an unexpected response.")
      }

      setStatus({
        message: `Connected to ${data.service ?? "backend"}.`,
        tone: "success",
      })
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "Connection failed.",
        tone: "error",
      })
    } finally {
      setIsTesting(false)
    }
  }

  return (
    <main className="flex flex-col gap-4 p-4">
      <div>
        <h1 className="text-lg font-semibold tracking-normal">
          Backend connection
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Set the Next.js backend this extension should connect to.
        </p>
      </div>

      <form className="flex flex-col gap-3" onSubmit={handleSave}>
        <div className="grid gap-2">
          <Label htmlFor="backend-url">Backend URL</Label>
          <Input
            id="backend-url"
            name="backendUrl"
            value={backendUrl}
            placeholder="http://localhost:3000"
            autoComplete="off"
            onChange={(event) => setBackendUrl(event.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button type="submit">Save</Button>
          <Button
            type="button"
            variant="outline"
            disabled={isTesting}
            onClick={() => void testConnection()}
          >
            Test connection
          </Button>
        </div>
      </form>

      <div role="status" aria-live="polite" className="min-h-8">
        {status.message ? (
          <Alert variant={status.tone === "error" ? "destructive" : "default"}>
            <AlertDescription
              className={
                status.tone === "success" ? "text-emerald-700" : undefined
              }
            >
              {status.message}
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
    </main>
  )
}

createRoot(document.querySelector("#root")!).render(
  <ExtensionThemeProvider>
    <App />
  </ExtensionThemeProvider>,
)
