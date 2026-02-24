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

type DomainSkillHint = {
  domain: string;
  skill: string;
};

const DOMAIN_SKILL_HINTS: DomainSkillHint[] = [
  {
    domain: "amazon.com",
    skill: "Use 'Add to Cart' buttons and 'Proceed to Checkout' workflow",
  },
  {
    domain: "mail.google.com",
    skill: "Gmail interface: compose with keyboard shortcut 'c', archive with 'e', search using filter syntax",
  },
  {
    domain: "docs.example.com",
    skill: "Search documentation with the search box in the header, use left sidebar for navigation",
  },
  {
    domain: "example.com",
    skill: "Static example page with basic HTML structure",
  },
];

function parseHostname(rawUrl: string | undefined): string | null {
  if (!rawUrl) {
    return null;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function findDomainSkills(urls: Array<string | undefined>) {
  const matches = new Map<string, DomainSkillHint>();
  for (const rawUrl of urls) {
    const hostname = parseHostname(rawUrl);
    if (!hostname) {
      continue;
    }
    for (const hint of DOMAIN_SKILL_HINTS) {
      if (hostname === hint.domain || hostname.endsWith(`.${hint.domain}`)) {
        matches.set(hint.domain, hint);
      }
    }
  }
  return Array.from(matches.values());
}

async function getCurrentContextTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function validateTabInCurrentScope(tabId: number) {
  const contextTab = await getCurrentContextTab();
  if (!contextTab?.id) {
    return { ok: false as const, error: "No active tab found for current context." };
  }

  let targetTab: chrome.tabs.Tab;
  try {
    targetTab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false as const, error: `Tab ${tabId} was not found.` };
  }

  const contextGroupId = contextTab.groupId ?? -1;
  if (contextGroupId >= 0 && targetTab.groupId !== contextGroupId) {
    return {
      ok: false as const,
      error: `Tab ${tabId} is not in the current tab group. Use tabs_context to get valid tabs.`,
    };
  }

  if (contextGroupId < 0 && targetTab.id !== contextTab.id) {
    return {
      ok: false as const,
      error:
        `Tab ${tabId} is outside the current tab context. Use tabs_context to get the current valid tab.`,
    };
  }

  return { ok: true as const, contextTab, targetTab };
}

function normalizeNavigateUrl(input: string) {
  const trimmed = input.trim();
  if (trimmed === "back" || trimmed === "forward") {
    return { kind: trimmed as "back" | "forward" };
  }

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
    return { kind: "url" as const, url: trimmed };
  }

  return { kind: "url" as const, url: `https://${trimmed}` };
}

const tabsContextTool = tool(
  async () => {
    const [initialTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!initialTab?.id) {
      return JSON.stringify({ availableTabs: [], initialTabId: null });
    }

    const isGrouped = typeof initialTab.groupId === "number" && initialTab.groupId >= 0;
    const tabs = isGrouped
      ? await chrome.tabs.query({ groupId: initialTab.groupId })
      : [initialTab];

    const availableTabs = tabs
      .filter((tab) => typeof tab.id === "number")
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((tab) => ({
        tabId: tab.id as number,
        title: tab.title ?? "",
        url: tab.url ?? "",
      }));

    const domainSkills = findDomainSkills(tabs.map((tab) => tab.url));
    const response: {
      availableTabs: Array<{ tabId: number; title: string; url: string }>;
      initialTabId: number;
      domainSkills?: DomainSkillHint[];
    } = {
      availableTabs,
      initialTabId: initialTab.id,
    };

    if (domainSkills.length > 0) {
      response.domainSkills = domainSkills;
    }

    return JSON.stringify(response);
  },
  {
    name: "tabs_context",
    description:
      "Get context information about all tabs in the current tab group, including availableTabs, initialTabId, and optional domainSkills.",
    schema: z.object({}),
  }
);

const navigateTool = tool(
  async ({ url, tabId }) => {
    const scope = await validateTabInCurrentScope(tabId);
    if (!scope.ok) {
      return JSON.stringify({ success: false, action: "navigate", tabId, error: scope.error });
    }

    const normalized = normalizeNavigateUrl(url);
    try {
      if (normalized.kind === "back") {
        await chrome.tabs.goBack(tabId);
        return JSON.stringify({
          success: true,
          action: "navigate",
          tabId,
          navigation: "back",
        });
      }
      if (normalized.kind === "forward") {
        await chrome.tabs.goForward(tabId);
        return JSON.stringify({
          success: true,
          action: "navigate",
          tabId,
          navigation: "forward",
        });
      }

      const updated = await chrome.tabs.update(tabId, { url: normalized.url });
      return JSON.stringify({
        success: true,
        action: "navigate",
        tabId,
        requestedUrl: url,
        finalUrl: updated.url ?? normalized.url,
      });
    } catch (error) {
      return JSON.stringify({
        success: false,
        action: "navigate",
        tabId,
        error: String(error),
      });
    }
  },
  {
    name: "navigate",
    description:
      "Navigate a tab to a URL, or move back/forward in history. Requires url and tabId. URL defaults to https:// when protocol is omitted.",
    schema: z.object({
      url: z
        .string()
        .min(1)
        .describe("Destination URL, or 'back'/'forward' for history navigation."),
      tabId: z.number().int().describe("Target tab ID. Must be in the current tab group/context."),
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

const tools = [tabsContextTool, navigateTool, runJsTool];
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

  if (trimmed === "/tabs_context" || trimmed === "/tabs") {
    return {
      name: tabsContextTool.name,
      args: {},
    };
  }

  if (trimmed.startsWith("/navigate")) {
    const raw = trimmed.replace(/^\/navigate\s*/, "");
    const parts = raw.split(/\s+/).filter(Boolean);
    const parsedTabId = Number.parseInt(parts[0] ?? "", 10);
    const target = parts.slice(1).join(" ").trim();
    if (Number.isInteger(parsedTabId) && target) {
      return {
        name: navigateTool.name,
        args: { tabId: parsedTabId, url: target },
      };
    }
  }

  if (trimmed.startsWith("/runjs")) {
    const script = trimmed.replace(/^\/runjs\s*/, "");
    return {
      name: runJsTool.name,
      args: { script: script || "throw new Error('No script provided')" },
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
        "Call tabs_context first when you need a valid tabId or when the user asks about available tabs. " +
        "Call navigate to open URLs or go back/forward on a specific tabId from tabs_context. " +
        "Call run_js_current_tab when user asks to run JavaScript on the current page. " +
        "For page location use window.location.href. Prefer scripts that return a value."
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
