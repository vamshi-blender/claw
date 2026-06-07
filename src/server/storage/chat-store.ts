import { MemorySession, type Session } from "@openai/agents"

import type {
  AgentRunRecord,
  ChatMessage,
  ChatSession,
  RunStatus,
  SessionDetail,
  SessionStatus,
  SessionSummary,
} from "@/types/chat"

type StoredSession = ChatSession & {
  sdkSession: Session
}

type ChatStoreState = {
  sessions: Map<string, StoredSession>
  messages: Map<string, ChatMessage[]>
  runs: Map<string, AgentRunRecord[]>
}

const globalForChatStore = globalThis as typeof globalThis & {
  __browserAgentChatStore?: ChatStoreState
}

function getState() {
  if (!globalForChatStore.__browserAgentChatStore) {
    globalForChatStore.__browserAgentChatStore = {
      sessions: new Map(),
      messages: new Map(),
      runs: new Map(),
    }
  }

  return globalForChatStore.__browserAgentChatStore
}

function now() {
  return new Date().toISOString()
}

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`
}

function toDetail(session: StoredSession): SessionDetail {
  const state = getState()
  const publicSession = withoutSdkSession(session)

  return {
    ...publicSession,
    messages: state.messages.get(session.id) ?? [],
    runs: state.runs.get(session.id) ?? [],
  }
}

function withoutSdkSession(session: StoredSession): ChatSession {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastMessageAt: session.lastMessageAt,
    lastRunId: session.lastRunId,
    error: session.error,
  }
}

export const chatStore = {
  createSession() {
    const state = getState()
    const timestamp = now()
    const sessionId = createId("ses")

    const session: StoredSession = {
      id: sessionId,
      title: "New session",
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
      sdkSession: new MemorySession({ sessionId }),
    }

    state.sessions.set(session.id, session)
    state.messages.set(session.id, [])
    state.runs.set(session.id, [])

    return toDetail(session)
  },

  getOrCreateSession(sessionId?: string) {
    const state = getState()

    if (sessionId) {
      const existing = state.sessions.get(sessionId)
      if (existing) {
        return toDetail(existing)
      }
    }

    return this.createSession()
  },

  getSession(sessionId: string) {
    const session = getState().sessions.get(sessionId)
    return session ? toDetail(session) : null
  },

  getSdkSession(sessionId: string) {
    return getState().sessions.get(sessionId)?.sdkSession ?? null
  },

  listSessions(): SessionSummary[] {
    const state = getState()

    return Array.from(state.sessions.values())
      .map((session) => {
        const runs = state.runs.get(session.id) ?? []
        return {
          ...withoutSdkSession(session),
          messageCount: state.messages.get(session.id)?.length ?? 0,
          lastRun: runs.at(-1),
        }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  },

  addMessage(input: Pick<ChatMessage, "sessionId" | "role" | "content">) {
    const state = getState()
    const session = state.sessions.get(input.sessionId)
    if (!session) {
      return null
    }

    const timestamp = now()
    const message: ChatMessage = {
      id: createId("msg"),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      createdAt: timestamp,
    }

    const messages = state.messages.get(input.sessionId) ?? []
    messages.push(message)
    state.messages.set(input.sessionId, messages)

    if (session.title === "New session" && input.role === "user") {
      session.title = input.content.slice(0, 60) || "New session"
    }

    session.updatedAt = timestamp
    session.lastMessageAt = timestamp
    session.error = undefined

    return message
  },

  createRun(input: Pick<AgentRunRecord, "sessionId" | "agentName" | "model">) {
    const state = getState()
    const timestamp = now()
    const run: AgentRunRecord = {
      id: createId("run"),
      sessionId: input.sessionId,
      status: "running",
      agentName: input.agentName,
      model: input.model,
      startedAt: timestamp,
      traceId: createId("trace"),
    }

    const runs = state.runs.get(input.sessionId) ?? []
    runs.push(run)
    state.runs.set(input.sessionId, runs)

    this.updateSession(input.sessionId, {
      status: "running",
      lastRunId: run.id,
      updatedAt: timestamp,
      error: undefined,
    })

    return run
  },

  updateRun(
    sessionId: string,
    runId: string,
    updates: Partial<Pick<AgentRunRecord, "status" | "completedAt" | "error" | "lastResponseId">>,
  ) {
    const runs = getState().runs.get(sessionId)
    const run = runs?.find((item) => item.id === runId)
    if (!run) {
      return null
    }

    Object.assign(run, updates)
    return run
  },

  updateSession(
    sessionId: string,
    updates: Partial<
      Pick<ChatSession, "status" | "updatedAt" | "lastRunId" | "error" | "lastMessageAt">
    >,
  ) {
    const session = getState().sessions.get(sessionId)
    if (!session) {
      return null
    }

    Object.assign(session, updates)
    return toDetail(session)
  },

  setSessionStatus(sessionId: string, status: SessionStatus, error?: string) {
    return this.updateSession(sessionId, {
      status,
      error,
      updatedAt: now(),
    })
  },

  completeRun(sessionId: string, runId: string, status: RunStatus, error?: string) {
    const timestamp = now()
    const run = this.updateRun(sessionId, runId, {
      status,
      completedAt: timestamp,
      error,
    })

    this.updateSession(sessionId, {
      status: status === "failed" ? "error" : "idle",
      error,
      updatedAt: timestamp,
    })

    return run
  },
}
