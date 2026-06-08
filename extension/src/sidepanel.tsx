import React from "react"
import { createRoot } from "react-dom/client"
import { Check, Copy, Plus } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

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
import type {
  PendingToolRequest,
  ToolCallRecord,
  ToolResultPayload,
} from "@/types/chat"

import { executeBrowserTool } from "./browser-tools"
import { ExtensionThemeProvider } from "./extension-theme-provider"
import "./sidepanel.css"

type ChatRole = "user" | "assistant"

type ChatMessage = {
  id: string
  role: ChatRole
  content: string
}

type SessionMessage = {
  id: string
  role: ChatRole | "system"
  content: string
  createdAt: string
}

type SessionDetail = {
  id: string
  title: string
  messages: SessionMessage[]
  toolCalls: ToolCallRecord[]
}

type StreamEvent =
  | { type: "text_delta"; delta: string }
  | {
      type: "tool_status"
      name?: string
      status?: string
      message?: string
      toolCallId?: string
    }
  | { type: "error"; message: string }
  | { type: "done" }

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

function isSessionChatMessage(
  message: SessionMessage,
): message is SessionMessage & { role: ChatRole } {
  return isChatMessageRole(message.role)
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

async function getLockedWindowId() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (typeof activeTab?.windowId === "number") {
    return activeTab.windowId
  }

  const currentWindow = await chrome.windows.getCurrent()
  if (typeof currentWindow.id === "number") {
    return currentWindow.id
  }

  throw new Error("Unable to identify the Chrome window for this side panel.")
}

async function connectExtensionSession(url: string, sessionId: string, windowId: number) {
  const response = await fetch(`${url}/api/extension/sessions/${sessionId}/connect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ windowId }),
  })

  if (!response.ok) {
    throw new Error(`Unable to connect extension session (${response.status}).`)
  }
}

function parseStreamEvents(buffer: string) {
  const events: StreamEvent[] = []
  const parts = buffer.split("\n\n")
  const remainder = parts.pop() ?? ""

  for (const part of parts) {
    const eventLine = part
      .split("\n")
      .find((line) => line.startsWith("event: "))
    const dataLine = part
      .split("\n")
      .find((line) => line.startsWith("data: "))

    if (!eventLine || !dataLine) {
      continue
    }

    const type = eventLine.slice("event: ".length)
    const data = JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>
    events.push({ type, ...data } as StreamEvent)
  }

  return { events, remainder }
}

async function postToolResult(
  url: string,
  request: PendingToolRequest,
  result: ToolResultPayload,
) {
  await fetch(
    `${url}/api/extension/sessions/${request.sessionId}/tool-requests/${request.id}/result`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(result),
    },
  )
}

function stringifyDebugValue(value: unknown) {
  if (value === undefined) {
    return ""
  }

  if (typeof value === "string") {
    return value
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function buildDebugTranscript(session: SessionDetail) {
  const entries: Array<{
    timestamp: string
    sequence: number
    text: string
  }> = []
  let sequence = 0

  entries.push({
    timestamp: session.messages[0]?.createdAt ?? new Date().toISOString(),
    sequence: sequence++,
    text: [
      `# Browser Agent Debug Transcript`,
      `Session: ${session.id}`,
      `Title: ${session.title}`,
      "",
    ].join("\n"),
  })

  for (const message of session.messages) {
    entries.push({
      timestamp: message.createdAt,
      sequence: sequence++,
      text: [
        `## ${message.createdAt} MESSAGE ${message.role.toUpperCase()}`,
        message.content || "[empty]",
        "",
      ].join("\n"),
    })
  }

  for (const toolCall of session.toolCalls) {
    entries.push({
      timestamp: toolCall.createdAt,
      sequence: sequence++,
      text: [
        `## ${toolCall.createdAt} TOOL CALL ${toolCall.name}`,
        `id: ${toolCall.id}`,
        `run: ${toolCall.runId}`,
        `status: ${toolCall.status}`,
        "",
        "input:",
        stringifyDebugValue(toolCall.input) || "{}",
        "",
      ].join("\n"),
    })

    if (toolCall.completedAt || toolCall.output !== undefined || toolCall.error) {
      entries.push({
        timestamp: toolCall.completedAt ?? toolCall.createdAt,
        sequence: sequence++,
        text: [
          `## ${toolCall.completedAt ?? toolCall.createdAt} TOOL RESULT ${toolCall.name}`,
          `id: ${toolCall.id}`,
          `status: ${toolCall.status}`,
          "",
          toolCall.error ? `error:\n${toolCall.error}` : "output:",
          toolCall.error ? "" : stringifyDebugValue(toolCall.output) || "{}",
          "",
        ].join("\n"),
      })
    }
  }

  return entries
    .sort((a, b) => {
      const timeCompare = a.timestamp.localeCompare(b.timestamp)
      return timeCompare === 0 ? a.sequence - b.sequence : timeCompare
    })
    .map((entry) => entry.text)
    .join("\n")
}

function App() {
  const [backendUrl, setBackendUrl] = React.useState(DEFAULT_BACKEND_URL)
  const [sessionId, setSessionId] = React.useState<string>()
  const [lockedWindowId, setLockedWindowId] = React.useState<number>()
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [input, setInput] = React.useState("")
  const [isInitializing, setIsInitializing] = React.useState(true)
  const [isStreaming, setIsStreaming] = React.useState(false)
  const [isCopied, setIsCopied] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [toolStatus, setToolStatus] = React.useState<string>()
  const messageListRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    async function bootstrap() {
      try {
        const url = await getBackendUrl()
        const windowId = await getLockedWindowId()
        setBackendUrl(url)
        setLockedWindowId(windowId)

        const storedSessionId = await getStoredSessionId()
        if (storedSessionId) {
          const response = await fetch(`${url}/api/sessions/${storedSessionId}`)
          if (response.ok) {
            const data = (await response.json()) as { session: SessionDetail }
            setSessionId(data.session.id)
            await connectExtensionSession(url, data.session.id, windowId)
            setMessages(
              data.session.messages
                .filter(isSessionChatMessage)
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
        await connectExtensionSession(url, data.session.id, windowId)
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
    if (!sessionId || !lockedWindowId) {
      return
    }

    const abortController = new AbortController()
    const windowId = lockedWindowId

    async function pollToolRequests() {
      while (!abortController.signal.aborted) {
        try {
          const response = await fetch(
            `${backendUrl}/api/extension/sessions/${sessionId}/tool-requests`,
            { signal: abortController.signal },
          )

          if (!response.ok) {
            await new Promise((resolve) => setTimeout(resolve, 1000))
            continue
          }

          const data = (await response.json()) as {
            request: PendingToolRequest | null
          }

          if (!data.request) {
            continue
          }

          setToolStatus(`Running ${data.request.name}`)
          const result = await executeBrowserTool(data.request, windowId)
          await postToolResult(backendUrl, data.request, result)
          setToolStatus(result.ok ? `Completed ${data.request.name}` : `Failed ${data.request.name}`)
        } catch (pollError) {
          if (abortController.signal.aborted) {
            return
          }
          setToolStatus(
            pollError instanceof Error
              ? `Tool bridge: ${pollError.message}`
              : "Tool bridge failed.",
          )
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }
    }

    void pollToolRequests()
    return () => abortController.abort()
  }, [backendUrl, lockedWindowId, sessionId])

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
    const windowId = lockedWindowId ?? (await getLockedWindowId())
    setLockedWindowId(windowId)
    await connectExtensionSession(url, data.session.id, windowId)
    setMessages([])
  }

  async function copyDebugTranscript() {
    if (!sessionId) {
      return
    }

    try {
      setError(undefined)
      const response = await fetch(`${backendUrl}/api/sessions/${sessionId}`)
      if (!response.ok) {
        throw new Error(`Unable to load session debug data (${response.status}).`)
      }

      const data = (await response.json()) as { session: SessionDetail }
      await navigator.clipboard.writeText(buildDebugTranscript(data.session))
      setIsCopied(true)
      window.setTimeout(() => setIsCopied(false), 1500)
    } catch (copyError) {
      setError(
        copyError instanceof Error
          ? copyError.message
          : "Unable to copy debug transcript.",
      )
    }
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
      let streamBuffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }

        streamBuffer += decoder.decode(value, { stream: true })
        const parsed = parseStreamEvents(streamBuffer)
        streamBuffer = parsed.remainder

        for (const event of parsed.events) {
          if (event.type === "text_delta") {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantId
                  ? { ...message, content: message.content + event.delta }
                  : message,
              ),
            )
          }

          if (event.type === "tool_status") {
            setToolStatus(event.message ?? event.name ?? "Tool running")
          }

          if (event.type === "error") {
            throw new Error(event.message)
          }
        }
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
      setToolStatus(undefined)
    }
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return
    }

    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
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
          {lockedWindowId ? (
            <p className="text-xs text-muted-foreground">
              Window {lockedWindowId}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            type="button"
            title="Copy debug transcript"
            onClick={() => void copyDebugTranscript()}
            disabled={!sessionId}
          >
            {isCopied ? <Check /> : <Copy />}
          </Button>
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
        </div>
      </header>

      {error ? (
        <Alert variant="destructive" className="m-3 mb-0">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {toolStatus ? (
        <div className="border-b px-3 py-2 text-xs text-muted-foreground">
          {toolStatus}
        </div>
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
                    : "max-w-[86%] rounded-lg border bg-card px-3 py-2 text-sm leading-6"
                }
              >
                {message.content ? (
                  message.role === "user" ? (
                    message.content
                  ) : (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                        em: ({ children }) => <em className="italic">{children}</em>,
                        code: ({ children, className }) => {
                          const isBlock = className?.includes("language-")
                          return isBlock ? (
                            <code className="block overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs">
                              {children}
                            </code>
                          ) : (
                            <code className="rounded bg-muted px-1 font-mono text-xs">{children}</code>
                          )
                        },
                        pre: ({ children }) => <pre className="mb-2 overflow-x-auto rounded bg-muted p-2">{children}</pre>,
                        ul: ({ children }) => <ul className="mb-2 list-disc pl-4">{children}</ul>,
                        ol: ({ children }) => <ol className="mb-2 list-decimal pl-4">{children}</ol>,
                        li: ({ children }) => <li className="mb-0.5">{children}</li>,
                        h1: ({ children }) => <h1 className="mb-1 text-base font-bold">{children}</h1>,
                        h2: ({ children }) => <h2 className="mb-1 text-sm font-bold">{children}</h2>,
                        h3: ({ children }) => <h3 className="mb-1 text-sm font-semibold">{children}</h3>,
                        a: ({ href, children }) => (
                          <a href={href} target="_blank" rel="noreferrer" className="underline">
                            {children}
                          </a>
                        ),
                        blockquote: ({ children }) => (
                          <blockquote className="mb-2 border-l-2 border-muted-foreground pl-2 text-muted-foreground">
                            {children}
                          </blockquote>
                        ),
                        hr: () => <hr className="my-2 border-border" />,
                        table: ({ children }) => (
                          <div className="mb-2 overflow-x-auto">
                            <table className="w-full border-collapse text-xs">{children}</table>
                          </div>
                        ),
                        th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-semibold">{children}</th>,
                        td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
                      }}
                    >
                      {message.content}
                    </ReactMarkdown>
                  )
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
          onKeyDown={handleComposerKeyDown}
          placeholder="Message the agent"
          rows={3}
          disabled={isInitializing || isStreaming || !sessionId}
          aria-label="Message the agent"
        />
        <Button
          className="self-end"
          type="submit"
          disabled={isInitializing || isStreaming || !input.trim() || !sessionId}
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
