import React from "react"
import { createRoot } from "react-dom/client"
import { Check, Copy, Plus, Send, Square } from "lucide-react"
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

function getMarkdownText(children: React.ReactNode) {
  if (Array.isArray(children)) {
    return children.map((child) => String(child)).join("")
  }
  return String(children ?? "")
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
  const messageAbortControllerRef = React.useRef<AbortController | null>(null)

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

    if (isStreaming) {
      messageAbortControllerRef.current?.abort()
      return
    }

    const content = input.trim()
    if (!content || !sessionId) {
      return
    }

    const abortController = new AbortController()
    const assistantId = createLocalId("assistant")
    messageAbortControllerRef.current = abortController
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
        signal: abortController.signal,
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
      if (abortController.signal.aborted) {
        setMessages((current) =>
          current.map((item) =>
            item.id === assistantId && !item.content
              ? { ...item, content: "Stopped." }
              : item,
          ),
        )
        return
      }

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
      if (messageAbortControllerRef.current === abortController) {
        messageAbortControllerRef.current = null
      }
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
                    ? "max-w-[86%] rounded-lg bg-primary px-3 py-2 text-sm leading-6 text-primary-foreground"
                    : "max-w-[86%] rounded-lg border bg-card px-3 py-2 text-sm leading-6"
                }
              >
                {message.content ? (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h1: ({ children }) => <h1 className="mb-2 text-base font-bold leading-tight break-words last:mb-0">{children}</h1>,
                      h2: ({ children }) => <h2 className="mb-2 text-sm font-semibold leading-tight break-words last:mb-0">{children}</h2>,
                      h3: ({ children }) => <h3 className="mb-1.5 text-[13px] font-semibold leading-snug break-words last:mb-0">{children}</h3>,
                      h4: ({ children }) => <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] break-words last:mb-0">{children}</h4>,
                      p: ({ children }) => <p className="mb-1 break-words last:mb-0">{children}</p>,
                      strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                      em: ({ children }) => <em className="italic">{children}</em>,
                      ul: ({ children }) => <ul className="mb-1 ml-4 list-disc space-y-1 last:mb-0">{children}</ul>,
                      ol: ({ children }) => <ol className="mb-1 ml-4 list-decimal space-y-1 last:mb-0">{children}</ol>,
                      li: ({ children }) => <li className="break-words marker:text-current">{children}</li>,
                      table: ({ children }) => (
                        <div className="mb-1 overflow-x-auto rounded-lg border border-current/10 last:mb-0">
                          <table className="min-w-full border-collapse text-left text-[11px] leading-relaxed">
                            {children}
                          </table>
                        </div>
                      ),
                      thead: ({ children }) => <thead className="bg-black/8">{children}</thead>,
                      tbody: ({ children }) => <tbody>{children}</tbody>,
                      tr: ({ children }) => <tr className="border-b border-current/10 last:border-b-0">{children}</tr>,
                      th: ({ children }) => <th className="px-2.5 py-1.5 font-semibold whitespace-nowrap">{children}</th>,
                      td: ({ children }) => <td className="px-2.5 py-1.5 align-top break-words">{children}</td>,
                      code: ({ children, className }) => {
                        const text = getMarkdownText(children)
                        const isBlock = Boolean(className) || text.includes("\n")
                        if (isBlock) {
                          return <code className="font-mono text-[11px] whitespace-pre-wrap break-words">{text.replace(/\n$/, "")}</code>
                        }
                        return <code className="rounded bg-black/10 px-1.5 py-0.5 font-mono text-[11px] break-all">{children}</code>
                      },
                      pre: ({ children }) => <pre className="mb-1 overflow-hidden rounded-lg bg-black/10 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words last:mb-0">{children}</pre>,
                      blockquote: ({ children }) => <blockquote className="mb-1 border-l-2 border-current/50 pl-3 opacity-85 last:mb-0">{children}</blockquote>,
                      hr: () => <hr className="my-2 border-current/15" />,
                      a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-2 opacity-85 hover:opacity-100">{children}</a>,
                    }}
                  >
                    {message.content}
                  </ReactMarkdown>
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
          size="icon"
          title={isStreaming ? "Stop response" : "Send message"}
          aria-label={isStreaming ? "Stop response" : "Send message"}
          disabled={isInitializing || !sessionId || (!isStreaming && !input.trim())}
        >
          {isStreaming ? <Square data-icon="inline-start" /> : <Send data-icon="inline-start" />}
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
