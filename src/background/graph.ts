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

const tabsCreateTool = tool(
  async () => {
    const contextTab = await getCurrentContextTab();
    if (!contextTab?.windowId) {
      return JSON.stringify({
        success: false,
        action: "tabs_create",
        error: "No active tab/window found for current context.",
      });
    }

    try {
      const created = await chrome.tabs.create({
        windowId: contextTab.windowId,
        active: true,
      });

      if (typeof contextTab.groupId === "number" && contextTab.groupId >= 0 && created.id) {
        await chrome.tabs.group({
          tabIds: [created.id],
          groupId: contextTab.groupId,
        });
      }

      return JSON.stringify({
        success: true,
        action: "tabs_create",
        initialTabId: contextTab.id ?? null,
        createdTab: {
          tabId: created.id ?? null,
          title: created.title ?? "",
          url: created.url ?? "",
        },
      });
    } catch (error) {
      return JSON.stringify({
        success: false,
        action: "tabs_create",
        error: String(error),
      });
    }
  },
  {
    name: "tabs_create",
    description:
      "Create a new empty tab in the current tab group. This tool takes no parameters.",
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

const turnAnswerStartTool = tool(
  async () => {
    return JSON.stringify({
      success: true,
      action: "turn_answer_start",
      readyForResponse: true,
    });
  },
  {
    name: "turn_answer_start",
    description:
      "Call immediately before writing the final text response for a turn. This is a signaling tool with no parameters.",
    schema: z.object({}),
  }
);

const javascriptTool = tool(
  async ({ action, text, tabId }) => {
    if (action !== "javascript_exec") {
      return JSON.stringify({
        success: false,
        action,
        code: text,
        tabId,
        error: "Invalid action. Expected 'javascript_exec'.",
      });
    }

    const scope = await validateTabInCurrentScope(tabId);
    if (!scope.ok) {
      return JSON.stringify({
        success: false,
        action,
        code: text,
        tabId,
        error: scope.error,
      });
    }

    const debuggee: chrome.debugger.Debuggee = { tabId };
    try {
      await chrome.debugger.attach(debuggee, "1.3");
      await chrome.debugger.sendCommand(debuggee, "Runtime.enable");

      const evaluation = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
        expression: text,
        awaitPromise: true,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
      })) as {
        result?: { value?: unknown; description?: string };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };

      if (evaluation.exceptionDetails) {
        const message =
          evaluation.exceptionDetails.exception?.description ||
          evaluation.exceptionDetails.text ||
          "Unknown script error";
        return JSON.stringify({
          success: false,
          action,
          code: text,
          tabId,
          error: message,
        });
      }

      return JSON.stringify({
        success: true,
        action,
        code: text,
        tabId,
        result: evaluation.result?.value ?? evaluation.result?.description ?? "undefined",
      });
    } catch (error) {
      return JSON.stringify({
        success: false,
        action,
        code: text,
        tabId,
        error: String(error),
      });
    } finally {
      try {
        await chrome.debugger.detach(debuggee);
      } catch {
        // Ignore detach errors.
      }
    }
  },
  {
    name: "javascript_tool",
    description:
      "Execute JavaScript code in the context of a tab. Requires action='javascript_exec', text code, and tabId from tabs_context.",
    schema: z.object({
      action: z.literal("javascript_exec").describe("Must be 'javascript_exec'."),
      text: z
        .string()
        .min(1)
        .describe("JavaScript code to evaluate in page context. Do not include a return statement."),
      tabId: z.number().int().describe("Tab ID to execute code in. Must be in current tab group/context."),
    }),
  }
);

const tools = [tabsContextTool, tabsCreateTool, navigateTool, javascriptTool, turnAnswerStartTool];
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

function getMessageId(message: BaseMessage): string | undefined {
  const msg = message as unknown as { id?: string };
  return msg.id;
}

function getToolCallSummary(message: BaseMessage): string | null {
  const maybeAi = message as unknown as {
    tool_calls?: Array<{ name?: string }>;
  };
  const names = (maybeAi.tool_calls ?? [])
    .map((call) => call.name?.trim())
    .filter((name): name is string => Boolean(name));

  if (names.length === 0) {
    return null;
  }

  if (names.length === 1) {
    return `Calling tool: ${names[0]}`;
  }

  return `Calling tools: ${names.join(", ")}`;
}

function parseDirectCommand(input: string): ToolCall | null {
  const trimmed = input.trim();

  if (trimmed === "/tabs_context" || trimmed === "/tabs") {
    return {
      name: tabsContextTool.name,
      args: {},
    };
  }

  if (trimmed === "/tabs_create" || trimmed === "/newtab") {
    return {
      name: tabsCreateTool.name,
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

  if (trimmed.startsWith("/javascript_exec")) {
    const raw = trimmed.replace(/^\/javascript_exec\s*/, "");
    const parts = raw.split(/\s+/).filter(Boolean);
    const parsedTabId = Number.parseInt(parts[0] ?? "", 10);
    const script = parts.slice(1).join(" ").trim();
    if (Number.isInteger(parsedTabId) && script) {
      return {
        name: javascriptTool.name,
        args: {
          action: "javascript_exec",
          tabId: parsedTabId,
          text: script,
        },
      };
    }
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
        "Call tabs_create to create a new tab in the current tab group/context. " +
        "Call navigate to open URLs or go back/forward on a specific tabId from tabs_context. " +
        "Call javascript_tool with action='javascript_exec', text, and tabId when user asks to run JavaScript on a page. " +
        "Call turn_answer_start immediately before your final user-facing response in every turn. " +
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
  let content = getTextContent(message.content);

  if (type === "human") {
    return { role: "user", content };
  }
  if (type === "tool") {
    return { role: "tool", content };
  }
  if (!content.trim()) {
    const summary = getToolCallSummary(message);
    if (summary) {
      content = summary;
    }
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

export async function runGraphTurn(
  threadId: string,
  input: string,
  settings: LlmSettings,
  seed?: PersistedThreadState,
  onProgress?: (message: PersistedMessage) => void
) {
  const threadConfig = {
    configurable: {
      thread_id: threadId,
    },
  };

  let previousMessageCount = 0;
  let hasCheckpoint = false;
  let checkpointMessagesCount = 0;
  try {
    const checkpointState = await graph.getState(threadConfig);
    hasCheckpoint = Boolean(checkpointState?.values);
    const rawMessages = (checkpointState?.values as { messages?: unknown } | undefined)?.messages;
    if (Array.isArray(rawMessages)) {
      checkpointMessagesCount = rawMessages.length;
    }
  } catch {
    hasCheckpoint = false;
  }

  const seedMessages = hasCheckpoint
    ? []
    : (seed?.messages ?? []).map(fromPersistedMessage);
  previousMessageCount = hasCheckpoint ? checkpointMessagesCount : seedMessages.length;

  let state: Awaited<ReturnType<typeof graph.invoke>> | null = null;
  fallbackSettings = settings;
  try {
    const stream = (await graph.stream(
      {
        messages: [...seedMessages, new HumanMessage(input)],
      },
      {
        ...threadConfig,
        streamMode: "values",
      }
    )) as AsyncIterable<{ messages?: BaseMessage[] }>;

    const emittedMessageIds = new Set<string>();
    for await (const chunk of stream) {
      const streamMessages = chunk.messages;
      if (!streamMessages || !Array.isArray(streamMessages)) {
        continue;
      }

      state = chunk as Awaited<ReturnType<typeof graph.invoke>>;
      if (!onProgress) {
        continue;
      }

      const candidateMessages = streamMessages.slice(previousMessageCount);
      for (const message of candidateMessages) {
        const messageId = getMessageId(message);
        if (messageId && emittedMessageIds.has(messageId)) {
          continue;
        }
        if (messageId) {
          emittedMessageIds.add(messageId);
        }

        const persisted = toPersistedMessage(message);
        if (persisted.role !== "assistant" || !persisted.content.trim()) {
          continue;
        }
        onProgress(persisted);
      }
    }
  } finally {
    fallbackSettings = undefined;
  }

  if (!state) {
    state = await graph.invoke(
      {
        messages: [...seedMessages, new HumanMessage(input)],
      },
      threadConfig
    );
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
