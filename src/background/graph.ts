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

const COMPUTER_ACTIONS = [
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
] as const;

type ComputerAction = (typeof COMPUTER_ACTIONS)[number];
type ModifierName = "alt" | "ctrl" | "meta" | "shift";

type ElementSummary = {
  ref: string;
  type: string;
  name?: string;
  visible: boolean;
};

type StoredScreenshot = {
  id: string;
  tabId: number;
  kind: "screenshot" | "zoom";
  dataUrl: string;
  width: number;
  height: number;
  createdAt: string;
  region?: [number, number, number, number];
};

type TabLockState = {
  busy: boolean;
  waiters: Array<() => void>;
};

const tabActionLocks = new Map<number, TabLockState>();
const screenshotStore = new Map<string, StoredScreenshot>();
const MAX_STORED_SCREENSHOTS = 30;
let screenshotCounter = 0;

const MODIFIER_BITS: Record<ModifierName, number> = {
  alt: 1,
  ctrl: 2,
  meta: 4,
  shift: 8,
};

const MODIFIER_ORDER: ModifierName[] = ["ctrl", "shift", "alt", "meta"];

type KeyDefinition = {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withTabActionLock<T>(tabId: number, action: () => Promise<T>): Promise<T> {
  let lock = tabActionLocks.get(tabId);
  if (!lock) {
    lock = { busy: false, waiters: [] };
    tabActionLocks.set(tabId, lock);
  }

  if (lock.busy) {
    await new Promise<void>((resolve) => {
      lock!.waiters.push(resolve);
    });
  }

  lock.busy = true;
  try {
    return await action();
  } finally {
    const next = lock.waiters.shift();
    if (next) {
      next();
    } else {
      lock.busy = false;
      tabActionLocks.delete(tabId);
    }
  }
}

async function withDebuggerSession<T>(
  tabId: number,
  action: (debuggee: chrome.debugger.Debuggee) => Promise<T>
): Promise<T> {
  const debuggee: chrome.debugger.Debuggee = { tabId };
  await chrome.debugger.attach(debuggee, "1.3");
  try {
    return await action(debuggee);
  } finally {
    try {
      await chrome.debugger.detach(debuggee);
    } catch {
      // Ignore detach errors.
    }
  }
}

function parseModifierString(raw: string | undefined) {
  if (!raw || !raw.trim()) {
    return { ok: true as const, bitmask: 0, normalized: undefined as string | undefined };
  }

  const aliases: Record<string, ModifierName> = {
    ctrl: "ctrl",
    control: "ctrl",
    shift: "shift",
    alt: "alt",
    cmd: "meta",
    command: "meta",
    meta: "meta",
    win: "meta",
    windows: "meta",
  };

  const tokens = raw
    .split("+")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

  const deduped = new Set<ModifierName>();
  for (const token of tokens) {
    const normalized = aliases[token];
    if (!normalized) {
      return {
        ok: false as const,
        error:
          `Invalid modifier '${token}'. Supported modifiers: ctrl, shift, alt, cmd/meta, win/windows.`,
      };
    }
    deduped.add(normalized);
  }

  let bitmask = 0;
  const ordered = MODIFIER_ORDER.filter((name) => deduped.has(name));
  for (const name of ordered) {
    bitmask |= MODIFIER_BITS[name];
  }

  return {
    ok: true as const,
    bitmask,
    normalized: ordered.length > 0 ? ordered.join("+") : undefined,
  };
}

function normalizePoint(point: [number, number]): [number, number] {
  return [Math.round(point[0]), Math.round(point[1])];
}

function normalizeRegion(region: [number, number, number, number]) {
  const [x0, y0, x1, y1] = region;
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function nextScreenshotId() {
  screenshotCounter += 1;
  return `screenshot_${String(screenshotCounter).padStart(6, "0")}`;
}

function storeScreenshot(
  tabId: number,
  kind: "screenshot" | "zoom",
  dataUrl: string,
  width: number,
  height: number,
  region?: [number, number, number, number]
) {
  const id = nextScreenshotId();
  screenshotStore.set(id, {
    id,
    tabId,
    kind,
    dataUrl,
    width,
    height,
    createdAt: new Date().toISOString(),
    ...(region ? { region } : {}),
  });

  while (screenshotStore.size > MAX_STORED_SCREENSHOTS) {
    const oldest = screenshotStore.keys().next();
    if (oldest.done) {
      break;
    }
    screenshotStore.delete(oldest.value);
  }

  return id;
}

function keyDefinitionFromName(input: string): KeyDefinition | null {
  const raw = input.trim();
  if (!raw) {
    return null;
  }

  const lowered = raw.toLowerCase();
  const specials: Record<string, KeyDefinition> = {
    enter: { key: "Enter", code: "Enter", keyCode: 13 },
    tab: { key: "Tab", code: "Tab", keyCode: 9 },
    backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    delete: { key: "Delete", code: "Delete", keyCode: 46 },
    del: { key: "Delete", code: "Delete", keyCode: 46 },
    escape: { key: "Escape", code: "Escape", keyCode: 27 },
    esc: { key: "Escape", code: "Escape", keyCode: 27 },
    space: { key: " ", code: "Space", keyCode: 32, text: " " },
    spacebar: { key: " ", code: "Space", keyCode: 32, text: " " },
    arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    home: { key: "Home", code: "Home", keyCode: 36 },
    end: { key: "End", code: "End", keyCode: 35 },
    pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
    pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
    insert: { key: "Insert", code: "Insert", keyCode: 45 },
    control: { key: "Control", code: "ControlLeft", keyCode: 17 },
    ctrl: { key: "Control", code: "ControlLeft", keyCode: 17 },
    shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
    alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
    meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
    cmd: { key: "Meta", code: "MetaLeft", keyCode: 91 },
    windows: { key: "Meta", code: "MetaLeft", keyCode: 91 },
    win: { key: "Meta", code: "MetaLeft", keyCode: 91 },
  };

  if (specials[lowered]) {
    return specials[lowered];
  }

  const functionMatch = lowered.match(/^f([1-9]|1[0-2])$/);
  if (functionMatch) {
    const number = Number.parseInt(functionMatch[1], 10);
    return {
      key: `F${number}`,
      code: `F${number}`,
      keyCode: 111 + number,
    };
  }

  if (/^[a-z]$/i.test(raw)) {
    const upper = raw.toUpperCase();
    return {
      key: raw.length === 1 ? raw : upper,
      code: `Key${upper}`,
      keyCode: upper.charCodeAt(0),
      text: raw.length === 1 ? raw : undefined,
    };
  }

  if (/^\d$/.test(raw)) {
    return {
      key: raw,
      code: `Digit${raw}`,
      keyCode: raw.charCodeAt(0),
      text: raw,
    };
  }

  const punctuation: Record<string, KeyDefinition> = {
    ".": { key: ".", code: "Period", keyCode: 190, text: "." },
    ",": { key: ",", code: "Comma", keyCode: 188, text: "," },
    "/": { key: "/", code: "Slash", keyCode: 191, text: "/" },
    "\\": { key: "\\", code: "Backslash", keyCode: 220, text: "\\" },
    "-": { key: "-", code: "Minus", keyCode: 189, text: "-" },
    "=": { key: "=", code: "Equal", keyCode: 187, text: "=" },
    ";": { key: ";", code: "Semicolon", keyCode: 186, text: ";" },
    "'": { key: "'", code: "Quote", keyCode: 222, text: "'" },
    "[": { key: "[", code: "BracketLeft", keyCode: 219, text: "[" },
    "]": { key: "]", code: "BracketRight", keyCode: 221, text: "]" },
    "`": { key: "`", code: "Backquote", keyCode: 192, text: "`" },
  };
  if (punctuation[raw]) {
    return punctuation[raw];
  }

  return null;
}

async function dispatchClick(
  debuggee: chrome.debugger.Debuggee,
  coordinate: [number, number],
  button: "left" | "right",
  clickCount: number,
  modifiersBitmask: number
) {
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: coordinate[0],
    y: coordinate[1],
    modifiers: modifiersBitmask,
  });

  const buttonMask = button === "left" ? 1 : 2;
  for (let i = 1; i <= clickCount; i += 1) {
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: coordinate[0],
      y: coordinate[1],
      button,
      buttons: buttonMask,
      clickCount: i,
      modifiers: modifiersBitmask,
    });
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: coordinate[0],
      y: coordinate[1],
      button,
      buttons: 0,
      clickCount: i,
      modifiers: modifiersBitmask,
    });
  }
}

async function dispatchDrag(
  debuggee: chrome.debugger.Debuggee,
  start: [number, number],
  end: [number, number],
  modifiersBitmask: number
) {
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: start[0],
    y: start[1],
    modifiers: modifiersBitmask,
  });
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: start[0],
    y: start[1],
    button: "left",
    buttons: 1,
    clickCount: 1,
    modifiers: modifiersBitmask,
  });

  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const distance = Math.hypot(dx, dy);
  const steps = Math.max(8, Math.min(30, Math.round(distance / 20)));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const x = Math.round(start[0] + dx * t);
    const y = Math.round(start[1] + dy * t);
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      buttons: 1,
      modifiers: modifiersBitmask,
    });
  }

  await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: end[0],
    y: end[1],
    button: "left",
    buttons: 0,
    clickCount: 1,
    modifiers: modifiersBitmask,
  });
}

async function dispatchScroll(
  debuggee: chrome.debugger.Debuggee,
  coordinate: [number, number],
  direction: "up" | "down" | "left" | "right",
  amount: number,
  modifiersBitmask: number
) {
  const tickPixels = 120;
  const magnitude = Math.max(1, Math.round(amount)) * tickPixels;
  const deltaX = direction === "left" ? -magnitude : direction === "right" ? magnitude : 0;
  const deltaY = direction === "up" ? -magnitude : direction === "down" ? magnitude : 0;

  await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: coordinate[0],
    y: coordinate[1],
    deltaX,
    deltaY,
    modifiers: modifiersBitmask,
  });
}

function parseKeyToken(token: string) {
  const parts = token
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return null;
  }

  const modifierAliases: Record<string, ModifierName> = {
    ctrl: "ctrl",
    control: "ctrl",
    shift: "shift",
    alt: "alt",
    cmd: "meta",
    command: "meta",
    meta: "meta",
    win: "meta",
    windows: "meta",
  };

  const modifiers = new Set<ModifierName>();
  const keys: string[] = [];

  for (const part of parts) {
    const lowered = part.toLowerCase();
    const modifier = modifierAliases[lowered];
    if (modifier) {
      modifiers.add(modifier);
    } else {
      keys.push(part);
    }
  }

  if (keys.length > 1) {
    return null;
  }

  if (keys.length === 0) {
    const fallback = MODIFIER_ORDER.find((name) => modifiers.has(name));
    if (!fallback) {
      return null;
    }
    const fallbackKey = fallback === "ctrl"
      ? "Control"
      : fallback === "shift"
      ? "Shift"
      : fallback === "alt"
      ? "Alt"
      : "Meta";
    return { modifiers: Array.from(modifiers), key: fallbackKey };
  }

  return { modifiers: Array.from(modifiers), key: keys[0] };
}

async function dispatchKeyToken(
  debuggee: chrome.debugger.Debuggee,
  token: string,
  baseModifierBitmask: number
) {
  const parsed = parseKeyToken(token);
  if (!parsed) {
    return { ok: false as const, error: `Invalid key token '${token}'.` };
  }

  let tokenModifierBitmask = 0;
  for (const mod of parsed.modifiers) {
    tokenModifierBitmask |= MODIFIER_BITS[mod];
  }

  const keyDef = keyDefinitionFromName(parsed.key);
  if (!keyDef) {
    return { ok: false as const, error: `Unsupported key '${parsed.key}'.` };
  }

  const modifiers = baseModifierBitmask | tokenModifierBitmask;
  const hasNonShiftModifier = (modifiers & (MODIFIER_BITS.alt | MODIFIER_BITS.ctrl | MODIFIER_BITS.meta)) !== 0;
  const printableText = keyDef.text && !hasNonShiftModifier ? keyDef.text : undefined;

  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
    type: printableText ? "keyDown" : "rawKeyDown",
    key: keyDef.key,
    code: keyDef.code,
    windowsVirtualKeyCode: keyDef.keyCode,
    nativeVirtualKeyCode: keyDef.keyCode,
    modifiers,
    ...(printableText ? { text: printableText, unmodifiedText: printableText } : {}),
  });
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: keyDef.key,
    code: keyDef.code,
    windowsVirtualKeyCode: keyDef.keyCode,
    nativeVirtualKeyCode: keyDef.keyCode,
    modifiers,
  });

  return { ok: true as const, key: keyDef.key };
}

async function resolveRefToElement(
  tabId: number,
  ref: string,
  scrollIntoView: boolean
): Promise<
  | { success: true; coordinate: [number, number]; element: ElementSummary }
  | { success: false; error: string }
> {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [ref, scrollIntoView],
    func: (targetRef: string, shouldScroll: boolean) => {
      const refHash = (input: string) => {
        let hash = 0;
        for (let i = 0; i < input.length; i += 1) {
          hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
        }
        return Math.abs(hash).toString(36);
      };

      const getRef = (path: string) => `ref_${refHash(path)}`;

      const getType = (el: Element) => {
        const role = (el.getAttribute("role") || "").toLowerCase();
        if (role) return role;
        const tag = el.tagName.toLowerCase();
        if (tag === "input") {
          const inputType = (el.getAttribute("type") || "text").toLowerCase();
          if (inputType === "checkbox") return "checkbox";
          if (inputType === "radio") return "radio";
          if (inputType === "search") return "searchbox";
          return "textbox";
        }
        if (tag === "textarea") return "textbox";
        if (tag === "a") return "link";
        return tag;
      };

      const getName = (el: Element) => {
        const aria = (el.getAttribute("aria-label") || "").trim();
        if (aria) return aria;
        const title = (el.getAttribute("title") || "").trim();
        if (title) return title;
        if (el instanceof HTMLInputElement && el.labels && el.labels.length > 0) {
          const labelText = Array.from(el.labels)
            .map((label) => (label.textContent || "").trim())
            .filter(Boolean)
            .join(" ");
          if (labelText) return labelText;
        }
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        return text.slice(0, 120);
      };

      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const root = document.documentElement || document.body;
      if (!root) {
        return { success: false, error: "No document root found." };
      }

      const findByRef = (
        el: Element,
        path: string
      ): { target: Element; path: string } | null => {
        if (getRef(path) === targetRef) {
          return { target: el, path };
        }

        const children = Array.from(el.children);
        for (let i = 0; i < children.length; i += 1) {
          const child = children[i];
          const childPath = `${path}>${child.tagName.toLowerCase()}:${i}`;
          const found = findByRef(child, childPath);
          if (found) {
            return found;
          }
        }
        return null;
      };

      const found = findByRef(root, `${root.tagName.toLowerCase()}:0`);
      if (!found) {
        return {
          success: false,
          error: "Element reference not found. Use read_page/find again to refresh refs.",
        };
      }

      if (shouldScroll && found.target instanceof HTMLElement) {
        found.target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      }

      const rect = found.target.getBoundingClientRect();
      return {
        success: true,
        coordinate: [Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2)],
        element: {
          ref: targetRef,
          type: getType(found.target),
          name: getName(found.target) || undefined,
          visible: isVisible(found.target),
        },
      };
    },
  });

  const result = injection?.result as
    | { success: true; coordinate: [number, number]; element: ElementSummary }
    | { success: false; error: string }
    | undefined;

  return (
    result ?? {
      success: false,
      error: "Failed to resolve element reference.",
    }
  );
}

async function describeElementAtCoordinate(tabId: number, coordinate: [number, number]) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [coordinate[0], coordinate[1]],
    func: (x: number, y: number) => {
      const refHash = (input: string) => {
        let hash = 0;
        for (let i = 0; i < input.length; i += 1) {
          hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
        }
        return Math.abs(hash).toString(36);
      };

      const buildPath = (el: Element) => {
        const segments: string[] = [];
        let current: Element | null = el;
        while (current) {
          const parent = current.parentElement;
          const index = parent ? Array.from(parent.children).indexOf(current) : 0;
          segments.push(`${current.tagName.toLowerCase()}:${Math.max(index, 0)}`);
          if (!parent) break;
          current = parent;
        }
        return segments.reverse().join(">");
      };

      const getType = (el: Element) => {
        const role = (el.getAttribute("role") || "").toLowerCase();
        if (role) return role;
        const tag = el.tagName.toLowerCase();
        if (tag === "input") {
          const inputType = (el.getAttribute("type") || "text").toLowerCase();
          if (inputType === "checkbox") return "checkbox";
          if (inputType === "radio") return "radio";
          if (inputType === "search") return "searchbox";
          return "textbox";
        }
        if (tag === "textarea") return "textbox";
        if (tag === "a") return "link";
        return tag;
      };

      const getName = (el: Element) => {
        const aria = (el.getAttribute("aria-label") || "").trim();
        if (aria) return aria;
        const title = (el.getAttribute("title") || "").trim();
        if (title) return title;
        if (el instanceof HTMLInputElement && el.labels && el.labels.length > 0) {
          const labelText = Array.from(el.labels)
            .map((label) => (label.textContent || "").trim())
            .filter(Boolean)
            .join(" ");
          if (labelText) return labelText;
        }
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        return text.slice(0, 120);
      };

      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const element = document.elementFromPoint(x, y);
      if (!element) {
        return { element: null, tooltipShown: false };
      }

      const path = buildPath(element);
      const tooltip = (element.getAttribute("title") || "").trim();

      return {
        element: {
          ref: `ref_${refHash(path)}`,
          type: getType(element),
          name: getName(element) || undefined,
          visible: isVisible(element),
        },
        tooltipShown: Boolean(tooltip),
        tooltipText: tooltip || undefined,
      };
    },
  });

  const result = injection?.result as
    | { element: ElementSummary | null; tooltipShown: boolean; tooltipText?: string }
    | undefined;
  return result ?? { element: null, tooltipShown: false };
}

async function readActiveFieldValue(tabId: number) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const active = document.activeElement;
      if (!active) {
        return { hasActiveField: false };
      }

      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        return {
          hasActiveField: true,
          value: active.value ?? "",
          inputType: active instanceof HTMLInputElement ? active.type : "textarea",
        };
      }

      if (active instanceof HTMLElement && active.isContentEditable) {
        return {
          hasActiveField: true,
          value: active.textContent ?? "",
          inputType: "contenteditable",
        };
      }

      return { hasActiveField: false };
    },
  });

  return (
    (injection?.result as { hasActiveField: boolean; value?: string; inputType?: string } | undefined) ??
    { hasActiveField: false }
  );
}

async function getScrollMetrics(tabId: number) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      pageWidth: Math.round(
        Math.max(document.body?.scrollWidth ?? 0, document.documentElement?.scrollWidth ?? 0)
      ),
      pageHeight: Math.round(
        Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0)
      ),
    }),
  });

  return (
    (injection?.result as { scrollX: number; scrollY: number; pageWidth: number; pageHeight: number } | undefined) ??
    { scrollX: 0, scrollY: 0, pageWidth: 0, pageHeight: 0 }
  );
}

async function getViewportMetrics(tabId: number) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    }),
  });

  return (
    (injection?.result as { width: number; height: number; devicePixelRatio: number } | undefined) ??
    { width: 0, height: 0, devicePixelRatio: 1 }
  );
}

async function captureTabScreenshotDataUrl(tabId: number) {
  return withDebuggerSession(tabId, async (debuggee) => {
    await chrome.debugger.sendCommand(debuggee, "Page.enable");
    const capture = (await chrome.debugger.sendCommand(debuggee, "Page.captureScreenshot", {
      format: "png",
    })) as { data?: string };

    if (!capture.data) {
      throw new Error("Screenshot capture returned no image data.");
    }

    return `data:image/png;base64,${capture.data}`;
  });
}

function isAbsoluteLocalPath(path: string) {
  if (!path) {
    return false;
  }

  if (/^[a-zA-Z]:\\/.test(path)) {
    return true;
  }
  if (/^\\\\[^\\]/.test(path)) {
    return true;
  }
  if (path.startsWith("/")) {
    return true;
  }

  return false;
}

async function getElementMetadataByRef(tabId: number, ref: string) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [ref],
    func: (targetRef: string) => {
      const refHash = (input: string) => {
        let hash = 0;
        for (let i = 0; i < input.length; i += 1) {
          hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
        }
        return Math.abs(hash).toString(36);
      };

      const getRef = (path: string) => `ref_${refHash(path)}`;
      const root = document.documentElement || document.body;
      if (!root) {
        return { success: false, error: "No document root found." };
      }

      const findByRef = (el: Element, path: string): Element | null => {
        if (getRef(path) === targetRef) {
          return el;
        }
        const children = Array.from(el.children);
        for (let i = 0; i < children.length; i += 1) {
          const child = children[i];
          const childPath = `${path}>${child.tagName.toLowerCase()}:${i}`;
          const found = findByRef(child, childPath);
          if (found) {
            return found;
          }
        }
        return null;
      };

      const target = findByRef(root, `${root.tagName.toLowerCase()}:0`);
      if (!target) {
        return {
          success: false,
          error: "Element reference not found. Use read_page/find again to refresh refs.",
        };
      }

      if (!(target instanceof HTMLInputElement)) {
        return {
          success: false,
          error: "Referenced element is not an input element.",
          tagName: target.tagName.toLowerCase(),
        };
      }

      const inputType = (target.type || "").toLowerCase();
      if (inputType !== "file") {
        return {
          success: false,
          error: `Referenced input is type='${inputType || "unknown"}', expected type='file'.`,
        };
      }

      return {
        success: true,
        targetElement: {
          ref: targetRef,
          type: "input",
          inputType: "file",
          multiple: target.multiple,
          ...(target.accept ? { accept: target.accept } : {}),
        },
      };
    },
  });

  return (
    (injection?.result as
      | {
          success: true;
          targetElement: {
            ref: string;
            type: "input";
            inputType: "file";
            multiple: boolean;
            accept?: string;
          };
        }
      | { success: false; error: string; tagName?: string }
      | undefined) ??
    { success: false as const, error: "Failed to inspect target file input element." }
  );
}

async function readUploadedFilesFromInput(tabId: number, ref: string) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [ref],
    func: async (targetRef: string) => {
      const refHash = (input: string) => {
        let hash = 0;
        for (let i = 0; i < input.length; i += 1) {
          hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
        }
        return Math.abs(hash).toString(36);
      };

      const getRef = (path: string) => `ref_${refHash(path)}`;
      const root = document.documentElement || document.body;
      if (!root) {
        return { success: false, error: "No document root found.", files: [] };
      }

      const findByRef = (el: Element, path: string): Element | null => {
        if (getRef(path) === targetRef) {
          return el;
        }
        const children = Array.from(el.children);
        for (let i = 0; i < children.length; i += 1) {
          const child = children[i];
          const childPath = `${path}>${child.tagName.toLowerCase()}:${i}`;
          const found = findByRef(child, childPath);
          if (found) {
            return found;
          }
        }
        return null;
      };

      const target = findByRef(root, `${root.tagName.toLowerCase()}:0`);
      if (!(target instanceof HTMLInputElement) || target.type.toLowerCase() !== "file") {
        return {
          success: false,
          error: "Target element is not a file input.",
          files: [],
        };
      }

      const files = Array.from(target.files ?? []);
      const filesUploaded: Array<{
        filename: string;
        size: number;
        mimeType?: string;
        dimensions?: string;
      }> = [];

      for (const file of files) {
        const fileData: {
          filename: string;
          size: number;
          mimeType?: string;
          dimensions?: string;
        } = {
          filename: file.name,
          size: file.size,
        };

        if (file.type) {
          fileData.mimeType = file.type;
        }

        if (file.type.startsWith("image/")) {
          try {
            const bitmap = await createImageBitmap(file);
            fileData.dimensions = `${bitmap.width}x${bitmap.height}`;
            bitmap.close();
          } catch {
            // Ignore image dimension parsing errors.
          }
        }

        filesUploaded.push(fileData);
      }

      return {
        success: true,
        files: filesUploaded,
      };
    },
  });

  return (
    (injection?.result as
      | {
          success: true;
          files: Array<{
            filename: string;
            size: number;
            mimeType?: string;
            dimensions?: string;
          }>;
        }
      | { success: false; error: string; files: unknown[] }
      | undefined) ??
    { success: false as const, error: "Failed to read uploaded file details from input.", files: [] }
  );
}

function getMimeTypeFromDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+)[;,]/i);
  return match?.[1]?.toLowerCase() ?? "application/octet-stream";
}

function ensureImageFilename(input: string | undefined, mimeType: string) {
  const fallbackExt = mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/webp" ? ".webp" : ".png";
  const trimmed = (input ?? "").trim();
  if (!trimmed) {
    return `image${fallbackExt}`;
  }
  if (/\.[a-zA-Z0-9]+$/.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}${fallbackExt}`;
}

async function dataUrlToBlob(dataUrl: string) {
  const response = await fetch(dataUrl);
  return response.blob();
}

function bytesToBase64(bytes: Uint8Array) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...Array.from(chunk));
  }
  return btoa(binary);
}

async function blobToDataUrl(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  const base64 = bytesToBase64(new Uint8Array(buffer));
  return `data:${blob.type || "application/octet-stream"};base64,${base64}`;
}

async function getImageDimensions(dataUrl: string) {
  const blob = await dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width;
  const height = bitmap.height;
  bitmap.close();
  return { width, height };
}

async function cropImageDataUrl(
  dataUrl: string,
  crop: { x: number; y: number; width: number; height: number }
) {
  const blob = await dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(crop.width, crop.height);
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("Unable to initialize 2D context for zoom crop.");
  }

  context.drawImage(
    bitmap,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    crop.width,
    crop.height
  );
  bitmap.close();

  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  return blobToDataUrl(outBlob);
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

const findTool = tool(
  async ({ query, tabId }) => {
    const scope = await validateTabInCurrentScope(tabId);
    if (!scope.ok) {
      return JSON.stringify({
        results: [],
        count: 0,
        error: scope.error,
      });
    }

    const debuggee: chrome.debugger.Debuggee = { tabId };
    try {
      await chrome.debugger.attach(debuggee, "1.3");
      await chrome.debugger.sendCommand(debuggee, "Runtime.enable");

      const extractionScript = `(() => {
        const query = ${JSON.stringify(query)}.toLowerCase().trim();
        const queryTokens = query.split(/\\s+/).filter(Boolean);

        const refHash = (input) => {
          let hash = 0;
          for (let i = 0; i < input.length; i += 1) {
            hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
          }
          return Math.abs(hash).toString(36);
        };

        const getType = (el) => {
          const role = (el.getAttribute("role") || "").toLowerCase();
          if (role) return role;
          const tag = el.tagName.toLowerCase();
          if (tag === "input") {
            const t = (el.getAttribute("type") || "text").toLowerCase();
            if (t === "search") return "searchbox";
            if (t === "checkbox") return "checkbox";
            if (t === "radio") return "radio";
            return "textbox";
          }
          if (tag === "textarea") return "textbox";
          if (tag === "a") return "link";
          return tag;
        };

        const getName = (el) => {
          const aria = (el.getAttribute("aria-label") || "").trim();
          if (aria) return aria;
          const title = (el.getAttribute("title") || "").trim();
          if (title) return title;
          if (el instanceof HTMLInputElement && el.labels && el.labels.length > 0) {
            const fromLabels = Array.from(el.labels).map((l) => (l.textContent || "").trim()).filter(Boolean).join(" ");
            if (fromLabels) return fromLabels;
          }
          const txt = (el.textContent || "").replace(/\\s+/g, " ").trim();
          if (txt) return txt.slice(0, 120);
          return "";
        };

        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const scoreElement = (el, type, name, text, placeholder, inputType) => {
          const haystack = [type, name, text, placeholder, inputType].join(" ").toLowerCase();
          if (!haystack.trim()) return 0;

          let score = 0;
          if (query && haystack.includes(query)) {
            score += 12;
          }
          for (const token of queryTokens) {
            if (haystack.includes(token)) {
              score += 2;
            }
          }

          if (query.includes("button") && type === "button") score += 4;
          if (query.includes("link") && type === "link") score += 4;
          if (query.includes("search") && (type === "searchbox" || placeholder.toLowerCase().includes("search"))) score += 5;
          if (query.includes("input") && (type === "textbox" || type === "searchbox")) score += 4;
          if (query.includes("checkbox") && type === "checkbox") score += 5;

          return score;
        };

        const root = document.documentElement || document.body;
        if (!root) return { results: [], count: 0 };

        const candidates = [];
        const walk = (el, path) => {
          if (!(el instanceof Element)) return;
          const type = getType(el);
          const name = getName(el);
          const text = (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 220);
          const placeholder = (el.getAttribute("placeholder") || "").trim();
          const inputType = el instanceof HTMLInputElement ? (el.type || "") : "";
          const score = scoreElement(el, type, name, text, placeholder, inputType);

          if (score > 0) {
            const rect = el.getBoundingClientRect();
            const visible = isVisible(el);
            const item = {
              ref: "ref_" + refHash(path),
              type,
              name,
              text,
              visible,
              coordinates: [Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2)],
              placeholder: placeholder || undefined,
              inputType: inputType || undefined,
              score,
            };
            candidates.push(item);
          }

          const children = Array.from(el.children);
          for (let i = 0; i < children.length; i += 1) {
            const child = children[i];
            const childPath = path + ">" + child.tagName.toLowerCase() + ":" + i;
            walk(child, childPath);
          }
        };

        walk(root, root.tagName.toLowerCase() + ":0");

        candidates.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          if (Number(b.visible) !== Number(a.visible)) return Number(b.visible) - Number(a.visible);
          return a.name.localeCompare(b.name);
        });

        const deduped = [];
        const seenRefs = new Set();
        for (const c of candidates) {
          if (seenRefs.has(c.ref)) continue;
          seenRefs.add(c.ref);
          deduped.push({
            ref: c.ref,
            type: c.type,
            name: c.name,
            ...(c.text ? { text: c.text } : {}),
            visible: c.visible,
            coordinates: c.coordinates,
            ...(c.placeholder ? { placeholder: c.placeholder } : {}),
            ...(c.inputType ? { inputType: c.inputType } : {}),
          });
        }

        const limited = deduped.length > 20;
        const results = deduped.slice(0, 20);
        return {
          results,
          count: results.length,
          ...(limited
            ? {
                limited: true,
                message:
                  "More than 20 matches found. Use a more specific query to narrow results.",
              }
            : {}),
        };
      })()`;

      const evaluation = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
        expression: extractionScript,
        awaitPromise: true,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
      })) as {
        result?: { value?: unknown };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };

      if (evaluation.exceptionDetails) {
        const message =
          evaluation.exceptionDetails.exception?.description ||
          evaluation.exceptionDetails.text ||
          "Unknown find error";
        return JSON.stringify({
          results: [],
          count: 0,
          error: message,
        });
      }

      return JSON.stringify(
        evaluation.result?.value ?? {
          results: [],
          count: 0,
        }
      );
    } catch (error) {
      return JSON.stringify({
        results: [],
        count: 0,
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
    name: "find",
    description:
      "Find elements on the page using natural language query and return up to 20 matches with refs usable by other tools.",
    schema: z.object({
      query: z.string().min(1).describe("Natural language element query, e.g. 'search bar' or 'submit button'."),
      tabId: z.number().int().describe("Tab ID to search in. Must be in current tab group/context."),
    }),
  }
);

const formInputTool = tool(
  async ({ ref, value, tabId }) => {
    const scope = await validateTabInCurrentScope(tabId);
    if (!scope.ok) {
      return JSON.stringify({
        success: false,
        action: "form_input",
        tabId,
        ref,
        error: scope.error,
      });
    }

    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        args: [ref, value],
        func: (targetRef: string, nextValue: string | boolean | number) => {
          const refHash = (input: string) => {
            let hash = 0;
            for (let i = 0; i < input.length; i += 1) {
              hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
            }
            return Math.abs(hash).toString(36);
          };

          const getRef = (path: string) => `ref_${refHash(path)}`;

          const root = document.documentElement || document.body;
          if (!root) {
            return {
              success: false,
              action: "form_input",
              ref: targetRef,
              error: "No document root found.",
            };
          }

          const findByRef = (el: Element, path: string): Element | null => {
            if (getRef(path) === targetRef) return el;

            const children = Array.from(el.children);
            for (let i = 0; i < children.length; i += 1) {
              const child = children[i];
              const childPath = `${path}>${child.tagName.toLowerCase()}:${i}`;
              const found = findByRef(child, childPath);
              if (found) return found;
            }
            return null;
          };

          const target = findByRef(root, `${root.tagName.toLowerCase()}:0`);
          if (!target) {
            return {
              success: false,
              action: "form_input",
              ref: targetRef,
              error: "Element reference not found. Use read_page or find again to refresh refs.",
            };
          }

          const fireValueEvents = (el: Element) => {
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          };

          const toBoolean = (input: unknown) => {
            if (typeof input === "boolean") return input;
            if (typeof input === "number") return input !== 0;
            if (typeof input === "string") {
              const lowered = input.trim().toLowerCase();
              if (["true", "1", "yes", "on"].includes(lowered)) return true;
              if (["false", "0", "no", "off", ""].includes(lowered)) return false;
            }
            return Boolean(input);
          };

          if (target instanceof HTMLInputElement) {
            const inputType = (target.type || "text").toLowerCase();
            if (inputType === "checkbox" || inputType === "radio") {
              target.checked = toBoolean(nextValue);
            } else {
              target.value = String(nextValue ?? "");
            }
            fireValueEvents(target);
            return {
              success: true,
              action: "form_input",
              ref: targetRef,
              elementType: "input",
              inputType,
              value: inputType === "checkbox" || inputType === "radio" ? target.checked : target.value,
            };
          }

          if (target instanceof HTMLTextAreaElement) {
            target.value = String(nextValue ?? "");
            fireValueEvents(target);
            return {
              success: true,
              action: "form_input",
              ref: targetRef,
              elementType: "textarea",
              value: target.value,
            };
          }

          if (target instanceof HTMLSelectElement) {
            const needle = String(nextValue ?? "").trim();
            const options = Array.from(target.options);
            const exactValue = options.find((o) => o.value === needle);
            const exactText = options.find((o) => o.text.trim() === needle);
            const ciText = options.find((o) => o.text.trim().toLowerCase() === needle.toLowerCase());
            const matched = exactValue ?? exactText ?? ciText ?? null;
            if (!matched) {
              return {
                success: false,
                action: "form_input",
                ref: targetRef,
                error: "No matching select option by value or text.",
                availableOptions: options.map((o) => ({ value: o.value, text: o.text })),
              };
            }
            target.value = matched.value;
            fireValueEvents(target);
            return {
              success: true,
              action: "form_input",
              ref: targetRef,
              elementType: "select",
              value: target.value,
              selectedText: matched.text,
            };
          }

          if (target instanceof HTMLElement && target.isContentEditable) {
            target.textContent = String(nextValue ?? "");
            fireValueEvents(target);
            return {
              success: true,
              action: "form_input",
              ref: targetRef,
              elementType: "contenteditable",
              value: target.textContent ?? "",
            };
          }

          return {
            success: false,
            action: "form_input",
            ref: targetRef,
            error: "Referenced element is not a supported form input type.",
            tagName: target.tagName.toLowerCase(),
          };
        },
      });

      const payload =
        injection?.result ??
        ({
          success: false,
          action: "form_input",
          tabId,
          ref,
          error: "No result returned from page evaluation.",
        } as const);

      return JSON.stringify({
        ...((payload as Record<string, unknown>) ?? {}),
        tabId,
      });
    } catch (error) {
      return JSON.stringify({
        success: false,
        action: "form_input",
        tabId,
        ref,
        error: String(error),
      });
    }
  },
  {
    name: "form_input",
    description:
      "Set values in form elements using a read_page/find ref. Requires ref, value (string|boolean|number), and tabId from tabs_context.",
    schema: z.object({
      ref: z.string().min(1).describe("Element reference ID from read_page tool (e.g., 'ref_1')."),
      value: z
        .union([z.string(), z.boolean(), z.number()])
        .describe(
          "Value to set. For checkboxes/radios prefer boolean; for selects use option value or visible text; for other inputs use string/number."
        ),
      tabId: z.number().int().describe("Tab ID to set form value in. Must be in current tab group/context."),
    }),
  }
);

const computerTool = tool(
  async ({
    action,
    tabId,
    coordinate,
    duration,
    modifiers,
    ref,
    region,
    repeat,
    scroll_amount,
    scroll_direction,
    start_coordinate,
    text,
  }) => {
    const scope = await validateTabInCurrentScope(tabId);
    if (!scope.ok) {
      return JSON.stringify({
        success: false,
        action,
        tabId,
        error: scope.error,
      });
    }

    return withTabActionLock(tabId, async () => {
      const fail = (message: string, extras: Record<string, unknown> = {}) =>
        JSON.stringify({
          success: false,
          action,
          tabId,
          ...extras,
          error: message,
        });

      const resolveCoordinateFromInputs = async (options: {
        allowRef: boolean;
        refRequired?: boolean;
        coordinateValue?: [number, number];
        refValue?: string;
        scrollIntoView?: boolean;
      }) => {
        if (options.coordinateValue) {
          return {
            ok: true as const,
            coordinate: normalizePoint(options.coordinateValue),
            fromRef: false,
          };
        }

        if (options.allowRef && options.refValue) {
          const resolved = await resolveRefToElement(tabId, options.refValue, Boolean(options.scrollIntoView));
          if (!resolved.success) {
            return { ok: false as const, error: resolved.error };
          }
          return {
            ok: true as const,
            coordinate: resolved.coordinate,
            fromRef: true,
            element: resolved.element,
          };
        }

        if (options.refRequired) {
          return { ok: false as const, error: "Parameter 'ref' is required for this action." };
        }

        return {
          ok: false as const,
          error: "Provide either 'coordinate' or 'ref' for this action.",
        };
      };

      try {
        if (action === "screenshot") {
          const dataUrl = await captureTabScreenshotDataUrl(tabId);
          const dimensions = await getImageDimensions(dataUrl);
          const imageId = storeScreenshot(
            tabId,
            "screenshot",
            dataUrl,
            dimensions.width,
            dimensions.height
          );

          return JSON.stringify({
            success: true,
            action,
            tabId,
            imageId,
            mimeType: "image/png",
            width: dimensions.width,
            height: dimensions.height,
          });
        }

        if (action === "zoom") {
          if (!region) {
            return fail("Parameter 'region' is required for action 'zoom'.");
          }

          const normalized = normalizeRegion(region);
          if (normalized.width <= 0 || normalized.height <= 0) {
            return fail("Invalid 'region'. Ensure x0 != x1 and y0 != y1.", { region });
          }

          const sourceDataUrl = await captureTabScreenshotDataUrl(tabId);
          const sourceDimensions = await getImageDimensions(sourceDataUrl);
          const viewport = await getViewportMetrics(tabId);
          const viewportWidth = viewport.width > 0 ? viewport.width : sourceDimensions.width;
          const viewportHeight = viewport.height > 0 ? viewport.height : sourceDimensions.height;
          const scaleX = sourceDimensions.width / Math.max(1, viewportWidth);
          const scaleY = sourceDimensions.height / Math.max(1, viewportHeight);

          const cropX = Math.max(
            0,
            Math.min(sourceDimensions.width - 1, Math.round(normalized.left * scaleX))
          );
          const cropY = Math.max(
            0,
            Math.min(sourceDimensions.height - 1, Math.round(normalized.top * scaleY))
          );
          const cropWidth = Math.max(
            1,
            Math.min(sourceDimensions.width - cropX, Math.round(normalized.width * scaleX))
          );
          const cropHeight = Math.max(
            1,
            Math.min(sourceDimensions.height - cropY, Math.round(normalized.height * scaleY))
          );

          const zoomedDataUrl = await cropImageDataUrl(sourceDataUrl, {
            x: cropX,
            y: cropY,
            width: cropWidth,
            height: cropHeight,
          });

          const imageId = storeScreenshot(
            tabId,
            "zoom",
            zoomedDataUrl,
            cropWidth,
            cropHeight,
            [normalized.left, normalized.top, normalized.right, normalized.bottom]
          );

          return JSON.stringify({
            success: true,
            action,
            tabId,
            imageId,
            mimeType: "image/png",
            region: [normalized.left, normalized.top, normalized.right, normalized.bottom],
            zoomDimensions: {
              width: cropWidth,
              height: cropHeight,
            },
          });
        }

        if (action === "wait") {
          if (typeof duration !== "number") {
            return fail("Parameter 'duration' is required for action 'wait'.");
          }
          if (duration <= 0 || duration > 30) {
            return fail("Parameter 'duration' must be > 0 and <= 30 seconds.", { duration });
          }

          await sleep(Math.round(duration * 1000));
          return JSON.stringify({
            success: true,
            action,
            tabId,
            durationSeconds: duration,
            completed: true,
          });
        }

        if (action === "scroll_to") {
          const resolved = await resolveCoordinateFromInputs({
            allowRef: true,
            refRequired: true,
            refValue: ref,
            scrollIntoView: true,
          });
          if (!resolved.ok) {
            return fail(resolved.error, { ref });
          }

          return JSON.stringify({
            success: true,
            action,
            tabId,
            ref,
            elementScrolledIntoView: true,
            newPosition: resolved.coordinate,
          });
        }

        if (action === "type") {
          if (typeof text !== "string") {
            return fail("Parameter 'text' is required for action 'type'.");
          }

          await withDebuggerSession(tabId, async (debuggee) => {
            await chrome.debugger.sendCommand(debuggee, "Input.insertText", { text });
          });
          const activeField = await readActiveFieldValue(tabId);

          return JSON.stringify({
            success: true,
            action,
            tabId,
            textEntered: text,
            ...(activeField.hasActiveField ? { currentFieldValue: activeField.value ?? "" } : {}),
            ...(activeField.inputType === "email"
              ? { validEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(activeField.value ?? "") }
              : {}),
          });
        }

        if (action === "key") {
          if (typeof text !== "string" || !text.trim()) {
            return fail("Parameter 'text' is required for action 'key'.");
          }

          const repeatCount = repeat ?? 1;
          if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 100) {
            return fail("Parameter 'repeat' must be an integer between 1 and 100.", { repeat });
          }

          const parsedModifiers = parseModifierString(modifiers);
          if (!parsedModifiers.ok) {
            return fail(parsedModifiers.error);
          }

          const tokens = text.split(/\s+/).filter(Boolean);
          if (tokens.length === 0) {
            return fail("No keys provided. Use space-separated keys in 'text'.");
          }

          const executedTokens: string[] = [];
          await withDebuggerSession(tabId, async (debuggee) => {
            for (let pass = 0; pass < repeatCount; pass += 1) {
              for (const token of tokens) {
                const dispatched = await dispatchKeyToken(debuggee, token, parsedModifiers.bitmask);
                if (!dispatched.ok) {
                  throw new Error(dispatched.error);
                }
                executedTokens.push(token);
              }
            }
          });

          const activeField = await readActiveFieldValue(tabId);
          return JSON.stringify({
            success: true,
            action,
            tabId,
            keysPressed: tokens,
            repeatCount,
            ...(parsedModifiers.normalized ? { modifiers: parsedModifiers.normalized } : {}),
            ...(activeField.hasActiveField ? { currentFieldValue: activeField.value ?? "" } : {}),
          });
        }

        if (
          action === "left_click" ||
          action === "right_click" ||
          action === "double_click" ||
          action === "triple_click" ||
          action === "hover"
        ) {
          const parsedModifiers = parseModifierString(modifiers);
          if (!parsedModifiers.ok) {
            return fail(parsedModifiers.error);
          }

          const resolved = await resolveCoordinateFromInputs({
            allowRef: true,
            coordinateValue: coordinate,
            refValue: ref,
            scrollIntoView: action !== "hover",
          });
          if (!resolved.ok) {
            return fail(resolved.error, { ref });
          }

          if (action === "hover") {
            await withDebuggerSession(tabId, async (debuggee) => {
              await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: resolved.coordinate[0],
                y: resolved.coordinate[1],
                modifiers: parsedModifiers.bitmask,
              });
            });

            const hoverInfo = await describeElementAtCoordinate(tabId, resolved.coordinate);
            return JSON.stringify({
              success: true,
              action,
              tabId,
              ...(resolved.fromRef ? { ref } : { coordinate: resolved.coordinate }),
              ...(hoverInfo.element ? { hoverElement: hoverInfo.element } : {}),
              tooltipShown: hoverInfo.tooltipShown,
              ...(hoverInfo.tooltipText ? { tooltipText: hoverInfo.tooltipText } : {}),
            });
          }

          const clickCount = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
          const button = action === "right_click" ? "right" : "left";
          await withDebuggerSession(tabId, async (debuggee) => {
            await dispatchClick(debuggee, resolved.coordinate, button, clickCount, parsedModifiers.bitmask);
          });

          const clickInfo = await describeElementAtCoordinate(tabId, resolved.coordinate);
          return JSON.stringify({
            success: true,
            action,
            tabId,
            ...(resolved.fromRef ? { ref } : { coordinate: resolved.coordinate }),
            ...(parsedModifiers.normalized ? { modifiers: parsedModifiers.normalized } : {}),
            ...(clickInfo.element ? { clickedElement: clickInfo.element } : {}),
            ...(action === "right_click" ? { contextMenuOpened: true } : {}),
          });
        }

        if (action === "scroll") {
          if (!coordinate) {
            return fail("Parameter 'coordinate' is required for action 'scroll'.");
          }
          if (!scroll_direction) {
            return fail("Parameter 'scroll_direction' is required for action 'scroll'.");
          }
          const amount = scroll_amount ?? 3;
          if (amount <= 0) {
            return fail("Parameter 'scroll_amount' must be a positive number.", { scroll_amount });
          }

          const parsedModifiers = parseModifierString(modifiers);
          if (!parsedModifiers.ok) {
            return fail(parsedModifiers.error);
          }

          const point = normalizePoint(coordinate);
          await withDebuggerSession(tabId, async (debuggee) => {
            await dispatchScroll(debuggee, point, scroll_direction, amount, parsedModifiers.bitmask);
          });
          const metrics = await getScrollMetrics(tabId);

          return JSON.stringify({
            success: true,
            action,
            tabId,
            coordinate: point,
            direction: scroll_direction,
            scrollAmount: amount,
            ...(scroll_direction === "left" || scroll_direction === "right"
              ? { newHorizontalPosition: metrics.scrollX, pageWidth: metrics.pageWidth }
              : { newScrollPosition: metrics.scrollY, pageHeight: metrics.pageHeight }),
          });
        }

        if (action === "left_click_drag") {
          if (!start_coordinate || !coordinate) {
            return fail(
              "Parameters 'start_coordinate' and 'coordinate' are required for action 'left_click_drag'."
            );
          }

          const parsedModifiers = parseModifierString(modifiers);
          if (!parsedModifiers.ok) {
            return fail(parsedModifiers.error);
          }

          const start = normalizePoint(start_coordinate);
          const end = normalizePoint(coordinate);
          await withDebuggerSession(tabId, async (debuggee) => {
            await dispatchDrag(debuggee, start, end, parsedModifiers.bitmask);
          });

          return JSON.stringify({
            success: true,
            action,
            tabId,
            startCoordinate: start,
            endCoordinate: end,
            distanceMoved: Math.round(Math.hypot(end[0] - start[0], end[1] - start[1])),
            dropCompleted: true,
            ...(parsedModifiers.normalized ? { modifiers: parsedModifiers.normalized } : {}),
          });
        }

        return fail(`Unsupported action '${action}'.`);
      } catch (error) {
        return fail(String(error), {
          ...(ref ? { ref } : {}),
          ...(coordinate ? { coordinate: normalizePoint(coordinate) } : {}),
        });
      }
    });
  },
  {
    name: "computer",
    description:
      "Use mouse/keyboard actions and screenshots on a tab. Supports left/right/double/triple click, type, screenshot, wait, scroll, key, left_click_drag, zoom, scroll_to, and hover.",
    schema: z.object({
      action: z
        .enum(COMPUTER_ACTIONS)
        .describe(
          "Action to perform. Options: left_click, right_click, double_click, triple_click, type, screenshot, wait, scroll, key, left_click_drag, zoom, scroll_to, hover."
        ),
      tabId: z.number().int().describe("Tab ID to execute action on. Must be in current tab group/context."),
      coordinate: z
        .array(z.number())
        .length(2)
        .optional()
        .describe(
          "Viewport coordinates [x, y]. Required for click/right_click/double_click/triple_click/scroll. Used as end position for left_click_drag."
        ),
      duration: z.number().optional().describe("Wait duration in seconds for action='wait'. Maximum 30."),
      modifiers: z
        .string()
        .optional()
        .describe(
          "Modifier keys (ctrl, shift, alt, cmd/meta, win/windows). Combine with '+' (e.g., ctrl+shift)."
        ),
      ref: z
        .string()
        .optional()
        .describe(
          "Element ref from read_page/find. Required for scroll_to, and usable as alternative to coordinate for click/hover."
        ),
      region: z
        .array(z.number())
        .length(4)
        .optional()
        .describe("Zoom region [x0, y0, x1, y1], required for action='zoom'."),
      repeat: z
        .number()
        .int()
        .optional()
        .describe("Repeat count for action='key'. Integer between 1 and 100, default 1."),
      scroll_amount: z
        .number()
        .optional()
        .describe("Number of scroll ticks for action='scroll'. Defaults to 3."),
      scroll_direction: z
        .enum(["up", "down", "left", "right"])
        .optional()
        .describe("Scroll direction for action='scroll'."),
      start_coordinate: z
        .array(z.number())
        .length(2)
        .optional()
        .describe("Start coordinate [x, y] for action='left_click_drag'."),
      text: z
        .string()
        .optional()
        .describe(
          "Text for action='type', or key sequence for action='key'. Key sequences are space-separated (e.g., 'Backspace Backspace Delete' or 'ctrl+a')."
        ),
    }),
  }
);

const fileUploadTool = tool(
  async ({ paths, ref, tabId }) => {
    const scope = await validateTabInCurrentScope(tabId);
    if (!scope.ok) {
      return JSON.stringify({
        success: false,
        action: "file_upload",
        tabId,
        ref,
        error: scope.error,
      });
    }

    return withTabActionLock(tabId, async () => {
      const fail = (message: string, extras: Record<string, unknown> = {}) =>
        JSON.stringify({
          success: false,
          action: "file_upload",
          tabId,
          ref,
          ...extras,
          error: message,
        });

      if (!Array.isArray(paths) || paths.length === 0) {
        return fail("Parameter 'paths' must contain at least one absolute file path.");
      }

      const normalizedPaths = paths.map((p) => String(p).trim()).filter(Boolean);
      if (normalizedPaths.length === 0) {
        return fail("Parameter 'paths' must contain at least one non-empty path.");
      }

      for (const path of normalizedPaths) {
        if (!isAbsoluteLocalPath(path)) {
          return fail(`Path must be absolute: '${path}'`);
        }
      }

      const elementMeta = await getElementMetadataByRef(tabId, ref);
      if (!elementMeta.success) {
        return fail(elementMeta.error, elementMeta.tagName ? { tagName: elementMeta.tagName } : {});
      }

      if (!elementMeta.targetElement.multiple && normalizedPaths.length > 1) {
        return fail(
          "Target file input does not allow multiple files. Provide a single file path or choose an input with 'multiple'.",
          { providedFiles: normalizedPaths.length }
        );
      }

      try {
        const markerAttr = "data-claw-upload-target";
        const markerValue = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

        try {
          const markResult = await chrome.scripting.executeScript({
            target: { tabId },
            args: [ref, markerAttr, markerValue],
            func: (targetRef: string, attrName: string, attrValue: string) => {
              const refHash = (input: string) => {
                let hash = 0;
                for (let i = 0; i < input.length; i += 1) {
                  hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
                }
                return Math.abs(hash).toString(36);
              };

              const getRef = (path: string) => `ref_${refHash(path)}`;
              const root = document.documentElement || document.body;
              if (!root) {
                return { success: false, error: "No document root found." };
              }

              const findByRef = (el: Element, path: string): Element | null => {
                if (getRef(path) === targetRef) {
                  return el;
                }
                const children = Array.from(el.children);
                for (let i = 0; i < children.length; i += 1) {
                  const child = children[i];
                  const childPath = `${path}>${child.tagName.toLowerCase()}:${i}`;
                  const found = findByRef(child, childPath);
                  if (found) {
                    return found;
                  }
                }
                return null;
              };

              const target = findByRef(root, `${root.tagName.toLowerCase()}:0`);
              if (!(target instanceof HTMLInputElement) || target.type.toLowerCase() !== "file") {
                return { success: false, error: "Target element is not a file input." };
              }

              target.setAttribute(attrName, attrValue);
              return { success: true };
            },
          });

          const markPayload = markResult?.[0]?.result as
            | { success: true }
            | { success: false; error: string }
            | undefined;
          if (!markPayload?.success) {
            return fail(markPayload?.error ?? "Failed to mark target file input element.");
          }

          await withDebuggerSession(tabId, async (debuggee) => {
            await chrome.debugger.sendCommand(debuggee, "Runtime.enable");
            await chrome.debugger.sendCommand(debuggee, "DOM.enable");
            const doc = (await chrome.debugger.sendCommand(debuggee, "DOM.getDocument", {
              depth: 1,
              pierce: true,
            })) as { root?: { nodeId?: number } };
            const rootNodeId = doc.root?.nodeId;
            if (!rootNodeId) {
              throw new Error("Failed to resolve root document node.");
            }

            const selector = `[${markerAttr}="${markerValue}"]`;
            const query = (await chrome.debugger.sendCommand(debuggee, "DOM.querySelector", {
              nodeId: rootNodeId,
              selector,
            })) as { nodeId?: number };
            if (!query.nodeId) {
              throw new Error("Failed to resolve DOM node for target file input.");
            }

            await chrome.debugger.sendCommand(debuggee, "DOM.setFileInputFiles", {
              files: normalizedPaths,
              nodeId: query.nodeId,
            });
          });
        } finally {
          await chrome.scripting.executeScript({
            target: { tabId },
            args: [markerAttr, markerValue],
            func: (attrName: string, attrValue: string) => {
              const el = document.querySelector(`[${attrName}="${attrValue}"]`);
              if (el) {
                el.removeAttribute(attrName);
              }
            },
          });
        }
      } catch (error) {
        return fail(String(error));
      }

      const uploaded = await readUploadedFilesFromInput(tabId, ref);
      if (!uploaded.success) {
        return fail(uploaded.error);
      }

      const filesUploaded = uploaded.files.map((file, index) => ({
        path: normalizedPaths[index] ?? file.filename,
        filename: file.filename,
        size: file.size,
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        ...(file.dimensions ? { dimensions: file.dimensions } : {}),
      }));

      return JSON.stringify({
        success: true,
        action: "file_upload",
        tabId,
        filesUploaded,
        targetElement: elementMeta.targetElement,
        uploadCompleted: true,
        ...(filesUploaded.length > 1 ? { totalFilesUploaded: filesUploaded.length } : {}),
      });
    });
  },
  {
    name: "file_upload",
    description:
      "Upload one or multiple absolute local file paths to a file input element identified by ref. Requires paths, ref, and tabId.",
    schema: z.object({
      paths: z
        .array(z.string().min(1))
        .min(1)
        .describe("Absolute local file paths to upload. Can contain one or multiple files."),
      ref: z
        .string()
        .min(1)
        .describe("Element reference ID for the target file input from read_page/find (e.g., 'ref_8')."),
      tabId: z.number().int().describe("Tab ID where the target file input is located."),
    }),
  }
);

const uploadImageTool = tool(
  async ({ imageId, tabId, ref, coordinate, filename }) => {
    const scope = await validateTabInCurrentScope(tabId);
    if (!scope.ok) {
      return JSON.stringify({
        success: false,
        action: "upload_image",
        imageId,
        tabId,
        error: scope.error,
      });
    }

    return withTabActionLock(tabId, async () => {
      const fail = (message: string, extras: Record<string, unknown> = {}) =>
        JSON.stringify({
          success: false,
          action: "upload_image",
          imageId,
          tabId,
          ...extras,
          error: message,
        });

      const hasRef = typeof ref === "string" && ref.trim().length > 0;
      const hasCoordinate = Array.isArray(coordinate) && coordinate.length === 2;
      if (hasRef === hasCoordinate) {
        return fail("Provide exactly one of 'ref' or 'coordinate' (not both).");
      }

      const storedImage = screenshotStore.get(imageId);
      if (!storedImage) {
        return fail(
          `Image '${imageId}' not found. Provide an imageId from computer screenshot/zoom, or a supported uploaded image id.`
        );
      }

      const mimeType = getMimeTypeFromDataUrl(storedImage.dataUrl);
      if (!mimeType.startsWith("image/")) {
        return fail(`Image '${imageId}' is not an image MIME type: ${mimeType}`);
      }

      const uploadFilename = ensureImageFilename(filename, mimeType);
      let uploadedFileSize = 0;
      try {
        const blob = await dataUrlToBlob(storedImage.dataUrl);
        uploadedFileSize = blob.size;
      } catch {
        uploadedFileSize = 0;
      }

      if (hasRef) {
        const targetRef = ref!.trim();
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId },
          args: [targetRef, storedImage.dataUrl, uploadFilename, mimeType],
          func: async (targetRefArg: string, dataUrl: string, finalName: string, contentType: string) => {
            const refHash = (input: string) => {
              let hash = 0;
              for (let i = 0; i < input.length; i += 1) {
                hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
              }
              return Math.abs(hash).toString(36);
            };

            const getRef = (path: string) => `ref_${refHash(path)}`;
            const root = document.documentElement || document.body;
            if (!root) {
              return { success: false, error: "No document root found." };
            }

            const findByRef = (el: Element, path: string): Element | null => {
              if (getRef(path) === targetRefArg) {
                return el;
              }
              const children = Array.from(el.children);
              for (let i = 0; i < children.length; i += 1) {
                const child = children[i];
                const childPath = `${path}>${child.tagName.toLowerCase()}:${i}`;
                const found = findByRef(child, childPath);
                if (found) {
                  return found;
                }
              }
              return null;
            };

            const target = findByRef(root, `${root.tagName.toLowerCase()}:0`);
            if (!target) {
              return {
                success: false,
                error: "Element reference not found. Use read_page/find again to refresh refs.",
              };
            }

            const response = await fetch(dataUrl);
            const blob = await response.blob();
            const file = new File([blob], finalName, {
              type: contentType || blob.type || "application/octet-stream",
            });

            const targetSummaryBase = {
              ref: targetRefArg,
              type: target.tagName.toLowerCase(),
            };

            if (target instanceof HTMLInputElement && target.type.toLowerCase() === "file") {
              const transfer = new DataTransfer();
              transfer.items.add(file);
              target.files = transfer.files;
              target.dispatchEvent(new Event("input", { bubbles: true }));
              target.dispatchEvent(new Event("change", { bubbles: true }));
              return {
                success: true,
                method: "file_input",
                targetElement: {
                  ...targetSummaryBase,
                  type: "input",
                  inputType: "file",
                  ...(target.multiple ? { multiple: true } : {}),
                  ...(target.accept ? { accept: target.accept } : {}),
                },
                uploadedFile: {
                  name: file.name,
                  size: file.size,
                  mimeType: file.type,
                },
              };
            }

            const transfer = new DataTransfer();
            transfer.items.add(file);
            const dragEnter = new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer });
            const dragOver = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer });
            const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
            target.dispatchEvent(dragEnter);
            target.dispatchEvent(dragOver);
            target.dispatchEvent(drop);

            return {
              success: true,
              method: "drag_and_drop",
              targetElement: targetSummaryBase,
              uploadedFile: {
                name: file.name,
                size: file.size,
                mimeType: file.type,
              },
            };
          },
        });

        const result = (injection?.result as
          | {
              success: true;
              method: "file_input" | "drag_and_drop";
              targetElement: {
                ref: string;
                type: string;
                inputType?: string;
                multiple?: boolean;
                accept?: string;
              };
              uploadedFile: { name: string; size: number; mimeType: string };
            }
          | { success: false; error: string }
          | undefined) ?? { success: false as const, error: "Failed to upload image by ref." };

        if (!result.success) {
          return fail(result.error, { ref: targetRef });
        }

        return JSON.stringify({
          success: true,
          action: "upload_image",
          imageId,
          tabId,
          ...(result.method === "drag_and_drop" ? { method: "drag_and_drop" } : {}),
          targetElement: result.targetElement,
          uploadedFile: {
            name: result.uploadedFile.name,
            size: result.uploadedFile.size || uploadedFileSize,
            mimeType: result.uploadedFile.mimeType || mimeType,
          },
        });
      }

      const point = normalizePoint([coordinate![0], coordinate![1]]);
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        args: [point[0], point[1], storedImage.dataUrl, uploadFilename, mimeType],
        func: async (x: number, y: number, dataUrl: string, finalName: string, contentType: string) => {
          const target = document.elementFromPoint(x, y) || document.body;
          if (!target) {
            return { success: false, error: "No drop target found at coordinate." };
          }

          const response = await fetch(dataUrl);
          const blob = await response.blob();
          const file = new File([blob], finalName, {
            type: contentType || blob.type || "application/octet-stream",
          });

          const transfer = new DataTransfer();
          transfer.items.add(file);
          const dragEnter = new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer });
          const dragOver = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer });
          const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
          target.dispatchEvent(dragEnter);
          target.dispatchEvent(dragOver);
          target.dispatchEvent(drop);

          return {
            success: true,
            method: "drag_and_drop",
            dropTarget: {
              coordinate: [x, y],
              element: target === document.body ? "document area" : target.tagName.toLowerCase(),
            },
            uploadedFile: {
              name: file.name,
              size: file.size,
              mimeType: file.type,
            },
          };
        },
      });

      const result = (injection?.result as
        | {
            success: true;
            method: "drag_and_drop";
            dropTarget: { coordinate: [number, number]; element: string };
            uploadedFile: { name: string; size: number; mimeType: string };
          }
        | { success: false; error: string }
        | undefined) ?? { success: false as const, error: "Failed to upload image by coordinate." };

      if (!result.success) {
        return fail(result.error, { coordinate: point });
      }

      return JSON.stringify({
        success: true,
        action: "upload_image",
        method: "drag_and_drop",
        imageId,
        tabId,
        dropTarget: result.dropTarget,
        uploadedFile: {
          name: result.uploadedFile.name,
          size: result.uploadedFile.size || uploadedFileSize,
          mimeType: result.uploadedFile.mimeType || mimeType,
        },
      });
    });
  },
  {
    name: "upload_image",
    description:
      "Upload a stored image (from computer screenshot/zoom) to a target element via ref or coordinate drag-drop. Requires imageId and tabId, plus exactly one of ref or coordinate.",
    schema: z.object({
      imageId: z
        .string()
        .min(1)
        .describe("Image ID from computer screenshot/zoom or supported uploaded image IDs."),
      tabId: z.number().int().describe("Tab ID where the upload target is located."),
      ref: z
        .string()
        .optional()
        .describe(
          "Element reference ID from read_page/find. Use for file inputs or specific elements. Provide either ref or coordinate."
        ),
      coordinate: z
        .array(z.number())
        .length(2)
        .optional()
        .describe(
          "Viewport coordinate [x, y] for drag-and-drop targets. Provide either coordinate or ref."
        ),
      filename: z.string().optional().describe("Optional uploaded filename. Defaults to image.png."),
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
  findTool,
  formInputTool,
  computerTool,
  uploadImageTool,
  fileUploadTool,
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

  if (trimmed.startsWith("/find")) {
    const raw = trimmed.replace(/^\/find\s*/, "");
    const parts = raw.split(/\s+/).filter(Boolean);
    const parsedTabId = Number.parseInt(parts[0] ?? "", 10);
    const queryText = parts.slice(1).join(" ").trim();
    if (Number.isInteger(parsedTabId) && queryText) {
      return {
        name: findTool.name,
        args: {
          tabId: parsedTabId,
          query: queryText,
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

  if (trimmed.startsWith("/file_upload")) {
    const raw = trimmed.replace(/^\/file_upload\s*/, "");
    const parts = raw.split(/\s+/).filter(Boolean);
    const parsedTabId = Number.parseInt(parts[0] ?? "", 10);
    const parsedRef = parts[1];
    const paths = parts.slice(2);
    if (Number.isInteger(parsedTabId) && parsedRef && paths.length > 0) {
      return {
        name: fileUploadTool.name,
        args: {
          tabId: parsedTabId,
          ref: parsedRef,
          paths,
        },
      };
    }
  }

  if (trimmed.startsWith("/upload_image")) {
    const raw = trimmed.replace(/^\/upload_image\s*/, "");
    const parts = raw.split(/\s+/).filter(Boolean);
    const parsedTabId = Number.parseInt(parts[0] ?? "", 10);
    const imageId = parts[1];
    const modeArg = parts[2];
    if (Number.isInteger(parsedTabId) && imageId && modeArg) {
      if (modeArg.startsWith("ref:")) {
        const parsedRef = modeArg.slice(4).trim();
        if (parsedRef) {
          const parsedFilename = parts[3];
          return {
            name: uploadImageTool.name,
            args: {
              tabId: parsedTabId,
              imageId,
              ref: parsedRef,
              ...(parsedFilename ? { filename: parsedFilename } : {}),
            },
          };
        }
      }
      if (modeArg.startsWith("coord:")) {
        const tuple = modeArg.slice(6).split(",").map((x) => Number.parseFloat(x));
        if (tuple.length === 2 && Number.isFinite(tuple[0]) && Number.isFinite(tuple[1])) {
          const parsedFilename = parts[3];
          return {
            name: uploadImageTool.name,
            args: {
              tabId: parsedTabId,
              imageId,
              coordinate: [tuple[0], tuple[1]],
              ...(parsedFilename ? { filename: parsedFilename } : {}),
            },
          };
        }
      }
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
        "Call find with tabId and a natural language query to locate matching elements quickly. " +
        "Call form_input with tabId, ref, and value to set form fields (including inputs, selects, and textareas). " +
        "Call computer with action and tabId for mouse/keyboard interactions, scrolling, waiting, drag, hover, screenshots, and zoom. " +
        "Call upload_image with imageId and tabId plus exactly one of ref/coordinate to upload screenshots or images to file inputs or drag-drop targets. " +
        "Call file_upload with tabId, ref, and absolute local file paths to upload files directly to file input elements. " +
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
