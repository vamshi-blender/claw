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

function classifyDeviceType(width: number) {
  if (width <= 480) {
    return "mobile";
  }
  if (width <= 1024) {
    return "tablet";
  }
  return "desktop";
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

const resizeWindowTool = tool(
  async ({ width, height, tabId }) => {
    const scope = await validateTabInCurrentScope(tabId);
    if (!scope.ok) {
      return JSON.stringify({
        success: false,
        action: "resize_window",
        tabId,
        error: scope.error,
      });
    }

    const windowId = scope.targetTab.windowId;
    if (windowId === undefined) {
      return JSON.stringify({
        success: false,
        action: "resize_window",
        tabId,
        error: "No browser window found for target tab.",
      });
    }

    try {
      const previous = await chrome.windows.get(windowId);
      const updated = await chrome.windows.update(windowId, {
        width,
        height,
        state: "normal",
      });

      const finalWidth = updated.width ?? width;
      const finalHeight = updated.height ?? height;
      const deviceType = classifyDeviceType(finalWidth);
      const orientation = finalWidth >= finalHeight ? "landscape" : "portrait";

      return JSON.stringify({
        success: true,
        action: "resize_window",
        tabId,
        previousDimensions: {
          width: previous.width ?? null,
          height: previous.height ?? null,
        },
        newDimensions: {
          width: finalWidth,
          height: finalHeight,
        },
        deviceType,
        orientation,
      });
    } catch (error) {
      return JSON.stringify({
        success: false,
        action: "resize_window",
        tabId,
        error: String(error),
      });
    }
  },
  {
    name: "resize_window",
    description:
      "Resize the browser window for a specific tab. Requires width, height, and tabId from tabs_context.",
    schema: z.object({
      width: z.number().int().positive().describe("Target window width in pixels."),
      height: z.number().int().positive().describe("Target window height in pixels."),
      tabId: z.number().int().describe("Tab ID used to identify which window to resize."),
    }),
  }
);

const getPageTextTool = tool(
  async ({ tabId, max_chars }) => {
    const scope = await validateTabInCurrentScope(tabId);
    if (!scope.ok) {
      return `Error: ${scope.error}`;
    }

    const maxChars = typeof max_chars === "number" ? max_chars : 50000;
    const debuggee: chrome.debugger.Debuggee = { tabId };

    try {
      await chrome.debugger.attach(debuggee, "1.3");
      await chrome.debugger.sendCommand(debuggee, "Runtime.enable");

      const extractionScript = `(() => {
        const clean = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
        const article = document.querySelector("article");
        const main = document.querySelector("main");
        const target = article || main || document.body;
        const text = clean(target ? (target.innerText || target.textContent || "") : "");
        return text;
      })()`;

      const evaluation = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
        expression: extractionScript,
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
          "Unknown extraction error";
        return `Error: ${message}`;
      }

      const text = String(evaluation.result?.value ?? "").trim();
      if (!text) {
        return "";
      }

      if (text.length > maxChars) {
        return `Error: Page text length (${text.length}) exceeds max_chars (${maxChars}). Increase max_chars or narrow the target page.`;
      }

      return text;
    } catch (error) {
      return `Error: ${String(error)}`;
    } finally {
      try {
        await chrome.debugger.detach(debuggee);
      } catch {
        // Ignore detach errors.
      }
    }
  },
  {
    name: "get_page_text",
    description:
      "Extract raw text from a tab, prioritizing article/main content. Returns plain text. Requires tabId; optional max_chars (default 50000).",
    schema: z.object({
      tabId: z.number().int().describe("Tab ID to extract text from. Must be in current tab group/context."),
      max_chars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum characters to return. Defaults to 50000."),
    }),
  }
);

const readPageTool = tool(
  async ({ tabId, depth, filter, max_chars, ref_id }) => {
    const scope = await validateTabInCurrentScope(tabId);
    if (!scope.ok) {
      return JSON.stringify({
        error: scope.error,
      });
    }

    const maxDepth = typeof depth === "number" ? depth : 15;
    const mode = filter ?? "all";
    const maxChars = typeof max_chars === "number" ? max_chars : 50000;
    const debuggee: chrome.debugger.Debuggee = { tabId };

    try {
      await chrome.debugger.attach(debuggee, "1.3");
      await chrome.debugger.sendCommand(debuggee, "Runtime.enable");

      const extractionScript = `(() => {
        const maxDepth = ${JSON.stringify(maxDepth)};
        const mode = ${JSON.stringify(mode)};
        const refId = ${JSON.stringify(ref_id ?? null)};

        const isElementInteractive = (el) => {
          if (!(el instanceof Element)) return false;
          const tag = el.tagName.toLowerCase();
          const role = (el.getAttribute("role") || "").toLowerCase();
          const hasHref = tag === "a" && !!el.getAttribute("href");
          const nativeInteractive = ["button", "input", "select", "textarea", "summary"].includes(tag);
          const roleInteractive = ["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "textbox", "combobox", "searchbox", "slider", "spinbutton"].includes(role);
          const tabbable = el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1";
          const editable = (el).isContentEditable === true;
          return hasHref || nativeInteractive || roleInteractive || tabbable || editable;
        };

        const refHash = (input) => {
          let hash = 0;
          for (let i = 0; i < input.length; i += 1) {
            hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
          }
          return Math.abs(hash).toString(36);
        };

        const getNodeName = (el) => {
          if (!(el instanceof Element)) return "";
          const ariaLabel = el.getAttribute("aria-label");
          if (ariaLabel) return ariaLabel.trim();
          const labelledBy = el.getAttribute("aria-labelledby");
          if (labelledBy) {
            const parts = labelledBy
              .split(/\\s+/)
              .map((id) => document.getElementById(id)?.textContent?.trim())
              .filter(Boolean);
            if (parts.length > 0) return parts.join(" ");
          }
          if (el instanceof HTMLInputElement && el.labels && el.labels.length > 0) {
            const labelText = Array.from(el.labels).map((l) => l.textContent?.trim()).filter(Boolean).join(" ");
            if (labelText) return labelText;
          }
          const title = el.getAttribute("title");
          if (title) return title.trim();
          const alt = el.getAttribute("alt");
          if (alt) return alt.trim();
          const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
          return text.slice(0, 120);
        };

        const getType = (el) => {
          if (!(el instanceof Element)) return "node";
          const role = (el.getAttribute("role") || "").toLowerCase();
          if (role) return role;
          const tag = el.tagName.toLowerCase();
          if (tag === "input") {
            const type = (el.getAttribute("type") || "text").toLowerCase();
            if (type === "checkbox") return "checkbox";
            if (type === "radio") return "radio";
            if (type === "search") return "searchbox";
            if (type === "email" || type === "text" || type === "password" || type === "number") return "textbox";
          }
          if (tag === "textarea") return "textbox";
          if (tag === "a") return "link";
          return tag;
        };

        const buildNode = (el, currentDepth, path) => {
          if (!(el instanceof Element)) return null;
          const ref = "ref_" + refHash(path);
          const node = {
            ref,
            type: getType(el),
          };

          const name = getNodeName(el);
          if (name) node.name = name;
          if (el instanceof HTMLAnchorElement && el.getAttribute("href")) node.url = el.getAttribute("href");
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) node.value = el.value ?? "";
          if (el instanceof HTMLInputElement) {
            if (el.type === "checkbox" || el.type === "radio") node.checked = el.checked;
            if (el.type) node.inputType = el.type;
            if (el.placeholder) node.placeholder = el.placeholder;
          }
          if (el instanceof HTMLSelectElement) {
            node.options = Array.from(el.options).map((o) => o.text);
            node.value = el.value;
          }
          if ("disabled" in el) node.disabled = !!el.disabled;
          if (/^h[1-6]$/.test(el.tagName.toLowerCase())) node.level = Number(el.tagName[1]);
          if (["h1", "h2", "h3", "h4", "h5", "h6", "p", "span"].includes(el.tagName.toLowerCase())) {
            const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
            if (text) node.text = text.slice(0, 200);
          }

          if (currentDepth >= maxDepth) return node;

          const children = [];
          const allChildren = Array.from(el.children);
          for (let i = 0; i < allChildren.length; i += 1) {
            const child = allChildren[i];
            const childPath = path + ">" + child.tagName.toLowerCase() + ":" + i;
            const childNode = buildNode(child, currentDepth + 1, childPath);
            if (!childNode) continue;
            if (mode === "interactive") {
              if (isElementInteractive(child)) {
                children.push(childNode);
              }
            } else {
              children.push(childNode);
            }
          }
          if (children.length > 0 && mode !== "interactive") {
            node.children = children;
          }
          return node;
        };

        const rootEl = document.documentElement || document.body;
        if (!rootEl) return { tree: [] };

        const rootPath = rootEl.tagName.toLowerCase() + ":0";
        const fullTree = buildNode(rootEl, 0, rootPath);
        if (!fullTree) return { tree: [] };

        const flattenInteractive = (node, acc) => {
          if (!node) return;
          const el = document.querySelector("*"); // placeholder for type narrowing only
          if (node.type && node.ref) {
            // Keep flattened nodes for interactive mode
            acc.push(Object.fromEntries(Object.entries(node).filter(([k]) => k !== "children")));
          }
          if (node.children) {
            for (const child of node.children) flattenInteractive(child, acc);
          }
        };

        const findByRef = (node, targetRef) => {
          if (!node) return null;
          if (node.ref === targetRef) return node;
          if (!node.children) return null;
          for (const child of node.children) {
            const found = findByRef(child, targetRef);
            if (found) return found;
          }
          return null;
        };

        if (mode === "interactive") {
          const interactiveCandidates = [];
          const walk = (el, currentDepth, path) => {
            if (!(el instanceof Element) || currentDepth > maxDepth) return;
            if (isElementInteractive(el)) {
              const node = buildNode(el, currentDepth, path);
              if (node) {
                delete node.children;
                interactiveCandidates.push(node);
              }
            }
            const allChildren = Array.from(el.children);
            for (let i = 0; i < allChildren.length; i += 1) {
              const child = allChildren[i];
              const childPath = path + ">" + child.tagName.toLowerCase() + ":" + i;
              walk(child, currentDepth + 1, childPath);
            }
          };
          walk(rootEl, 0, rootPath);
          if (refId) {
            const matched = interactiveCandidates.find((n) => n.ref === refId);
            return { tree: matched ? [matched] : [] };
          }
          return { tree: interactiveCandidates };
        }

        if (refId) {
          const focused = findByRef(fullTree, refId);
          return { tree: focused ? [focused] : [] };
        }

        return { tree: [fullTree] };
      })()`;

      const evaluation = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
        expression: extractionScript,
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
          "Unknown read_page error";
        return JSON.stringify({ error: message });
      }

      const payload = evaluation.result?.value ?? { tree: [] };
      const serialized = JSON.stringify(payload);
      if (serialized.length > maxChars) {
        return JSON.stringify({
          error:
            `Output exceeds max_chars (${maxChars}). Use smaller depth, filter='interactive', or ref_id to focus a subtree.`,
        });
      }

      return serialized;
    } catch (error) {
      return JSON.stringify({
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
    name: "read_page",
    description:
      "Read page structure as a ref-based tree. Supports tabId, optional depth (default 15), filter ('all'|'interactive'), max_chars (default 50000), and ref_id for focused subtree reads.",
    schema: z.object({
      tabId: z.number().int().describe("Tab ID to read from. Must be in current tab group/context."),
      depth: z.number().int().positive().optional().describe("Maximum traversal depth. Defaults to 15."),
      filter: z.enum(["interactive", "all"]).optional().describe("Element filter mode. Defaults to 'all'."),
      max_chars: z.number().int().positive().optional().describe("Maximum output size in characters. Defaults to 50000."),
      ref_id: z.string().optional().describe("Optional element ref to read focused subtree."),
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

const tools = [
  tabsContextTool,
  tabsCreateTool,
  readPageTool,
  navigateTool,
  resizeWindowTool,
  getPageTextTool,
  javascriptTool,
  turnAnswerStartTool,
];
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

  if (trimmed.startsWith("/read_page")) {
    const raw = trimmed.replace(/^\/read_page\s*/, "");
    const parts = raw.split(/\s+/).filter(Boolean);
    const parsedTabId = Number.parseInt(parts[0] ?? "", 10);
    if (Number.isInteger(parsedTabId)) {
      const parsedDepth = Number.parseInt(parts[1] ?? "", 10);
      const parsedFilter = parts[2];
      const parsedMaxChars = Number.parseInt(parts[3] ?? "", 10);
      const parsedRefId = parts[4];
      return {
        name: readPageTool.name,
        args: {
          tabId: parsedTabId,
          ...(Number.isInteger(parsedDepth) ? { depth: parsedDepth } : {}),
          ...((parsedFilter === "interactive" || parsedFilter === "all") ? { filter: parsedFilter } : {}),
          ...(Number.isInteger(parsedMaxChars) ? { max_chars: parsedMaxChars } : {}),
          ...(parsedRefId ? { ref_id: parsedRefId } : {}),
        },
      };
    }
  }

  if (trimmed.startsWith("/resize")) {
    const raw = trimmed.replace(/^\/resize\s*/, "");
    const parts = raw.split(/\s+/).filter(Boolean);
    const parsedTabId = Number.parseInt(parts[0] ?? "", 10);
    const parsedWidth = Number.parseInt(parts[1] ?? "", 10);
    const parsedHeight = Number.parseInt(parts[2] ?? "", 10);
    if (Number.isInteger(parsedTabId) && Number.isInteger(parsedWidth) && Number.isInteger(parsedHeight)) {
      return {
        name: resizeWindowTool.name,
        args: {
          tabId: parsedTabId,
          width: parsedWidth,
          height: parsedHeight,
        },
      };
    }
  }

  if (trimmed.startsWith("/get_page_text")) {
    const raw = trimmed.replace(/^\/get_page_text\s*/, "");
    const parts = raw.split(/\s+/).filter(Boolean);
    const parsedTabId = Number.parseInt(parts[0] ?? "", 10);
    const parsedMaxChars = Number.parseInt(parts[1] ?? "", 10);
    if (Number.isInteger(parsedTabId)) {
      return {
        name: getPageTextTool.name,
        args: Number.isInteger(parsedMaxChars)
          ? { tabId: parsedTabId, max_chars: parsedMaxChars }
          : { tabId: parsedTabId },
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
        "Call read_page with tabId and optional depth/filter/max_chars/ref_id to inspect page structure and get ref IDs. " +
        "Call navigate to open URLs or go back/forward on a specific tabId from tabs_context. " +
        "Call resize_window with width, height, and tabId when user asks to resize viewport/window. " +
        "Call get_page_text with tabId and optional max_chars to read plain text content from pages. " +
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
