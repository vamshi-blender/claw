import { run } from "@openai/agents"
import { z } from "zod"

import { browserAgent, BROWSER_AGENT_NAME, DEFAULT_AGENT_MODEL } from "@/server/agents/browser-agent"
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

      try {
        const agentStream = await run(browserAgent, userMessage, {
          stream: true,
          session: sdkSession,
          maxTurns: 4,
        })

        for await (const event of agentStream) {
          if (
            event.type === "raw_model_stream_event" &&
            event.data.type === "output_text_delta"
          ) {
            assistantText += event.data.delta
            controller.enqueue(encoder.encode(event.data.delta))
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
        const message =
          error instanceof Error ? error.message : "Agent run failed unexpectedly."

        chatStore.completeRun(sessionId, runRecord.id, "failed", message)
        controller.enqueue(encoder.encode(`\n\n[Error] ${message}`))
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: withCors({
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Session-Id": sessionId,
    }),
  })
}
