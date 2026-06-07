export type ChatRole = "user" | "assistant" | "system"

export type SessionStatus = "idle" | "running" | "error"

export type RunStatus = "running" | "completed" | "failed"

export type ToolCallStatus = "queued" | "running" | "completed" | "failed"

export type BrowserToolName =
  | "tabs_context"
  | "tabs_create"
  | "navigate"
  | "resize_window"
  | "get_page_text"
  | "read_page"
  | "find"
  | "form_input"
  | "computer"
  | "upload_image"
  | "file_upload"
  | "read_console_messages"
  | "read_network_requests"
  | "javascript_tool"
  | "turn_answer_start"

export type ChatMessage = {
  id: string
  sessionId: string
  role: ChatRole
  content: string
  createdAt: string
}

export type AgentRunRecord = {
  id: string
  sessionId: string
  status: RunStatus
  agentName: string
  model: string
  startedAt: string
  completedAt?: string
  error?: string
  lastResponseId?: string
  traceId?: string
}

export type ExtensionConnection = {
  windowId: number
  connectedAt: string
  lastSeenAt: string
}

export type ToolCallRecord = {
  id: string
  sessionId: string
  runId: string
  name: BrowserToolName
  status: ToolCallStatus
  input: unknown
  output?: unknown
  error?: string
  createdAt: string
  startedAt?: string
  completedAt?: string
}

export type PendingToolRequest = {
  id: string
  sessionId: string
  runId: string
  name: BrowserToolName
  input: unknown
  createdAt: string
}

export type ToolResultPayload = {
  ok: boolean
  output?: unknown
  error?: string
}

export type ChatSession = {
  id: string
  title: string
  status: SessionStatus
  createdAt: string
  updatedAt: string
  lastMessageAt?: string
  lastRunId?: string
  error?: string
}

export type SessionSummary = ChatSession & {
  messageCount: number
  toolCallCount: number
  lastRun?: AgentRunRecord
}

export type SessionDetail = ChatSession & {
  messages: ChatMessage[]
  runs: AgentRunRecord[]
  toolCalls: ToolCallRecord[]
  extension?: ExtensionConnection
}

export type CreateSessionResponse = {
  session: SessionDetail
}

export type ListSessionsResponse = {
  sessions: SessionSummary[]
}

export type GetSessionResponse = {
  session: SessionDetail
}
