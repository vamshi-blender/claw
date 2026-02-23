import { MemorySaver, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { tool } from "@langchain/core/tools";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

type ToolCall = {
  name: string;
  args: Record<string, unknown>;
};

type PersistedMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
};

export type LlmSettings = {
  provider: "openai";
  model: string;
  apiKey: string;
};

export type PersistedThreadState = {
  turn: number;
  messages: PersistedMessage[];
  lastToolResult: string | null;
};

const mockCdpTool = tool(
  async ({ action, target }) => {
    return `Mock CDP executed action='${action}' target='${target ?? ""}'`;
  },
  {
    name: "mock_cdp_action",
    description:
      "Execute a mocked Chrome DevTools action. Use when user asks to click, navigate, inspect, or control the browser.",
    schema: z.object({
      action: z.string().describe("CDP action name, e.g. click, navigate"),
      target: z.string().optional().describe("Optional selector or URL target"),
    }),
  }
);

const runJsTool = tool(
  async ({ script }) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) {
      return "No active tab found.";
    }

    const debuggee: chrome.debugger.Debuggee = { tabId: tab.id };

    try {
      await chrome.debugger.attach(debuggee, "1.3");
      await chrome.debugger.sendCommand(debuggee, "Runtime.enable");

      const evaluation = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
        expression: script,
        awaitPromise: true,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
      })) as {
        result?: { value?: unknown; description?: string };
        exceptionDetails?: { text?: string; exception?: { description?: string; value?: unknown } };
      };

      if (evaluation.exceptionDetails) {
        const message =
          evaluation.exceptionDetails.exception?.description ||
          evaluation.exceptionDetails.text ||
          "Unknown script error";
        return `Script error: ${message}`;
      }

      const value = evaluation.result?.value;
      if (typeof value === "string") {
        return `Script result: ${value}`;
      }
      if (value === undefined) {
        return "Script result: undefined";
      }
      try {
        return `Script result: ${JSON.stringify(value)}`;
      } catch {
        return `Script result: ${evaluation.result?.description ?? String(value)}`;
      }
    } catch (error) {
      return `Script error: ${String(error)}`;
    } finally {
      try {
        await chrome.debugger.detach(debuggee);
      } catch {
        // Ignore detach errors.
      }
    }
  },
  {
    name: "run_js_current_tab",
    description:
      "Run JavaScript on the current active tab and return the output. Use this when user asks to execute JS in browser.",
    schema: z.object({
      script: z.string().min(1).describe("JavaScript code to execute on the active tab."),
    }),
  }
);

const tools = [runJsTool, mockCdpTool];
const toolNode = new ToolNode(tools);
const checkpointer = new MemorySaver();
let fallbackSettings: LlmSettings | undefined;

function getTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .join("\n");
  }
  return JSON.stringify(content);
}

function getMessageType(message: BaseMessage): string {
  const msg = message as unknown as { getType?: () => string; type?: string };
  if (typeof msg.getType === "function") {
    return msg.getType();
  }
  return msg.type ?? "unknown";
}

function parseDirectCommand(input: string): ToolCall | null {
  const trimmed = input.trim();

  if (trimmed.startsWith("/runjs")) {
    const script = trimmed.replace(/^\/runjs\s*/, "");
    return {
      name: runJsTool.name,
      args: { script: script || "throw new Error('No script provided')" },
    };
  }

  if (trimmed.startsWith("/cdp")) {
    const parts = trimmed.split(/\s+/);
    const action = parts[1] ?? "noop";
    const target = parts.slice(2).join(" ") || undefined;
    return {
      name: mockCdpTool.name,
      args: { action, target },
    };
  }

  return null;
}

async function loadLlmSettingsFromStorage(): Promise<LlmSettings | undefined> {
  const result = await chrome.storage.local.get("llmSettings");
  const settings = result.llmSettings as LlmSettings | undefined;
  if (!settings || settings.provider !== "openai") {
    return undefined;
  }
  if (!settings.apiKey || !settings.model) {
    return undefined;
  }
  return settings;
}

function forcedToolCallMessage(call: ToolCall): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: [
      {
        name: call.name,
        args: call.args,
        id: crypto.randomUUID(),
        type: "tool_call",
      },
    ],
  });
}

const llmNode = async (state: typeof MessagesAnnotation.State) => {
  const settings = (await loadLlmSettingsFromStorage()) ?? fallbackSettings;
  if (!settings?.apiKey || !settings?.model) {
    return {
      messages: [
        new AIMessage("Missing OpenAI settings. Open extension Options and save model + API key."),
      ],
    };
  }

  const lastMessage = state.messages.at(-1);
  if (lastMessage && getMessageType(lastMessage) === "human") {
    const direct = parseDirectCommand(getTextContent(lastMessage.content));
    if (direct) {
      return {
        messages: [forcedToolCallMessage(direct)],
      };
    }
  }

  const model = new ChatOpenAI({
    apiKey: settings.apiKey,
    model: settings.model,
    temperature: 0.2,
  }).bindTools(tools);

  const response = await model.invoke([
    new SystemMessage(
      "You are a Chrome extension assistant. Use tool calling when actions are needed. " +
        "Call run_js_current_tab when user asks to run JavaScript on the current page. " +
        "For page location use window.location.href. Prefer scripts that return a value. " +
        "Call mock_cdp_action for browser-control actions."
    ),
    ...state.messages,
  ]);

  return { messages: [response] };
};

const graph = new StateGraph(MessagesAnnotation)
  .addNode("llm", llmNode)
  .addNode("tools", toolNode)
  .addEdge(START, "llm")
  .addConditionalEdges("llm", toolsCondition)
  .addEdge("tools", "llm")
  .compile({ checkpointer });

function toPersistedMessage(message: BaseMessage): PersistedMessage {
  const type = getMessageType(message);
  const content = getTextContent(message.content);

  if (type === "human") {
    return { role: "user", content };
  }
  if (type === "tool") {
    return { role: "tool", content };
  }
  return { role: "assistant", content };
}

function fromPersistedMessage(message: PersistedMessage): BaseMessage {
  if (message.role === "user") {
    return new HumanMessage(message.content);
  }
  if (message.role === "tool") {
    return new ToolMessage(message.content, "restored_tool_call", "restored_tool");
  }
  return new AIMessage(message.content);
}

function findLastAssistant(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (getMessageType(messages[i]) === "ai") {
      return getTextContent(messages[i].content);
    }
  }
  return "No response";
}

function findLastTool(messages: BaseMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (getMessageType(messages[i]) === "tool") {
      return getTextContent(messages[i].content);
    }
  }
  return null;
}

export async function runGraphTurn(threadId: string, input: string, settings: LlmSettings, seed?: PersistedThreadState) {
  const threadConfig = {
    configurable: {
      thread_id: threadId,
    },
  };

  let hasCheckpoint = false;
  try {
    const checkpointState = await graph.getState(threadConfig);
    hasCheckpoint = Boolean(checkpointState?.values);
  } catch {
    hasCheckpoint = false;
  }

  const seedMessages = hasCheckpoint
    ? []
    : (seed?.messages ?? []).map(fromPersistedMessage);

  let state: Awaited<ReturnType<typeof graph.invoke>>;
  fallbackSettings = settings;
  try {
    state = await graph.invoke(
      {
        messages: [...seedMessages, new HumanMessage(input)],
      },
      threadConfig
    );
  } finally {
    fallbackSettings = undefined;
  }

  const messages = state.messages as BaseMessage[];
  const response = findLastAssistant(messages);
  const lastToolResult = findLastTool(messages);

  const persisted: PersistedThreadState = {
    turn: (typeof seed?.turn === "number" ? seed.turn : 0) + 1,
    messages: messages.map(toPersistedMessage),
    lastToolResult,
  };

  return {
    response,
    state: persisted,
  };
}
