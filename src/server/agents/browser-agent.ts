import { Agent } from "@openai/agents"

import { createBrowserTools } from "@/server/tools/browser-tools"
import type { BrowserToolName } from "@/types/chat"

export const BROWSER_AGENT_NAME = "Browser Assistant"

const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const
const TEXT_VERBOSITIES = ["low", "medium", "high"] as const

type ReasoningEffort = (typeof REASONING_EFFORTS)[number]
type TextVerbosity = (typeof TEXT_VERBOSITIES)[number]

function parseReasoningEffort(value: string | undefined): ReasoningEffort {
  return REASONING_EFFORTS.includes(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : "low"
}

function parseTextVerbosity(value: string | undefined): TextVerbosity {
  return TEXT_VERBOSITIES.includes(value as TextVerbosity)
    ? (value as TextVerbosity)
    : "low"
}

export const DEFAULT_AGENT_MODEL = process.env.OPENAI_AGENT_MODEL ?? "gpt-5.5"
export const DEFAULT_REASONING_EFFORT = parseReasoningEffort(
  process.env.OPENAI_AGENT_REASONING_EFFORT,
)
export const DEFAULT_TEXT_VERBOSITY = parseTextVerbosity(
  process.env.OPENAI_AGENT_TEXT_VERBOSITY,
)

export function createBrowserAgent(input: {
  sessionId: string
  runId: string
  signal?: AbortSignal
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
    modelSettings: {
      parallelToolCalls: true,
      reasoning: { effort: DEFAULT_REASONING_EFFORT },
      text: { verbosity: DEFAULT_TEXT_VERBOSITY },
    },
    tools: createBrowserTools(input),
    instructions: [
      "You are a helpful browser automation assistant running on the backend.",
      "You can inspect and operate browser tabs only through the provided tools. Never claim to know page or tab state without using tools.",
      "The Chrome extension executes browser-side tools inside the Chrome window locked to this chat session. Do not try to use or reference tabs outside that window.",
      "Call tabs_context before acting when you need to know available tabs or the current page.",
      "Use read_page or find to get element refs before form_input, scroll_to, or ref-based clicks.",
      "Use get_page_text for text-heavy pages and read_page/find for interactive pages.",
      "",
      "Narrate your work in very short fragments so the user can follow along:",
      "- Before a tool call (or a group of related calls), post a 3-7 word phrase of what you're doing, e.g. \"Reading the form fields\", \"Filling all fields\", \"Submitting the form\".",
      "- If a tool fails or returns something unexpected, post a brief phrase on your next step, e.g. \"Click failed, trying coordinates\".",
      "Keep these to a few words — they are status labels, not sentences. Don't narrate trivial steps or repeat yourself.",
      "",
      "When the task is complete, end with a brief final summary (1-2 sentences) of what you did.",
    ].join("\n"),
  })
}
