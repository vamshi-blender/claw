import { NextResponse } from "next/server"

import { optionsResponse, withCors } from "@/server/http/cors"
import { chatStore } from "@/server/storage/chat-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RouteContext = {
  params: Promise<{ sessionId: string }>
}

export function OPTIONS() {
  return optionsResponse()
}

export async function GET(_request: Request, context: RouteContext) {
  const { sessionId } = await context.params
  const session = chatStore.getSession(sessionId)

  if (!session) {
    return NextResponse.json(
      { error: "Session not found." },
      { status: 404, headers: withCors() },
    )
  }

  const request = await chatStore.waitForToolRequest(sessionId)
  return NextResponse.json({ request }, { headers: withCors() })
}
