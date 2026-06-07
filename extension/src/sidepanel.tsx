import React from "react"
import { createRoot } from "react-dom/client"

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
    <main className="sidepanel">
      <header className="topbar">
        <div>
          <h1>Browser Agent</h1>
          <p>{backendUrl}</p>
        </div>
        <button
          className="icon-button"
          type="button"
          title="Start new session"
          onClick={() => void createSession()}
          disabled={isStreaming}
        >
          +
        </button>
      </header>

      {error ? <div className="error">{error}</div> : null}

      <div ref={messageListRef} className="messages">
        {messages.length === 0 ? (
          <div className="empty">
            <h2>Ask the backend agent</h2>
            <p>This chat streams responses from the saved backend URL.</p>
          </div>
        ) : (
          messages.map((message) => (
            <article key={message.id} className={`message ${message.role}`}>
              <div className="bubble">
                {message.content ? (
                  message.content
                ) : (
                  <span className="streaming">Thinking...</span>
                )}
              </div>
            </article>
          ))
        )}
      </div>

      <form className="composer" onSubmit={sendMessage}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Message the agent"
          rows={3}
          disabled={isStreaming || !sessionId}
        />
        <button type="submit" disabled={isStreaming || !input.trim() || !sessionId}>
          {isStreaming ? "Sending" : "Send"}
        </button>
      </form>
    </main>
  )
}

createRoot(document.querySelector("#root")!).render(<App />)
