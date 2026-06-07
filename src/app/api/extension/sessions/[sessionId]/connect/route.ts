import { NextResponse } from "next/server"
import { z } from "zod"

import { optionsResponse, withCors } from "@/server/http/cors"
import { chatStore } from "@/server/storage/chat-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RouteContext = {
  params: Promise<{ sessionId: string }>
}

const connectSchema = z.object({
  windowId: z.number().int(),
})

export function OPTIONS() {
  return optionsResponse()
}

export async function POST(request: Request, context: RouteContext) {
  const { sessionId } = await context.params
  const parsed = connectSchema.safeParse(await request.json().catch(() => null))

  if (!parsed.success) {
    return NextResponse.json(
      { error: "windowId is required." },
      { status: 400, headers: withCors() },
    )
  }

  const session = chatStore.connectExtension(sessionId, parsed.data.windowId)
  if (!session) {
    return NextResponse.json(
      { error: "Session not found." },
      { status: 404, headers: withCors() },
    )
  }

  return NextResponse.json({ session }, { headers: withCors() })
}
