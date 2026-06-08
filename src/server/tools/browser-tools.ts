import { tool } from "@openai/agents"
import { z } from "zod"

import { chatStore } from "@/server/storage/chat-store"
import type { BrowserToolName } from "@/types/chat"

type ToolStatusEmitter = (event: {
  toolCallId: string
  name: BrowserToolName
  status: "queued" | "running" | "completed" | "failed"
  message: string
}) => void

type BrowserToolContext = {
  sessionId: string
  runId: string
  emitStatus?: ToolStatusEmitter
}

type ToolDefinition = {
  name: BrowserToolName
  description: string
  parameters: z.ZodObject
  timeoutMs?: number
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ ok: false, error: "Tool result was not JSON serializable." })
  }
}

async function runExtensionTool(
  context: BrowserToolContext,
  name: BrowserToolName,
  args: unknown,
  timeoutMs = 60000,
) {
  const session = chatStore.getSession(context.sessionId)
  if (!session?.extension) {
    const message =
      "Chrome extension is not connected for this session. Open the side panel in the target Chrome window and retry."
    return safeJson({ ok: false, error: message })
  }

  const request = chatStore.createToolRequest({
    sessionId: context.sessionId,
    runId: context.runId,
    name,
    args,
  })

  context.emitStatus?.({
    toolCallId: request.id,
    name,
    status: "queued",
    message: `Queued ${name}`,
  })

  try {
    const result = await chatStore.waitForToolResult(request.id, timeoutMs)
    context.emitStatus?.({
      toolCallId: request.id,
      name,
      status: result.ok ? "completed" : "failed",
      message: result.ok ? `Completed ${name}` : `Failed ${name}`,
    })

    return safeJson(result.ok ? { ok: true, output: result.output } : result)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `Tool ${name} failed unexpectedly.`
    chatStore.setToolCallStatus(context.sessionId, request.id, "failed", message)
    context.emitStatus?.({
      toolCallId: request.id,
      name,
      status: "failed",
      message,
    })
    return safeJson({ ok: false, error: message })
  }
}

const tabId = z.number().int().describe("Target Chrome tab ID in the locked window.")

const coordinate = z
  .array(z.number())
  .length(2)
  .describe("Viewport coordinate as [x, y] pixels from the top-left corner.")

const toolDefinitions: ToolDefinition[] = [
  {
    name: "tabs_context",
    description:
      "List tabs in the Chrome window locked to this chat session. Use this before acting on browser tabs.",
    parameters: z.object({}),
    timeoutMs: 30000,
  },
  {
    name: "tabs_create",
    description:
      "Create a new tab in the Chrome window locked to this chat session. Optionally provide a URL.",
    parameters: z.object({
      url: z.string().min(1).optional().describe("Optional URL to open in the new tab."),
    }),
    timeoutMs: 30000,
  },
  {
    name: "navigate",
    description:
      "Navigate a tab to a URL, or use 'back'/'forward' for browser history navigation.",
    parameters: z.object({
      tabId,
      url: z
        .string()
        .min(1)
        .describe("Destination URL, or 'back'/'forward' for history navigation."),
    }),
  },
  {
    name: "resize_window",
    description:
      "Resize the Chrome window that contains the target tab. Useful for responsive testing.",
    parameters: z.object({
      tabId,
      width: z.number().int().positive().describe("Target window width in pixels."),
      height: z.number().int().positive().describe("Target window height in pixels."),
    }),
  },
  {
    name: "get_page_text",
    description:
      "Extract readable text from a page, prioritizing article/main/body content.",
    parameters: z.object({
      tabId,
      max_chars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum characters to return. Defaults to 50000."),
    }),
  },
  {
    name: "read_page",
    description:
      "Read a structured summary of page elements and refs. Defaults to interactive elements to keep browser-agent turns fast. Use refs with find, form_input, and computer actions.",
    parameters: z.object({
      tabId,
      depth: z.number().int().positive().optional().describe("Maximum DOM depth. Defaults to 8."),
      filter: z
        .enum(["interactive", "all"])
        .optional()
        .describe("Element filter. Defaults to interactive."),
      max_chars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum output characters. Defaults to 20000."),
      ref_id: z.string().optional().describe("Optional parent ref to inspect."),
    }),
  },
  {
    name: "find",
    description:
      "Find elements on a page by text, label, role, placeholder, title, or accessible name.",
    parameters: z.object({
      tabId,
      query: z.string().min(1).describe("Natural-language text describing the element."),
    }),
  },
  {
    name: "form_input",
    description:
      "Set the value of an input, textarea, select, checkbox, or radio using a ref from read_page/find.",
    parameters: z.object({
      tabId,
      ref: z.string().min(1).describe("Element ref from read_page/find."),
      value: z.union([z.string(), z.number(), z.boolean()]).describe("Value to set."),
    }),
  },
  {
    name: "computer",
    description:
      "Interact with the browser by clicking, typing, scrolling, pressing keys, waiting, hovering, or taking screenshots.",
    parameters: z.object({
      tabId,
      action: z.enum([
        "left_click",
        "right_click",
        "double_click",
        "triple_click",
        "type",
        "screenshot",
        "wait",
        "scroll",
        "key",
        "left_click_drag",
        "zoom",
        "scroll_to",
        "hover",
      ]),
      coordinate: coordinate.optional(),
      start_coordinate: coordinate.optional(),
      region: z
        .array(z.number())
        .length(4)
        .optional()
        .describe("Screenshot crop/zoom rectangle [x0, y0, x1, y1]."),
      ref: z.string().optional().describe("Element ref from read_page/find."),
      text: z.string().optional().describe("Text to type or key name/sequence."),
      duration: z.number().positive().max(30).optional().describe("Wait duration in seconds."),
      scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
      scroll_amount: z.number().int().positive().optional(),
      repeat: z.number().int().positive().max(100).optional(),
      modifiers: z.string().optional(),
    }),
  },
  {
    name: "upload_image",
    description:
      "Upload a stored screenshot/image to a file input or drag-and-drop target by ref or coordinate.",
    parameters: z.object({
      tabId,
      imageId: z.string().min(1),
      ref: z.string().optional(),
      coordinate: coordinate.optional(),
      filename: z.string().optional(),
    }),
  },
  {
    name: "file_upload",
    description:
      "Upload local files to a file input by ref. Browser extensions cannot read arbitrary local paths unless the browser grants access.",
    parameters: z.object({
      tabId,
      ref: z.string().min(1),
      paths: z.array(z.string().min(1)).min(1),
    }),
  },
  {
    name: "read_console_messages",
    description:
      "Read console messages captured for a tab, optionally filtered by regex pattern.",
    parameters: z.object({
      tabId,
      pattern: z.string().min(1),
      clear: z.boolean().optional(),
      limit: z.number().int().positive().optional(),
      onlyErrors: z.boolean().optional(),
    }),
  },
  {
    name: "read_network_requests",
    description:
      "Read recent browser performance/network entries for a tab, with optional URL substring filtering.",
    parameters: z.object({
      tabId,
      limit: z.number().int().positive().optional(),
      clear: z.boolean().optional(),
      urlPattern: z.string().optional(),
    }),
  },
  {
    name: "javascript_tool",
    description:
      "Execute JavaScript in a tab's page context. The code should be an expression or self-contained script.",
    parameters: z.object({
      tabId,
      action: z.literal("javascript_exec"),
      text: z.string().min(1).describe("JavaScript code to evaluate in page context."),
    }),
  },
]

export function createBrowserTools(context: BrowserToolContext) {
  const browserTools = toolDefinitions.map((definition) =>
    tool({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      strict: true,
      timeoutMs: definition.timeoutMs ?? 60000,
      timeoutBehavior: "error_as_result",
      timeoutErrorFunction: () => `Tool ${definition.name} timed out.`,
      errorFunction: (_runContext, error) =>
        safeJson({
          ok: false,
          error: error instanceof Error ? error.message : `Tool ${definition.name} failed.`,
        }),
      execute: (args) =>
        runExtensionTool(context, definition.name, args, definition.timeoutMs ?? 60000),
    }),
  )

  const answerStartTool = tool({
    name: "turn_answer_start",
    description:
      "Signal that the agent is ready to provide the final text answer for the current turn. No browser action is performed.",
    parameters: z.object({}),
    strict: true,
    execute: () => safeJson({ ok: true, readyForResponse: true }),
  })

  return [...browserTools, answerStartTool]
}
