export type ChatRole = "user" | "assistant" | "system"

export type SessionStatus = "idle" | "running" | "error"

export type RunStatus = "running" | "completed" | "failed"

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
  lastRun?: AgentRunRecord
}

export type SessionDetail = ChatSession & {
  messages: ChatMessage[]
  runs: AgentRunRecord[]
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
