import { NextResponse } from "next/server"
import { z } from "zod"

import { optionsResponse, withCors } from "@/server/http/cors"
import { chatStore } from "@/server/storage/chat-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RouteContext = {
  params: Promise<{ sessionId: string; toolCallId: string }>
}

const resultSchema = z.object({
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
})

export function OPTIONS() {
  return optionsResponse()
}

export async function POST(request: Request, context: RouteContext) {
  const { sessionId, toolCallId } = await context.params
  const parsed = resultSchema.safeParse(await request.json().catch(() => null))

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid tool result." },
      { status: 400, headers: withCors() },
    )
  }

  chatStore.completeToolRequest(sessionId, toolCallId, parsed.data)
  return NextResponse.json({ ok: true }, { headers: withCors() })
}
