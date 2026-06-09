import { MemorySession, type Session } from "@openai/agents"

import type {
  AgentRunRecord,
  ChatMessage,
  ChatSession,
  BrowserToolName,
  ExtensionConnection,
  PendingToolRequest,
  RunStatus,
  SessionDetail,
  SessionStatus,
  SessionSummary,
  ToolCallRecord,
  ToolCallStatus,
  ToolResultPayload,
} from "@/types/chat"

type StoredSession = ChatSession & {
  sdkSession: Session
  extension?: ExtensionConnection
}

type ChatStoreState = {
  sessions: Map<string, StoredSession>
  messages: Map<string, ChatMessage[]>
  runs: Map<string, AgentRunRecord[]>
  toolCalls: Map<string, ToolCallRecord[]>
  pendingToolRequests: Map<string, PendingToolRequest[]>
  toolResultWaiters: Map<
    string,
    {
      resolve: (result: ToolResultPayload) => void
      reject: (error: Error) => void
      timeout: ReturnType<typeof setTimeout>
    }
  >
  toolRequestWaiters: Map<string, Array<(request: PendingToolRequest | null) => void>>
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
      toolCalls: new Map(),
      pendingToolRequests: new Map(),
      toolResultWaiters: new Map(),
      toolRequestWaiters: new Map(),
    }
  }

  globalForChatStore.__browserAgentChatStore.toolCalls ??= new Map()
  globalForChatStore.__browserAgentChatStore.pendingToolRequests ??= new Map()
  globalForChatStore.__browserAgentChatStore.toolResultWaiters ??= new Map()
  globalForChatStore.__browserAgentChatStore.toolRequestWaiters ??= new Map()

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
    toolCalls: state.toolCalls.get(session.id) ?? [],
    extension: session.extension,
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
    state.toolCalls.set(session.id, [])
    state.pendingToolRequests.set(session.id, [])

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
        const toolCalls = state.toolCalls.get(session.id) ?? []
        return {
          ...withoutSdkSession(session),
          messageCount: state.messages.get(session.id)?.length ?? 0,
          lastRun: runs.at(-1),
          toolCallCount: toolCalls.length,
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

  connectExtension(sessionId: string, windowId: number) {
    const timestamp = now()
    const session = getState().sessions.get(sessionId)
    if (!session) {
      return null
    }

    session.extension = {
      windowId,
      connectedAt: session.extension?.connectedAt ?? timestamp,
      lastSeenAt: timestamp,
    }
    session.updatedAt = timestamp

    return toDetail(session)
  },

  touchExtension(sessionId: string) {
    const session = getState().sessions.get(sessionId)
    if (!session?.extension) {
      return null
    }

    session.extension.lastSeenAt = now()
    return session.extension
  },

  listToolCalls(sessionId: string) {
    return getState().toolCalls.get(sessionId) ?? []
  },

  createToolRequest(input: {
    sessionId: string
    runId: string
    name: BrowserToolName
    args: unknown
  }) {
    const state = getState()
    const timestamp = now()
    const request: PendingToolRequest = {
      id: createId("tool"),
      sessionId: input.sessionId,
      runId: input.runId,
      name: input.name,
      input: input.args,
      createdAt: timestamp,
    }
    const record: ToolCallRecord = {
      ...request,
      status: "queued",
    }

    const toolCalls = state.toolCalls.get(input.sessionId) ?? []
    toolCalls.push(record)
    state.toolCalls.set(input.sessionId, toolCalls)

    const pending = state.pendingToolRequests.get(input.sessionId) ?? []
    pending.push(request)
    state.pendingToolRequests.set(input.sessionId, pending)

    this.updateSession(input.sessionId, {
      updatedAt: timestamp,
    })

    const waiters = state.toolRequestWaiters.get(input.sessionId) ?? []
    const nextWaiter = waiters.shift()
    if (nextWaiter) {
      state.toolRequestWaiters.set(input.sessionId, waiters)
      const nextRequest = pending.shift() ?? request
      state.pendingToolRequests.set(input.sessionId, pending)
      nextWaiter(nextRequest)
      this.updateToolCall(input.sessionId, request.id, {
        status: "running",
        startedAt: now(),
      })
    }

    return request
  },

  async waitForToolRequest(sessionId: string, timeoutMs = 25000) {
    const state = getState()
    this.touchExtension(sessionId)

    const pending = state.pendingToolRequests.get(sessionId) ?? []
    const request = pending.shift()
    if (request) {
      state.pendingToolRequests.set(sessionId, pending)
      this.updateToolCall(sessionId, request.id, {
        status: "running",
        startedAt: now(),
      })
      return request
    }

    return new Promise<PendingToolRequest | null>((resolve) => {
      const waiter = (nextRequest: PendingToolRequest | null) => {
        clearTimeout(timeout)
        resolve(nextRequest)
      }

      const timeout = setTimeout(() => {
        const waiters = state.toolRequestWaiters.get(sessionId) ?? []
        state.toolRequestWaiters.set(
          sessionId,
          waiters.filter((w) => w !== waiter),
        )
        resolve(null)
      }, timeoutMs)

      const waiters = state.toolRequestWaiters.get(sessionId) ?? []
      waiters.push(waiter)
      state.toolRequestWaiters.set(sessionId, waiters)
    })
  },

  waitForToolResult(
    toolCallId: string,
    timeoutMs = 60000,
    signal?: AbortSignal,
  ) {
    const state = getState()

    return new Promise<ToolResultPayload>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error(`Tool request ${toolCallId} was cancelled.`))
        return
      }

      function cleanup() {
        clearTimeout(timeout)
        signal?.removeEventListener("abort", handleAbort)
        state.toolResultWaiters.delete(toolCallId)
      }

      function handleAbort() {
        cleanup()
        reject(new Error(`Tool request ${toolCallId} was cancelled.`))
      }

      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", handleAbort)
        state.toolResultWaiters.delete(toolCallId)
        reject(new Error(`Tool request ${toolCallId} timed out waiting for the extension.`))
      }, timeoutMs)

      state.toolResultWaiters.set(toolCallId, {
        resolve: (result) => {
          cleanup()
          resolve(result)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
        timeout,
      })

      signal?.addEventListener("abort", handleAbort, { once: true })
    })
  },

  cancelRunToolRequests(sessionId: string, runId: string, reason: string) {
    const state = getState()
    const pending = state.pendingToolRequests.get(sessionId) ?? []
    state.pendingToolRequests.set(
      sessionId,
      pending.filter((request) => request.runId !== runId),
    )

    const timestamp = now()
    const toolCalls = state.toolCalls.get(sessionId) ?? []
    for (const toolCall of toolCalls) {
      if (
        toolCall.runId !== runId ||
        (toolCall.status !== "queued" && toolCall.status !== "running")
      ) {
        continue
      }

      const waiter = state.toolResultWaiters.get(toolCall.id)
      if (waiter) {
        waiter.reject(new Error(reason))
      }

      Object.assign(toolCall, {
        status: "failed" satisfies ToolCallStatus,
        completedAt: timestamp,
        error: reason,
      })
    }
  },

  completeToolRequest(
    sessionId: string,
    toolCallId: string,
    result: ToolResultPayload,
  ) {
    const state = getState()
    const waiter = state.toolResultWaiters.get(toolCallId)
    if (waiter) {
      waiter.resolve(result)
    }

    const toolCalls = state.toolCalls.get(sessionId)
    const toolCall = toolCalls?.find((item) => item.id === toolCallId)
    if (!waiter && toolCall?.completedAt) {
      this.touchExtension(sessionId)
      return
    }

    this.updateToolCall(sessionId, toolCallId, {
      status: result.ok ? "completed" : "failed",
      completedAt: now(),
      output: result.output,
      error: result.error,
    })
    this.touchExtension(sessionId)
  },

  updateToolCall(
    sessionId: string,
    toolCallId: string,
    updates: Partial<
      Pick<
        ToolCallRecord,
        "status" | "startedAt" | "completedAt" | "output" | "error"
      >
    >,
  ) {
    const toolCalls = getState().toolCalls.get(sessionId)
    const toolCall = toolCalls?.find((item) => item.id === toolCallId)
    if (!toolCall) {
      return null
    }

    Object.assign(toolCall, updates)
    return toolCall
  },

  setToolCallStatus(
    sessionId: string,
    toolCallId: string,
    status: ToolCallStatus,
    error?: string,
  ) {
    return this.updateToolCall(sessionId, toolCallId, {
      status,
      error,
      completedAt: status === "completed" || status === "failed" ? now() : undefined,
    })
  },
}
