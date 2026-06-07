import React from "react"
import { createRoot } from "react-dom/client"
import { Plus } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogContent,
  // AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"

import { ExtensionThemeProvider } from "./extension-theme-provider"
import "./sidepanel.css"

type ChatRole = "user" | "assistant"

type ChatMessage = {
  id: string
  role: ChatRole
  content: string
}

type SessionDetail = {
  id: string
  title: string
  messages: Array<{
    id: string
    role: ChatRole | "system"
    content: string
  }>
}

const DEFAULT_BACKEND_URL = "http://localhost:3000"

function createLocalId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`
}

function normalizeBackendUrl(value: string) {
  return value.replace(/\/+$/, "")
}

function isChatMessageRole(role: string): role is ChatRole {
  return role === "user" || role === "assistant"
}

async function getBackendUrl() {
  const items = await chrome.storage.sync.get(["backendUrl"])
  return normalizeBackendUrl(
    typeof items.backendUrl === "string" ? items.backendUrl : DEFAULT_BACKEND_URL,
  )
}

async function getStoredSessionId() {
  const items = await chrome.storage.session.get(["chatSessionId"])
  return typeof items.chatSessionId === "string" ? items.chatSessionId : undefined
}

async function setStoredSessionId(sessionId: string) {
  await chrome.storage.session.set({ chatSessionId: sessionId })
}

function App() {
  const [backendUrl, setBackendUrl] = React.useState(DEFAULT_BACKEND_URL)
  const [sessionId, setSessionId] = React.useState<string>()
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [input, setInput] = React.useState("")
  const [isInitializing, setIsInitializing] = React.useState(true)
  const [isStreaming, setIsStreaming] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const messageListRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    async function bootstrap() {
      try {
        const url = await getBackendUrl()
        setBackendUrl(url)

        const storedSessionId = await getStoredSessionId()
        if (storedSessionId) {
          const response = await fetch(`${url}/api/sessions/${storedSessionId}`)
          if (response.ok) {
            const data = (await response.json()) as { session: SessionDetail }
            setSessionId(data.session.id)
            setMessages(
              data.session.messages
                .filter((message): message is ChatMessage =>
                  isChatMessageRole(message.role),
                )
                .map((message) => ({
                  id: message.id,
                  role: message.role,
                  content: message.content,
                })),
            )
            return
          }
        }

        const response = await fetch(`${url}/api/sessions`, { method: "POST" })
        if (!response.ok) {
          throw new Error(`Unable to create session (${response.status}).`)
        }

        const data = (await response.json()) as { session: SessionDetail }
        setSessionId(data.session.id)
        await setStoredSessionId(data.session.id)
        setMessages([])
      } catch (bootstrapError) {
        setError(
          bootstrapError instanceof Error
            ? bootstrapError.message
            : "Unable to initialize chat.",
        )
      } finally {
        setIsInitializing(false)
      }
    }

    void bootstrap()
  }, [])

  React.useEffect(() => {
    messageListRef.current?.scrollTo({
      top: messageListRef.current.scrollHeight,
      behavior: "smooth",
    })
  }, [messages, isStreaming])

  async function createSession(url = backendUrl) {
    const response = await fetch(`${url}/api/sessions`, { method: "POST" })
    if (!response.ok) {
      throw new Error(`Unable to create session (${response.status}).`)
    }

    const data = (await response.json()) as { session: SessionDetail }
    setSessionId(data.session.id)
    await setStoredSessionId(data.session.id)
    setMessages([])
  }

  async function sendMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const content = input.trim()
    if (!content || !sessionId || isStreaming) {
      return
    }

    const assistantId = createLocalId("assistant")
    setInput("")
    setError(undefined)
    setIsStreaming(true)
    setMessages((current) => [
      ...current,
      { id: createLocalId("user"), role: "user", content },
      { id: assistantId, role: "assistant", content: "" },
    ])

    try {
      const response = await fetch(`${backendUrl}/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: content }),
      })

      if (!response.ok || !response.body) {
        const text = await response.text()
        throw new Error(text || `Message failed (${response.status}).`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }

        const chunk = decoder.decode(value, { stream: true })
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? { ...message, content: message.content + chunk }
              : message,
          ),
        )
      }
    } catch (sendError) {
      const message =
        sendError instanceof Error ? sendError.message : "Unable to send message."
      setError(message)
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantId && !item.content
            ? { ...item, content: `Error: ${message}` }
            : item,
        ),
      )
    } finally {
      setIsStreaming(false)
    }
  }

  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      <AlertDialog open={isInitializing}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Spinner className="size-5" />
            </AlertDialogMedia>
            <AlertDialogTitle>Connecting to the backend</AlertDialogTitle>
            {/* <AlertDialogDescription>
              Preparing your browser agent session. The chat composer will unlock
              as soon as the saved backend URL responds.
            </AlertDialogDescription> */}
          </AlertDialogHeader>
        </AlertDialogContent>
      </AlertDialog>

      <header className="flex items-center justify-between gap-3 border-b bg-card p-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold tracking-normal">Browser Agent</h1>
          <p className="truncate text-xs text-muted-foreground">{backendUrl}</p>
        </div>
        <Button
          variant="outline"
          size="icon"
          type="button"
          title="Start new session"
          onClick={() => void createSession()}
          disabled={isStreaming}
        >
          <Plus />
        </Button>
      </header>

      {error ? (
        <Alert variant="destructive" className="m-3 mb-0">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div
        ref={messageListRef}
        className="min-h-0 flex-1 overflow-y-auto p-3"
      >
        {messages.length === 0 ? (
          <div className="flex min-h-full flex-col justify-center gap-1 text-center">
            <h2 className="text-base font-semibold tracking-normal">
              Ask the backend agent
            </h2>
            <p className="text-sm text-muted-foreground">
              This chat streams responses from the saved backend URL.
            </p>
          </div>
        ) : (
          messages.map((message) => (
            <article
              key={message.id}
              className={
                message.role === "user"
                  ? "my-2 flex justify-end"
                  : "my-2 flex justify-start"
              }
            >
              <div
                className={
                  message.role === "user"
                    ? "max-w-[86%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm leading-6 text-primary-foreground"
                    : "max-w-[86%] whitespace-pre-wrap rounded-lg border bg-card px-3 py-2 text-sm leading-6"
                }
              >
                {message.content ? (
                  message.content
                ) : (
                  <span className="text-muted-foreground">Thinking...</span>
                )}
              </div>
            </article>
          ))
        )}
      </div>

      <form
        className="grid h-[92px] flex-none grid-cols-[1fr_auto] gap-2 border-t bg-card p-3"
        onSubmit={sendMessage}
      >
        <Textarea
          className="h-[68px] min-h-0 resize-none"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Message the agent"
          rows={3}
          disabled={isStreaming || !sessionId}
        />
        <Button
          className="self-end"
          type="submit"
          disabled={isStreaming || !input.trim() || !sessionId}
        >
          {isStreaming ? "Sending" : "Send"}
        </Button>
      </form>
    </main>
  )
}

createRoot(document.querySelector("#root")!).render(
  <ExtensionThemeProvider>
    <App />
  </ExtensionThemeProvider>,
)
