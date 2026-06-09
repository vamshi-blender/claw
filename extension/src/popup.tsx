import React from "react"
import { createRoot } from "react-dom/client"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"

import { ExtensionThemeProvider } from "./extension-theme-provider"
import "./popup.css"

const PRODUCTION_BACKEND_URL = "https://claw-mocha.vercel.app"
const DEFAULT_DEV_BACKEND_URL = "http://localhost:3000"
const DEFAULT_BACKEND_URL = PRODUCTION_BACKEND_URL

type StatusTone = "neutral" | "success" | "error"
type BackendMode = "production" | "dev"

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
  const [savedBackendUrl, setSavedBackendUrl] =
    React.useState(DEFAULT_BACKEND_URL)
  const [backendMode, setBackendMode] =
    React.useState<BackendMode>("production")
  const [devBackendUrl, setDevBackendUrl] = React.useState(
    DEFAULT_DEV_BACKEND_URL
  )
  const [status, setStatus] = React.useState<{
    message: string
    tone: StatusTone
  }>({
    message: "",
    tone: "neutral",
  })
  const [isTesting, setIsTesting] = React.useState(false)

  React.useEffect(() => {
    void getBackendUrl().then((storedBackendUrl) => {
      setSavedBackendUrl(storedBackendUrl)

      if (storedBackendUrl === PRODUCTION_BACKEND_URL) {
        setBackendMode("production")
        return
      }

      setBackendMode("dev")
      setDevBackendUrl(storedBackendUrl)
    })
  }, [])

  const selectedBackendUrl =
    backendMode === "production" ? PRODUCTION_BACKEND_URL : devBackendUrl
  const hasChanges = selectedBackendUrl !== savedBackendUrl

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    try {
      const savedUrl = await saveBackendUrl(selectedBackendUrl)
      setSavedBackendUrl(savedUrl)
      if (backendMode === "dev") {
        setDevBackendUrl(savedUrl)
      }
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
      const backendUrl = normalizeBackendUrl(selectedBackendUrl)

      const response = await fetch(`${backendUrl}/api/health`)
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
        <FieldGroup>
          <FieldSet>
            <FieldLegend>Backend URL</FieldLegend>
            <RadioGroup
              value={backendMode}
              onValueChange={(value) => setBackendMode(value as BackendMode)}
            >
              <FieldLabel htmlFor="backend-production">
                <Field orientation="horizontal">
                  <RadioGroupItem
                    id="backend-production"
                    value="production"
                  />
                  <FieldContent>
                    <FieldTitle>Production</FieldTitle>
                    <FieldDescription>
                      {PRODUCTION_BACKEND_URL}
                    </FieldDescription>
                  </FieldContent>
                </Field>
              </FieldLabel>

              <FieldLabel htmlFor="backend-dev">
                <Field orientation="horizontal">
                  <RadioGroupItem id="backend-dev" value="dev" />
                  <FieldContent>
                    <FieldTitle>Development</FieldTitle>
                    <FieldDescription>
                      Use a local or preview URL.
                    </FieldDescription>
                  </FieldContent>
                </Field>
              </FieldLabel>
            </RadioGroup>
          </FieldSet>

          <Field data-disabled={backendMode !== "dev"}>
            <FieldLabel htmlFor="dev-backend-url">Development URL</FieldLabel>
            <Input
              id="dev-backend-url"
              name="devBackendUrl"
              value={devBackendUrl}
              placeholder={DEFAULT_DEV_BACKEND_URL}
              autoComplete="off"
              disabled={backendMode !== "dev"}
              onChange={(event) => setDevBackendUrl(event.target.value)}
            />
          </Field>
        </FieldGroup>

        <div className="grid grid-cols-2 gap-2">
          <Button type="submit" disabled={!hasChanges}>
            Save
          </Button>
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
