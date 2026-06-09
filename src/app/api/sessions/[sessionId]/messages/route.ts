import { run } from "@openai/agents"
import { z } from "zod"

import {
  BROWSER_AGENT_NAME,
  DEFAULT_AGENT_MODEL,
  createBrowserAgent,
} from "@/server/agents/browser-agent"
import { optionsResponse, withCors } from "@/server/http/cors"
import { chatStore } from "@/server/storage/chat-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const sendMessageSchema = z.object({
  message: z.string().trim().min(1).max(12000),
})

type RouteContext = {
  params: Promise<{ sessionId: string }>
}

export function OPTIONS() {
  return optionsResponse()
}

function streamError(message: string, status = 500) {
  return new Response(message, {
    status,
    headers: withCors({
      "Content-Type": "text/plain; charset=utf-8",
    }),
  })
}

function encodeStreamEvent(type: string, payload: Record<string, unknown>) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

function stringifyToolValue(value: unknown) {
  if (typeof value === "string") {
    return value
  }

  try {
    return JSON.stringify(value)
  } catch {
    return String(value ?? "")
  }
}

function looksLikeToolError(output: string) {
  try {
    const parsed = JSON.parse(output) as { ok?: unknown }
    return parsed?.ok === false
  } catch {
    return false
  }
}

export async function POST(request: Request, context: RouteContext) {
  if (!process.env.OPENAI_API_KEY) {
    return streamError("OPENAI_API_KEY is not configured.", 500)
  }

  const { sessionId } = await context.params
  const session = chatStore.getSession(sessionId)
  const sdkSession = chatStore.getSdkSession(sessionId)

  if (!session || !sdkSession) {
    return streamError("Session not found.", 404)
  }

  const parsed = sendMessageSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return streamError("Message is required.", 400)
  }

  const userMessage = parsed.data.message
  chatStore.addMessage({ sessionId, role: "user", content: userMessage })
  const runRecord = chatStore.createRun({
    sessionId,
    agentName: BROWSER_AGENT_NAME,
    model: DEFAULT_AGENT_MODEL,
  })

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let assistantText = ""
      const stopReason = "Agent run was stopped."
      const cancelRunToolRequests = () => {
        chatStore.cancelRunToolRequests(sessionId, runRecord.id, stopReason)
      }
      request.signal.addEventListener("abort", cancelRunToolRequests, {
        once: true,
      })

      function sendEvent(type: string, payload: Record<string, unknown>) {
        if (request.signal.aborted) {
          return
        }

        try {
          controller.enqueue(encoder.encode(encodeStreamEvent(type, payload)))
        } catch {
          // The browser may have already closed the stream after the user clicked Stop.
        }
      }

      try {
        const agent = createBrowserAgent({
          sessionId,
          runId: runRecord.id,
          signal: request.signal,
          emitToolStatus: (event) => {
            sendEvent("tool_status", event)
          },
        })

        const agentStream = await run(agent, userMessage, {
          stream: true,
          session: sdkSession,
          maxTurns: 50,
          signal: request.signal,
          toolExecution: {
            maxFunctionToolConcurrency: 3,
          },
          toolNotFoundBehavior: "return_error_to_model",
        })

        for await (const event of agentStream) {
          if (
            event.type === "raw_model_stream_event" &&
            event.data.type === "output_text_delta"
          ) {
            assistantText += event.data.delta
            sendEvent("text_delta", { delta: event.data.delta })
          }

          if (event.type === "run_item_stream_event") {
            if (event.name === "reasoning_item_created") {
              const raw = event.item.rawItem as {
                content?: Array<{ text?: string }>
              }
              const text = (raw.content ?? [])
                .map((entry) => entry.text ?? "")
                .join("\n")
                .trim()

              if (text) {
                sendEvent("reasoning", { text })
              }
            }

            if (event.name === "tool_called") {
              const raw = event.item.rawItem as {
                callId?: string
                id?: string
                name?: string
                arguments?: string
              }

              sendEvent("tool_call", {
                toolCallId: raw.callId ?? raw.id ?? "",
                name: raw.name ?? "tool",
                arguments: raw.arguments ?? "",
              })
              sendEvent("tool_status", {
                status: "running",
                message: `Running ${raw.name ?? "tool"}`,
              })
            }

            if (event.name === "tool_output") {
              const item = event.item as {
                callId?: string
                output?: unknown
              }
              const output = stringifyToolValue(item.output)
              const isError = looksLikeToolError(output)

              sendEvent("tool_result", {
                toolCallId: item.callId ?? "",
                output,
                isError,
              })
              sendEvent("tool_status", {
                status: isError ? "failed" : "completed",
                message: isError ? "Tool failed" : "Tool output received",
              })
            }
          }
        }

        await agentStream.completed

        chatStore.addMessage({
          sessionId,
          role: "assistant",
          content: assistantText || String(agentStream.finalOutput ?? ""),
        })
        chatStore.updateRun(sessionId, runRecord.id, {
          status: "completed",
          completedAt: new Date().toISOString(),
          lastResponseId: agentStream.lastResponseId,
        })
        chatStore.setSessionStatus(sessionId, "idle")
      } catch (error) {
        if (request.signal.aborted || isAbortError(error)) {
          cancelRunToolRequests()
          if (assistantText) {
            chatStore.addMessage({
              sessionId,
              role: "assistant",
              content: assistantText,
            })
          }
          chatStore.updateRun(sessionId, runRecord.id, {
            status: "completed",
            completedAt: new Date().toISOString(),
          })
          chatStore.setSessionStatus(sessionId, "idle")
          return
        }

        const message =
          error instanceof Error ? error.message : "Agent run failed unexpectedly."

        chatStore.completeRun(sessionId, runRecord.id, "failed", message)
        sendEvent("error", { message })
      } finally {
        request.signal.removeEventListener("abort", cancelRunToolRequests)
        sendEvent("done", {})
        try {
          controller.close()
        } catch {
          // The stream can already be closed when the client aborts the request.
        }
      }
    },
  })

  return new Response(stream, {
    headers: withCors({
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Session-Id": sessionId,
    }),
  })
}
