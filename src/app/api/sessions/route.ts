import { NextResponse } from "next/server"

import { optionsResponse, withCors } from "@/server/http/cors"
import { chatStore } from "@/server/storage/chat-store"
import type { CreateSessionResponse, ListSessionsResponse } from "@/types/chat"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export function OPTIONS() {
  return optionsResponse()
}

export function GET() {
  return NextResponse.json<ListSessionsResponse>(
    { sessions: chatStore.listSessions() },
    { headers: withCors() },
  )
}

export function POST() {
  return NextResponse.json<CreateSessionResponse>(
    { session: chatStore.createSession() },
    { headers: withCors() },
  )
}
