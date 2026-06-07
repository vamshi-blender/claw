import { Agent } from "@openai/agents"

export const BROWSER_AGENT_NAME = "Browser Assistant"

export const DEFAULT_AGENT_MODEL = process.env.OPENAI_AGENT_MODEL ?? "gpt-5.5"

export const browserAgent = new Agent({
  name: BROWSER_AGENT_NAME,
  model: DEFAULT_AGENT_MODEL,
  instructions: [
    "You are a helpful browser-agent assistant running on the backend.",
    "For now, you have no browser automation tools and must not claim to inspect tabs, pages, or the DOM.",
    "Answer conversationally and ask for missing details when needed.",
    "When browser-side tools are added later, they will be requested through the backend and executed by the Chrome extension.",
  ].join("\n"),
})
