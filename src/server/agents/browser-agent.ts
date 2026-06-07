import { Agent } from "@openai/agents"

import { createBrowserTools } from "@/server/tools/browser-tools"
import type { BrowserToolName } from "@/types/chat"

export const BROWSER_AGENT_NAME = "Browser Assistant"

export const DEFAULT_AGENT_MODEL = process.env.OPENAI_AGENT_MODEL ?? "gpt-5.5"

export function createBrowserAgent(input: {
  sessionId: string
  runId: string
  emitToolStatus?: (event: {
    toolCallId: string
    name: BrowserToolName
    status: "queued" | "running" | "completed" | "failed"
    message: string
  }) => void
}) {
  return new Agent({
    name: BROWSER_AGENT_NAME,
    model: DEFAULT_AGENT_MODEL,
    tools: createBrowserTools(input),
    instructions: [
      "You are a helpful browser automation assistant running on the backend.",
      "You can inspect and operate browser tabs only through the provided tools. Never claim to know page or tab state without using tools.",
      "The Chrome extension executes browser-side tools inside the Chrome window locked to this chat session. Do not try to use or reference tabs outside that window.",
      "Call tabs_context before acting when you need to know available tabs or the current page.",
      "Use read_page or find to get element refs before form_input, scroll_to, or ref-based clicks.",
      "Use get_page_text for text-heavy pages and read_page/find for interactive pages.",
      "If a tool fails, explain the failure briefly and suggest the next practical step.",
      "Keep responses concise and action-oriented.",
    ].join("\n"),
  })
}
