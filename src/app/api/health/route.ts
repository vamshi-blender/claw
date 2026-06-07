import { NextResponse } from "next/server"

import { optionsResponse, withCors } from "@/server/http/cors"

export function OPTIONS() {
  return optionsResponse()
}

export function GET() {
  return NextResponse.json(
    { ok: true, service: "backend" },
    { headers: withCors() },
  )
}
