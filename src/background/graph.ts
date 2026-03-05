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

export type LlmSettings =
  | { provider: "openai"; model: string; apiKey: string }
  | { provider: "ollama"; model: string; baseUrl: string };

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

async function waitForTabLoadComplete(tabId: number, timeoutMs = 15000): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error(`Timed out waiting for tab ${tabId} to finish loading.`));
    }, timeoutMs);

    const onUpdated = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab
    ) => {
      if (updatedTabId !== tabId) {
        return;
      }
      if (changeInfo.status !== "complete") {
        return;
      }
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(tab);
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    void chrome.tabs.get(tabId).then((tab) => {
      if (settled) {
        return;
      }
      if (tab.status === "complete") {
        settled = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(tab);
      }
    }).catch(() => {
      // Ignore transient get failures and rely on onUpdated or timeout.
    });
  });
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
const ENABLE_VISION_SCREENSHOT_CONTEXT = true; // Set false to disable sending screenshots to the model (costly).
const MAX_VISION_SCREENSHOT_DATA_URL_CHARS = 2_000_000;
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
    controlright: { key: "Control", code: "ControlRight", keyCode: 17 },
    ctrlright: { key: "Control", code: "ControlRight", keyCode: 17 },
    rightctrl: { key: "Control", code: "ControlRight", keyCode: 17 },
    rctrl: { key: "Control", code: "ControlRight", keyCode: 17 },
    shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
    shiftright: { key: "Shift", code: "ShiftRight", keyCode: 16 },
    rightshift: { key: "Shift", code: "ShiftRight", keyCode: 16 },
    rshift: { key: "Shift", code: "ShiftRight", keyCode: 16 },
    alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
    altleft: { key: "Alt", code: "AltLeft", keyCode: 18 },
    leftalt: { key: "Alt", code: "AltLeft", keyCode: 18 },
    lalt: { key: "Alt", code: "AltLeft", keyCode: 18 },
    altright: { key: "Alt", code: "AltRight", keyCode: 18 },
    rightalt: { key: "Alt", code: "AltRight", keyCode: 18 },
    ralt: { key: "Alt", code: "AltRight", keyCode: 18 },
    altgr: { key: "AltGraph", code: "AltRight", keyCode: 18 },
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

function charToKeyToken(char: string): string | null {
  if (!char) {
    return null;
  }

  if (/^[a-z]$/.test(char)) {
    return char;
  }
  if (/^[A-Z]$/.test(char)) {
    return `Shift+${char.toLowerCase()}`;
  }
  if (/^\d$/.test(char)) {
    return char;
  }

  const direct: Record<string, string> = {
    " ": "space",
    "\n": "enter",
    "\r": "enter",
    "\t": "tab",
    ".": ".",
    ",": ",",
    "/": "/",
    "\\": "\\",
    "-": "-",
    "=": "=",
    ";": ";",
    "'": "'",
    "[": "[",
    "]": "]",
    "`": "`",
  };
  if (direct[char]) {
    return direct[char];
  }

  const shifted: Record<string, string> = {
    "!": "Shift+1",
    "@": "Shift+2",
    "#": "Shift+3",
    "$": "Shift+4",
    "%": "Shift+5",
    "^": "Shift+6",
    "&": "Shift+7",
    "*": "Shift+8",
    "(": "Shift+9",
    ")": "Shift+0",
    "_": "Shift+-",
    "+": "Shift+=",
    "{": "Shift+[",
    "}": "Shift+]",
    "|": "Shift+\\",
    ":": "Shift+;",
    "\"": "Shift+'",
    "<": "Shift+,",
    ">": "Shift+.",
    "?": "Shift+/",
    "~": "Shift+`",
  };
  return shifted[char] ?? null;
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
  const loweredKey = parsed.key.trim().toLowerCase().replace(/\s+/g, "");
  if (!keyDef && (loweredKey === "bothalt" || loweredKey === "both_alt")) {
    const bothAltDefs: KeyDefinition[] = [
      { key: "Alt", code: "AltLeft", keyCode: 18 },
      { key: "Alt", code: "AltRight", keyCode: 18 },
    ];
    const modifiers = baseModifierBitmask | MODIFIER_BITS.alt;

    for (const altDef of bothAltDefs) {
      await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: altDef.key,
        code: altDef.code,
        windowsVirtualKeyCode: altDef.keyCode,
        nativeVirtualKeyCode: altDef.keyCode,
        modifiers,
      });
    }
    for (let i = bothAltDefs.length - 1; i >= 0; i -= 1) {
      const altDef = bothAltDefs[i];
      await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: altDef.key,
        code: altDef.code,
        windowsVirtualKeyCode: altDef.keyCode,
        nativeVirtualKeyCode: altDef.keyCode,
        modifiers,
      });
    }

    return { ok: true as const, key: "BothAlt" };
  }
  if (!keyDef) {
    return { ok: false as const, error: `Unsupported key '${parsed.key}'.` };
  }

  const modifierKeyDefs: Record<ModifierName, KeyDefinition> = {
    ctrl: { key: "Control", code: "ControlLeft", keyCode: 17 },
    shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
    alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
    meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
  };
  const tokenModifiers = parsed.modifiers.filter((name) => {
    if (name === "ctrl") return keyDef.code !== "ControlLeft";
    if (name === "shift") return keyDef.code !== "ShiftLeft";
    if (name === "alt") return keyDef.code !== "AltLeft";
    if (name === "meta") return keyDef.code !== "MetaLeft";
    return true;
  });

  const modifiers = baseModifierBitmask | tokenModifiers.reduce((bits, mod) => bits | MODIFIER_BITS[mod], 0);
  const hasNonShiftModifier = (modifiers & (MODIFIER_BITS.alt | MODIFIER_BITS.ctrl | MODIFIER_BITS.meta)) !== 0;
  const printableText = keyDef.text && !hasNonShiftModifier ? keyDef.text : undefined;

  for (const mod of tokenModifiers) {
    const modDef = modifierKeyDefs[mod];
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: modDef.key,
      code: modDef.code,
      windowsVirtualKeyCode: modDef.keyCode,
      nativeVirtualKeyCode: modDef.keyCode,
      modifiers,
    });
  }

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

  for (let i = tokenModifiers.length - 1; i >= 0; i -= 1) {
    const mod = tokenModifiers[i];
    const modDef = modifierKeyDefs[mod];
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: modDef.key,
      code: modDef.code,
      windowsVirtualKeyCode: modDef.keyCode,
      nativeVirtualKeyCode: modDef.keyCode,
      modifiers,
    });
  }

  return { ok: true as const, key: keyDef.key };
}

async function evaluateTabWithDebugger<T>(tabId: number, expression: string): Promise<T> {
  return withDebuggerSession(tabId, async (debuggee) => {
    await chrome.debugger.sendCommand(debuggee, "Runtime.enable");
    const evaluation = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression,
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
        "Unknown debugger evaluation error";
      throw new Error(message);
    }

    return evaluation.result?.value as T;
  });
}

async function resolveRefToElement(
  tabId: number,
  ref: string,
  scrollIntoView: boolean
): Promise<
  | { success: true; coordinate: [number, number]; element: ElementSummary }
  | { success: false; error: string }
> {
  try {
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
  } catch {
    try {
      const fallback = await evaluateTabWithDebugger<
        | { success: true; coordinate: [number, number]; element: ElementSummary }
        | { success: false; error: string }
      >(
        tabId,
        `(() => {
        const targetRef = ${JSON.stringify(ref)};
        const shouldScroll = ${JSON.stringify(scrollIntoView)};

        const refHash = (input) => {
          let hash = 0;
          for (let i = 0; i < input.length; i += 1) {
            hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
          }
          return Math.abs(hash).toString(36);
        };

        const getRef = (path) => "ref_" + refHash(path);
        const getType = (el) => {
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

        const getName = (el) => {
          const aria = (el.getAttribute("aria-label") || "").trim();
          if (aria) return aria;
          const title = (el.getAttribute("title") || "").trim();
          if (title) return title;
          if (el instanceof HTMLInputElement && el.labels && el.labels.length > 0) {
            const labelText = Array.from(el.labels).map((label) => (label.textContent || "").trim()).filter(Boolean).join(" ");
            if (labelText) return labelText;
          }
          const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
          return text.slice(0, 120);
        };

        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const root = document.documentElement || document.body;
        if (!root) return { success: false, error: "No document root found." };

        const findByRef = (el, path) => {
          if (!(el instanceof Element)) return null;
          if (getRef(path) === targetRef) return el;
          const children = Array.from(el.children);
          for (let i = 0; i < children.length; i += 1) {
            const child = children[i];
            const childPath = path + ">" + child.tagName.toLowerCase() + ":" + i;
            const found = findByRef(child, childPath);
            if (found) return found;
          }
          return null;
        };

        const target = findByRef(root, root.tagName.toLowerCase() + ":0");
        if (!target) {
          return {
            success: false,
            error: "Element reference not found. Use read_page/find again to refresh refs.",
          };
        }

        if (shouldScroll && target instanceof HTMLElement) {
          target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        }

        const rect = target.getBoundingClientRect();
        return {
          success: true,
          coordinate: [Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2)],
          element: {
            ref: targetRef,
            type: getType(target),
            name: getName(target) || undefined,
            visible: isVisible(target),
          },
        };
        })()`
      );
      return (
        fallback ?? {
          success: false,
          error: "Failed to resolve element reference.",
        }
      );
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }
}

async function describeElementAtCoordinate(tabId: number, coordinate: [number, number]) {
  try {
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
  } catch {
    try {
      const fallback = await evaluateTabWithDebugger<
        { element: ElementSummary | null; tooltipShown: boolean; tooltipText?: string }
      >(
        tabId,
        `(() => {
          const x = ${JSON.stringify(coordinate[0])};
          const y = ${JSON.stringify(coordinate[1])};
          const refHash = (input) => {
            let hash = 0;
            for (let i = 0; i < input.length; i += 1) {
              hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
            }
            return Math.abs(hash).toString(36);
          };
          const buildPath = (el) => {
            const segments = [];
            let current = el;
            while (current) {
              const parent = current.parentElement;
              const index = parent ? Array.from(parent.children).indexOf(current) : 0;
              segments.push(current.tagName.toLowerCase() + ":" + Math.max(index, 0));
              if (!parent) break;
              current = parent;
            }
            return segments.reverse().join(">");
          };
          const getType = (el) => {
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
          const getName = (el) => {
            const aria = (el.getAttribute("aria-label") || "").trim();
            if (aria) return aria;
            const title = (el.getAttribute("title") || "").trim();
            if (title) return title;
            if (el instanceof HTMLInputElement && el.labels && el.labels.length > 0) {
              const labelText = Array.from(el.labels).map((label) => (label.textContent || "").trim()).filter(Boolean).join(" ");
              if (labelText) return labelText;
            }
            const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
            return text.slice(0, 120);
          };
          const isVisible = (el) => {
            const style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
              return false;
            }
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          const element = document.elementFromPoint(x, y);
          if (!element) return { element: null, tooltipShown: false };
          const path = buildPath(element);
          const tooltip = (element.getAttribute("title") || "").trim();
          return {
            element: {
              ref: "ref_" + refHash(path),
              type: getType(element),
              name: getName(element) || undefined,
              visible: isVisible(element),
            },
            tooltipShown: Boolean(tooltip),
            tooltipText: tooltip || undefined,
          };
        })()`
      );
      return fallback ?? { element: null, tooltipShown: false };
    } catch {
      return { element: null, tooltipShown: false };
    }
  }
}

async function readActiveFieldValue(tabId: number) {
  try {
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
  } catch {
    try {
      const fallback = await evaluateTabWithDebugger<{ hasActiveField: boolean; value?: string; inputType?: string }>(
        tabId,
        `(() => {
          const active = document.activeElement;
          if (!active) return { hasActiveField: false };
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
        })()`
      );
      return fallback ?? { hasActiveField: false };
    } catch {
      return { hasActiveField: false };
    }
  }
}

async function getScrollMetrics(tabId: number) {
  try {
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
  } catch {
    try {
      const fallback = await evaluateTabWithDebugger<{
        scrollX: number;
        scrollY: number;
        pageWidth: number;
        pageHeight: number;
      }>(
        tabId,
        `(() => ({
          scrollX: Math.round(window.scrollX),
          scrollY: Math.round(window.scrollY),
          pageWidth: Math.round(Math.max(document.body?.scrollWidth ?? 0, document.documentElement?.scrollWidth ?? 0)),
          pageHeight: Math.round(Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0)),
        }))()`
      );
      return fallback ?? { scrollX: 0, scrollY: 0, pageWidth: 0, pageHeight: 0 };
    } catch {
      return { scrollX: 0, scrollY: 0, pageWidth: 0, pageHeight: 0 };
    }
  }
}

async function getViewportMetrics(tabId: number) {
  try {
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
  } catch {
    try {
      const fallback = await evaluateTabWithDebugger<{ width: number; height: number; devicePixelRatio: number }>(
        tabId,
        `(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
        }))()`
      );
      return fallback ?? { width: 0, height: 0, devicePixelRatio: 1 };
    } catch {
      return { width: 0, height: 0, devicePixelRatio: 1 };
    }
  }
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
  try {
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
  } catch {
    const fallback = await evaluateTabWithDebugger<
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
    >(
      tabId,
      `(() => {
        const targetRef = ${JSON.stringify(ref)};
        const refHash = (input) => {
          let hash = 0;
          for (let i = 0; i < input.length; i += 1) {
            hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
          }
          return Math.abs(hash).toString(36);
        };
        const getRef = (path) => "ref_" + refHash(path);
        const root = document.documentElement || document.body;
        if (!root) {
          return { success: false, error: "No document root found." };
        }
        const findByRef = (el, path) => {
          if (!(el instanceof Element)) return null;
          if (getRef(path) === targetRef) return el;
          const children = Array.from(el.children);
          for (let i = 0; i < children.length; i += 1) {
            const child = children[i];
            const childPath = path + ">" + child.tagName.toLowerCase() + ":" + i;
            const found = findByRef(child, childPath);
            if (found) return found;
          }
          return null;
        };
        const target = findByRef(root, root.tagName.toLowerCase() + ":0");
        if (!target) {
          return { success: false, error: "Element reference not found. Use read_page/find again to refresh refs." };
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
          return { success: false, error: "Referenced input is type='" + (inputType || "unknown") + "', expected type='file'." };
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
      })()`
    );
    return fallback ?? { success: false as const, error: "Failed to inspect target file input element." };
  }
}

type RefValueSnapshot =
  | {
      success: true;
      ref: string;
      elementType: "input";
      inputType: string;
      value: string | boolean;
    }
  | {
      success: true;
      ref: string;
      elementType: "textarea" | "select" | "contenteditable";
      value: string;
    }
  | { success: false; ref: string; error: string };

async function readFormValueByRef(tabId: number, ref: string): Promise<RefValueSnapshot> {
  try {
    const result = await evaluateTabWithDebugger<RefValueSnapshot>(
      tabId,
      `(() => {
        const targetRef = ${JSON.stringify(ref)};
        const refHash = (input) => {
          let hash = 0;
          for (let i = 0; i < input.length; i += 1) {
            hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
          }
          return Math.abs(hash).toString(36);
        };

        const getRef = (path) => "ref_" + refHash(path);
        const root = document.documentElement || document.body;
        if (!root) return { success: false, ref: targetRef, error: "No document root found." };

        const findByRef = (el, path) => {
          if (!(el instanceof Element)) return null;
          if (getRef(path) === targetRef) return el;
          const children = Array.from(el.children);
          for (let i = 0; i < children.length; i += 1) {
            const child = children[i];
            const childPath = path + ">" + child.tagName.toLowerCase() + ":" + i;
            const found = findByRef(child, childPath);
            if (found) return found;
          }
          return null;
        };

        const target = findByRef(root, root.tagName.toLowerCase() + ":0");
        if (!target) return { success: false, ref: targetRef, error: "Element reference not found." };

        if (target instanceof HTMLInputElement) {
          const inputType = (target.type || "text").toLowerCase();
          if (inputType === "checkbox" || inputType === "radio") {
            return { success: true, ref: targetRef, elementType: "input", inputType, value: target.checked };
          }
          return { success: true, ref: targetRef, elementType: "input", inputType, value: target.value ?? "" };
        }
        if (target instanceof HTMLTextAreaElement) {
          return { success: true, ref: targetRef, elementType: "textarea", value: target.value ?? "" };
        }
        if (target instanceof HTMLSelectElement) {
          return { success: true, ref: targetRef, elementType: "select", value: target.value ?? "" };
        }
        if (target instanceof HTMLElement && target.isContentEditable) {
          return { success: true, ref: targetRef, elementType: "contenteditable", value: target.textContent ?? "" };
        }
        return { success: false, ref: targetRef, error: "Unsupported element type: " + target.tagName.toLowerCase() };
      })()`
    );
    return (
      result ?? {
        success: false,
        ref,
        error: "Failed to verify element value by ref.",
      }
    );
  } catch (error) {
    return {
      success: false,
      ref,
      error: String(error),
    };
  }
}

async function verifyCoordinateMatchesRef(
  tabId: number,
  targetRef: string,
  coordinate: [number, number]
): Promise<{
  ok: boolean;
  relation?: "exact" | "descendant" | "ancestor" | "none";
  clickedRef?: string;
  error?: string;
}> {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [targetRef, coordinate[0], coordinate[1]],
      func: (requestedRef: string, x: number, y: number) => {
        const refHash = (input: string) => {
          let hash = 0;
          for (let i = 0; i < input.length; i += 1) {
            hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
          }
          return Math.abs(hash).toString(36);
        };

        const getRef = (path: string) => `ref_${refHash(path)}`;
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

        const root = document.documentElement || document.body;
        if (!root) {
          return { ok: false as const, relation: "none" as const, error: "No document root found." };
        }

        const findByRef = (el: Element, path: string): Element | null => {
          if (getRef(path) === requestedRef) return el;
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
        const clicked = document.elementFromPoint(x, y);
        if (!target || !clicked) {
          return {
            ok: false as const,
            relation: "none" as const,
            ...(clicked ? { clickedRef: getRef(buildPath(clicked)) } : {}),
          };
        }

        const clickedRef = getRef(buildPath(clicked));
        if (target === clicked) {
          return { ok: true as const, relation: "exact" as const, clickedRef };
        }
        if (target.contains(clicked)) {
          return { ok: true as const, relation: "descendant" as const, clickedRef };
        }
        if (clicked.contains(target)) {
          return { ok: true as const, relation: "ancestor" as const, clickedRef };
        }
        return { ok: false as const, relation: "none" as const, clickedRef };
      },
    });

    return (
      (injection?.result as
        | { ok: boolean; relation?: "exact" | "descendant" | "ancestor" | "none"; clickedRef?: string; error?: string }
        | undefined) ?? { ok: false, relation: "none", error: "No verification result." }
    );
  } catch (error) {
    return { ok: false, relation: "none", error: String(error) };
  }
}

async function inspectSubmitOutcome(tabId: number) {
  try {
    const result = await evaluateTabWithDebugger<{
      url: string;
      title: string;
      readyState: string;
      hasForm: boolean;
      matchedSuccessHints: string[];
    }>(
      tabId,
      `(() => {
        const text = (document.body?.innerText || "").replace(/\\s+/g, " ").trim().toLowerCase();
        const hasForm = Boolean(document.querySelector("form"));
        const successHints = ["application submitted", "submitted successfully", "thank you for applying", "success"];
        const matchedHints = successHints.filter((hint) => text.includes(hint));
        return {
          url: window.location.href,
          title: document.title || "",
          readyState: document.readyState,
          hasForm,
          matchedSuccessHints: matchedHints,
        };
      })()`
    );
    return (
      result ?? {
        url: "",
        title: "",
        readyState: "unknown",
        hasForm: false,
        matchedSuccessHints: [],
      }
    );
  } catch {
    return {
      url: "",
      title: "",
      readyState: "unknown",
      hasForm: false,
      matchedSuccessHints: [],
    };
  }
}

async function getPageLocation(tabId: number): Promise<{ url: string; title: string } | null> {
  try {
    const result = await evaluateTabWithDebugger<{ url: string; title: string }>(
      tabId,
      `(() => ({ url: window.location.href, title: document.title || "" }))()`
    );
    if (!result || typeof result.url !== "string") {
      return null;
    }
    return {
      url: result.url,
      title: typeof result.title === "string" ? result.title : "",
    };
  } catch {
    return null;
  }
}

type ConsoleCapturedMessage = {
  type: string;
  message: string;
  timestamp: string;
  source?: string;
  url?: string;
};

type NetworkCapturedRequest = {
  url: string;
  method: string;
  resourceType: string;
  statusCode?: number;
  responseTime?: number;
  size?: number;
  timestamp: string;
  requestBody?: string;
};

async function ensureConsoleMonitor(tabId: number) {
  const installScript = `(() => {
    const globalObj = window;
    if (globalObj.__clawConsoleStore?.installed) {
      return true;
    }

    const store = globalObj.__clawConsoleStore ?? {
      installed: false,
      entries: [],
      maxEntries: 2000,
    };
    globalObj.__clawConsoleStore = store;

    const pushEntry = (entry) => {
      store.entries.push({
        ...entry,
        timestamp: new Date().toISOString(),
      });
      if (store.entries.length > store.maxEntries) {
        store.entries.splice(0, store.entries.length - store.maxEntries);
      }
    };

    const safeArgToString = (value) => {
      if (typeof value === "string") {
        return value;
      }
      if (value instanceof Error) {
        return value.stack || value.message || String(value);
      }
      if (value === undefined) {
        return "undefined";
      }
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };

    const inferSourceFromStack = (stack) => {
      if (!stack) {
        return undefined;
      }
      const lines = stack.split("\\n").map((line) => line.trim()).filter(Boolean);
      const candidate = lines.find((line) => /:\\d+:\\d+/.test(line));
      if (!candidate) {
        return undefined;
      }
      return candidate.replace(/^at\\s+/, "");
    };

    const methods = ["log", "info", "warn", "error", "debug"];
    for (const method of methods) {
      const original = console[method].bind(console);
      console[method] = (...args) => {
        const errorStack = new Error().stack;
        const message = args.map((arg) => safeArgToString(arg)).join(" ");
        pushEntry({
          type: method === "warn" ? "warning" : method,
          message,
          source: inferSourceFromStack(errorStack),
          url: window.location.href,
        });
        original(...args);
      };
    }

    window.addEventListener("error", (event) => {
      const message = event.message || "Unhandled error";
      const source = event.filename
        ? event.filename + ":" + (event.lineno || 0) + (event.colno ? ":" + event.colno : "")
        : undefined;
      pushEntry({
        type: "error",
        message,
        source,
        url: window.location.href,
      });
    });

    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      const message =
        typeof reason === "string"
          ? reason
          : reason instanceof Error
          ? reason.stack || reason.message
          : safeArgToString(reason);
      pushEntry({
        type: "exception",
        message,
        source: inferSourceFromStack(reason instanceof Error ? reason.stack : undefined),
        url: window.location.href,
      });
    });

    store.installed = true;
    return true;
  })()`;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        type ClawConsoleStore = {
          installed: boolean;
          entries: Array<{
            type: string;
            message: string;
            timestamp: string;
            source?: string;
            url?: string;
          }>;
          maxEntries: number;
        };

        const globalObj = window as unknown as {
          __clawConsoleStore?: ClawConsoleStore;
        };
        if (globalObj.__clawConsoleStore?.installed) {
          return;
        }

        const store: ClawConsoleStore = globalObj.__clawConsoleStore ?? {
          installed: false,
          entries: [],
          maxEntries: 2000,
        };
        globalObj.__clawConsoleStore = store;

        const pushEntry = (entry: { type: string; message: string; source?: string; url?: string }) => {
          store.entries.push({
            ...entry,
            timestamp: new Date().toISOString(),
          });
          if (store.entries.length > store.maxEntries) {
            store.entries.splice(0, store.entries.length - store.maxEntries);
          }
        };

        const safeArgToString = (value: unknown): string => {
          if (typeof value === "string") {
            return value;
          }
          if (value instanceof Error) {
            return value.stack || value.message || String(value);
          }
          if (value === undefined) {
            return "undefined";
          }
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        };

        const inferSourceFromStack = (stack?: string) => {
          if (!stack) {
            return undefined;
          }
          const lines = stack.split("\n").map((line) => line.trim()).filter(Boolean);
          const candidate = lines.find((line) => /:\d+:\d+/.test(line));
          if (!candidate) {
            return undefined;
          }
          return candidate.replace(/^at\s+/, "");
        };

        const methods: Array<"log" | "info" | "warn" | "error" | "debug"> = [
          "log",
          "info",
          "warn",
          "error",
          "debug",
        ];
        for (const method of methods) {
          const original = console[method].bind(console);
          console[method] = (...args: unknown[]) => {
            const errorStack = new Error().stack;
            const message = args.map((arg) => safeArgToString(arg)).join(" ");
            pushEntry({
              type: method === "warn" ? "warning" : method,
              message,
              source: inferSourceFromStack(errorStack),
              url: window.location.href,
            });
            original(...args);
          };
        }

        window.addEventListener("error", (event) => {
          const message = event.message || "Unhandled error";
          const source = event.filename
            ? `${event.filename}:${event.lineno || 0}${event.colno ? `:${event.colno}` : ""}`
            : undefined;
          pushEntry({
            type: "error",
            message,
            source,
            url: window.location.href,
          });
        });

        window.addEventListener("unhandledrejection", (event) => {
          const reason = event.reason;
          const message =
            typeof reason === "string"
              ? reason
              : reason instanceof Error
              ? reason.stack || reason.message
              : safeArgToString(reason);
          pushEntry({
            type: "exception",
            message,
            source: inferSourceFromStack(reason instanceof Error ? reason.stack : undefined),
            url: window.location.href,
          });
        });

        store.installed = true;
      },
    });
  } catch {
    await evaluateTabWithDebugger<boolean>(tabId, installScript);
  }
}

async function readConsoleBuffer(tabId: number, clear: boolean) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [clear],
      func: (clearEntries: boolean) => {
        const globalObj = window as unknown as {
          __clawConsoleStore?: {
            entries: Array<{
              type: string;
              message: string;
              timestamp: string;
              source?: string;
              url?: string;
            }>;
          };
        };
        const entries = Array.isArray(globalObj.__clawConsoleStore?.entries)
          ? [...globalObj.__clawConsoleStore!.entries]
          : [];
        if (clearEntries && globalObj.__clawConsoleStore) {
          globalObj.__clawConsoleStore.entries = [];
        }
        return entries;
      },
    });

    return (injection?.result as ConsoleCapturedMessage[] | undefined) ?? [];
  } catch {
    const fallback = await evaluateTabWithDebugger<ConsoleCapturedMessage[]>(
      tabId,
      `(() => {
        const clearEntries = ${JSON.stringify(clear)};
        const globalObj = window;
        const entries = Array.isArray(globalObj.__clawConsoleStore?.entries)
          ? [...globalObj.__clawConsoleStore.entries]
          : [];
        if (clearEntries && globalObj.__clawConsoleStore) {
          globalObj.__clawConsoleStore.entries = [];
        }
        return entries;
      })()`
    );
    return Array.isArray(fallback) ? fallback : [];
  }
}

async function ensureNetworkMonitor(tabId: number) {
  const installScript = `(() => {
      const globalObj = window;
      const createStore = () => ({
        installed: false,
        currentOrigin: window.location.origin,
        entries: [],
        maxEntries: 3000,
        seenPerfKeys: {},
      });

      const store = globalObj.__clawNetworkStore ?? createStore();
      globalObj.__clawNetworkStore = store;

      if (store.currentOrigin !== window.location.origin) {
        store.currentOrigin = window.location.origin;
        store.entries = [];
        store.seenPerfKeys = {};
      }

      const pushEntry = (entry) => {
        store.entries.push({
          ...entry,
          timestamp: new Date().toISOString(),
        });
        if (store.entries.length > store.maxEntries) {
          store.entries.splice(0, store.entries.length - store.maxEntries);
        }
      };

      const normalizeUrl = (raw) => {
        try {
          return new URL(raw, window.location.href).href;
        } catch {
          return raw;
        }
      };

      const capturePerformanceEntries = () => {
        const nav = performance.getEntriesByType("navigation")[0];
        if (nav) {
          const key = "nav:" + Math.round(nav.startTime) + ":" + Math.round(nav.responseEnd) + ":" + window.location.href;
          if (!store.seenPerfKeys[key]) {
            store.seenPerfKeys[key] = true;
            pushEntry({
              url: window.location.href,
              method: "GET",
              resourceType: "document",
              statusCode: undefined,
              responseTime: Math.round(nav.duration || 0),
              size: nav.transferSize > 0 ? nav.transferSize : undefined,
            });
          }
        }

        const resources = performance.getEntriesByType("resource");
        for (const resource of resources) {
          const key = "res:" + resource.name + ":" + Math.round(resource.startTime) + ":" + Math.round(resource.responseEnd);
          if (store.seenPerfKeys[key]) {
            continue;
          }
          store.seenPerfKeys[key] = true;
          pushEntry({
            url: normalizeUrl(resource.name),
            method: "GET",
            resourceType: resource.initiatorType || "resource",
            statusCode: undefined,
            responseTime: Math.round(resource.duration || 0),
            size: resource.transferSize > 0 ? resource.transferSize : undefined,
          });
        }
      };

      capturePerformanceEntries();
      if (store.installed) {
        return true;
      }

      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const start = performance.now();
        const requestInfo = args[0];
        const requestInit = args[1];

        let method = "GET";
        let url = "";
        if (requestInfo instanceof Request) {
          method = requestInfo.method || method;
          url = requestInfo.url;
        } else {
          url = String(requestInfo);
        }
        if (requestInit && requestInit.method) {
          method = requestInit.method;
        }

        const requestBody = requestInit && typeof requestInit.body === "string" ? requestInit.body : undefined;

        try {
          const response = await originalFetch(...args);
          const elapsed = Math.round(performance.now() - start);
          const contentLength = response.headers.get("content-length");
          const parsedSize = contentLength ? Number.parseInt(contentLength, 10) : NaN;
          pushEntry({
            url: normalizeUrl(response.url || url),
            method: String(method).toUpperCase(),
            resourceType: "fetch",
            statusCode: response.status,
            responseTime: elapsed,
            size: Number.isFinite(parsedSize) ? parsedSize : undefined,
            ...(requestBody ? { requestBody } : {}),
          });
          return response;
        } catch (error) {
          const elapsed = Math.round(performance.now() - start);
          pushEntry({
            url: normalizeUrl(url),
            method: String(method).toUpperCase(),
            resourceType: "fetch",
            statusCode: 0,
            responseTime: elapsed,
            ...(requestBody ? { requestBody } : {}),
          });
          throw error;
        }
      };

      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url, async, username, password) {
        this.__clawMeta = {
          method: (method || "GET").toUpperCase(),
          url: typeof url === "string" ? url : String(url),
          start: 0,
          body: undefined,
        };
        return originalOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
      };

      XMLHttpRequest.prototype.send = function (body) {
        const xhr = this;
        if (xhr.__clawMeta) {
          xhr.__clawMeta.start = performance.now();
          if (typeof body === "string") {
            xhr.__clawMeta.body = body;
          }
        }

        const onLoadEnd = () => {
          const meta = xhr.__clawMeta || {};
          const startedAt = typeof meta.start === "number" ? meta.start : performance.now();
          const elapsed = Math.round(performance.now() - startedAt);
          let size;
          try {
            const response = xhr.response;
            if (response instanceof ArrayBuffer) {
              size = response.byteLength;
            } else if (typeof response === "string") {
              size = response.length;
            } else if (response && typeof response.size === "number") {
              size = response.size;
            }
          } catch {
            size = undefined;
          }

          pushEntry({
            url: normalizeUrl(String(xhr.responseURL || meta.url || "")),
            method: String(meta.method || "GET").toUpperCase(),
            resourceType: "xhr",
            statusCode: Number.isFinite(xhr.status) ? xhr.status : undefined,
            responseTime: elapsed,
            ...(typeof size === "number" && size >= 0 ? { size } : {}),
            ...(typeof meta.body === "string" ? { requestBody: meta.body } : {}),
          });
          xhr.removeEventListener("loadend", onLoadEnd);
        };

        xhr.addEventListener("loadend", onLoadEnd);
        return originalSend.call(this, body ?? null);
      };

      store.installed = true;
      return true;
    })()`;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
      type ClawNetworkStore = {
        installed: boolean;
        currentOrigin: string;
        entries: NetworkCapturedRequest[];
        maxEntries: number;
        seenPerfKeys: Record<string, true>;
      };

      const globalObj = window as unknown as {
        __clawNetworkStore?: ClawNetworkStore;
      };

      const createStore = (): ClawNetworkStore => ({
        installed: false,
        currentOrigin: window.location.origin,
        entries: [],
        maxEntries: 3000,
        seenPerfKeys: {},
      });

      const store = globalObj.__clawNetworkStore ?? createStore();
      globalObj.__clawNetworkStore = store;

      if (store.currentOrigin !== window.location.origin) {
        store.currentOrigin = window.location.origin;
        store.entries = [];
        store.seenPerfKeys = {};
      }

      const pushEntry = (entry: Omit<NetworkCapturedRequest, "timestamp">) => {
        store.entries.push({
          ...entry,
          timestamp: new Date().toISOString(),
        });
        if (store.entries.length > store.maxEntries) {
          store.entries.splice(0, store.entries.length - store.maxEntries);
        }
      };

      const normalizeUrl = (raw: string) => {
        try {
          return new URL(raw, window.location.href).href;
        } catch {
          return raw;
        }
      };

      const capturePerformanceEntries = () => {
        const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
        if (nav) {
          const key = `nav:${Math.round(nav.startTime)}:${Math.round(nav.responseEnd)}:${window.location.href}`;
          if (!store.seenPerfKeys[key]) {
            store.seenPerfKeys[key] = true;
            pushEntry({
              url: window.location.href,
              method: "GET",
              resourceType: "document",
              statusCode: undefined,
              responseTime: Math.round(nav.duration || 0),
              size: nav.transferSize > 0 ? nav.transferSize : undefined,
            });
          }
        }

        const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
        for (const resource of resources) {
          const key = `res:${resource.name}:${Math.round(resource.startTime)}:${Math.round(resource.responseEnd)}`;
          if (store.seenPerfKeys[key]) {
            continue;
          }
          store.seenPerfKeys[key] = true;

          pushEntry({
            url: normalizeUrl(resource.name),
            method: "GET",
            resourceType: resource.initiatorType || "resource",
            statusCode: undefined,
            responseTime: Math.round(resource.duration || 0),
            size: resource.transferSize > 0 ? resource.transferSize : undefined,
          });
        }
      };

      capturePerformanceEntries();

      if (store.installed) {
        return;
      }

      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args: Parameters<typeof fetch>) => {
        const start = performance.now();
        const requestInfo = args[0];
        const requestInit = args[1];

        let method = "GET";
        let url = "";
        if (requestInfo instanceof Request) {
          method = requestInfo.method || method;
          url = requestInfo.url;
        } else {
          url = String(requestInfo);
        }
        if (requestInit?.method) {
          method = requestInit.method;
        }

        const requestBody = typeof requestInit?.body === "string" ? requestInit.body : undefined;

        try {
          const response = await originalFetch(...args);
          const elapsed = Math.round(performance.now() - start);
          const contentLength = response.headers.get("content-length");
          const parsedSize = contentLength ? Number.parseInt(contentLength, 10) : NaN;

          pushEntry({
            url: normalizeUrl(response.url || url),
            method: method.toUpperCase(),
            resourceType: "fetch",
            statusCode: response.status,
            responseTime: elapsed,
            size: Number.isFinite(parsedSize) ? parsedSize : undefined,
            ...(requestBody ? { requestBody } : {}),
          });
          return response;
        } catch (error) {
          const elapsed = Math.round(performance.now() - start);
          pushEntry({
            url: normalizeUrl(url),
            method: method.toUpperCase(),
            resourceType: "fetch",
            statusCode: 0,
            responseTime: elapsed,
            ...(requestBody ? { requestBody } : {}),
          });
          throw error;
        }
      };

      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (
        method: string,
        url: string | URL,
        async?: boolean,
        username?: string | null,
        password?: string | null
      ) {
        (this as XMLHttpRequest & { __clawMeta?: Record<string, unknown> }).__clawMeta = {
          method: (method || "GET").toUpperCase(),
          url: typeof url === "string" ? url : url.toString(),
          start: 0,
          body: undefined,
        };
        return originalOpen.call(this, method, url as string, async ?? true, username ?? null, password ?? null);
      };

      XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
        const xhr = this as XMLHttpRequest & { __clawMeta?: Record<string, unknown> };
        if (xhr.__clawMeta) {
          xhr.__clawMeta.start = performance.now();
          if (typeof body === "string") {
            xhr.__clawMeta.body = body;
          }
        }

        const onLoadEnd = () => {
          const meta = xhr.__clawMeta ?? {};
          const startedAt = typeof meta.start === "number" ? meta.start : performance.now();
          const elapsed = Math.round(performance.now() - startedAt);
          let size: number | undefined;
          try {
            const response = xhr.response;
            if (response instanceof ArrayBuffer) {
              size = response.byteLength;
            } else if (typeof response === "string") {
              size = response.length;
            } else if (response && typeof (response as Blob).size === "number") {
              size = (response as Blob).size;
            }
          } catch {
            size = undefined;
          }

          pushEntry({
            url: normalizeUrl(String(xhr.responseURL || meta.url || "")),
            method: String(meta.method || "GET").toUpperCase(),
            resourceType: "xhr",
            statusCode: Number.isFinite(xhr.status) ? xhr.status : undefined,
            responseTime: elapsed,
            ...(typeof size === "number" && size >= 0 ? { size } : {}),
            ...(typeof meta.body === "string" ? { requestBody: meta.body } : {}),
          });
          xhr.removeEventListener("loadend", onLoadEnd);
        };

        xhr.addEventListener("loadend", onLoadEnd);
        return originalSend.call(this, body ?? null);
      };

      store.installed = true;
      },
    });
  } catch {
    await evaluateTabWithDebugger<boolean>(tabId, installScript);
  }
}

async function readNetworkBuffer(tabId: number, clear: boolean) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [clear],
      func: (clearEntries: boolean) => {
        const globalObj = window as unknown as {
          __clawNetworkStore?: {
            currentOrigin: string;
            entries: NetworkCapturedRequest[];
            seenPerfKeys: Record<string, true>;
          };
        };

        const store = globalObj.__clawNetworkStore;
        if (!store) {
          return [] as NetworkCapturedRequest[];
        }

        if (store.currentOrigin !== window.location.origin) {
          store.currentOrigin = window.location.origin;
          store.entries = [];
          store.seenPerfKeys = {};
        }

        const entries = Array.isArray(store.entries) ? [...store.entries] : [];
        if (clearEntries) {
          store.entries = [];
        }
        return entries;
      },
    });

    return (injection?.result as NetworkCapturedRequest[] | undefined) ?? [];
  } catch {
    const fallback = await evaluateTabWithDebugger<NetworkCapturedRequest[]>(
      tabId,
      `(() => {
        const clearEntries = ${JSON.stringify(clear)};
        const globalObj = window;
        const store = globalObj.__clawNetworkStore;
        if (!store) {
          return [];
        }
        if (store.currentOrigin !== window.location.origin) {
          store.currentOrigin = window.location.origin;
          store.entries = [];
          store.seenPerfKeys = {};
        }
        const entries = Array.isArray(store.entries) ? [...store.entries] : [];
        if (clearEntries) {
          store.entries = [];
        }
        return entries;
      })()`
    );
    return Array.isArray(fallback) ? fallback : [];
  }
}

async function readUploadedFilesFromInput(tabId: number, ref: string) {
  try {
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
  } catch {
    const fallback = await evaluateTabWithDebugger<
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
    >(
      tabId,
      `(() => {
        const targetRef = ${JSON.stringify(ref)};
        const refHash = (input) => {
          let hash = 0;
          for (let i = 0; i < input.length; i += 1) {
            hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
          }
          return Math.abs(hash).toString(36);
        };
        const getRef = (path) => "ref_" + refHash(path);
        const root = document.documentElement || document.body;
        if (!root) {
          return { success: false, error: "No document root found.", files: [] };
        }
        const findByRef = (el, path) => {
          if (!(el instanceof Element)) return null;
          if (getRef(path) === targetRef) return el;
          const children = Array.from(el.children);
          for (let i = 0; i < children.length; i += 1) {
            const child = children[i];
            const childPath = path + ">" + child.tagName.toLowerCase() + ":" + i;
            const found = findByRef(child, childPath);
            if (found) return found;
          }
          return null;
        };
        const target = findByRef(root, root.tagName.toLowerCase() + ":0");
        if (!(target instanceof HTMLInputElement) || target.type.toLowerCase() !== "file") {
          return { success: false, error: "Target element is not a file input.", files: [] };
        }
        const files = Array.from(target.files || []);
        const filesUploaded = [];
        for (const file of files) {
          const fileData = { filename: file.name, size: file.size };
          if (file.type) {
            fileData.mimeType = file.type;
          }
          filesUploaded.push(fileData);
        }
        return { success: true, files: filesUploaded };
      })()`
    );
    return fallback ?? { success: false as const, error: "Failed to read uploaded file details from input.", files: [] };
  }
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

    try {
      await ensureConsoleMonitor(initialTab.id);
    } catch {
      // Best effort only.
    }
    try {
      await ensureNetworkMonitor(initialTab.id);
    } catch {
      // Best effort only.
    }

    return JSON.stringify(response);
  },
  {
    name: "tabs_context",
    description:
      "**Description:** Retrieve the current browser tab state, including all open tabs in the tab group with their tab IDs, titles, URLs, and which tab is currently active. Takes no input parameters. Call this before any tab-related action to avoid duplicating tabs or acting on stale state. Use whenever the user refers to \"this page\", \"current tab\", \"my tabs\", or any request that depends on knowing what is currently open in the browser.",
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
      "**Description:** Open a new browser tab with the specified URL. Requires a single parameter: the full URL to navigate to (e.g., \"https://google.com\"). For web searches, construct the URL as \"https://www.google.com/search?q=<encoded_query>\". Before calling this tool, always call tabs_context first to check if a tab with the target URL is already open — if it is, switch to the existing tab instead of creating a duplicate. Returns the new tab's ID, URL, and title once loaded.",
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

      await chrome.tabs.update(tabId, { url: normalized.url });
      let finalTab: chrome.tabs.Tab | null = null;
      try {
        finalTab = await waitForTabLoadComplete(tabId);
      } catch {
        // Best effort: still inspect current tab URL to report accurate state.
        try {
          finalTab = await chrome.tabs.get(tabId);
        } catch {
          finalTab = null;
        }
      }

      const finalUrl = finalTab?.url ?? "";
      const isRestricted = finalUrl.startsWith("chrome://") || finalUrl.startsWith("edge://");
      if (isRestricted) {
        return JSON.stringify({
          success: false,
          action: "navigate",
          tabId,
          requestedUrl: url,
          finalUrl,
          error:
            "Navigation did not leave a restricted browser page. Open a normal web page first, then retry.",
        });
      }

      return JSON.stringify({
        success: true,
        action: "navigate",
        tabId,
        requestedUrl: url,
        finalUrl,
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

        const buildPath = (el) => {
          const segments = [];
          let current = el;
          while (current) {
            const parent = current.parentElement;
            const index = parent ? Array.from(parent.children).indexOf(current) : 0;
            segments.push(current.tagName.toLowerCase() + ":" + Math.max(index, 0));
            if (!parent) break;
            current = parent;
          }
          return segments.reverse().join(">");
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

        const getVisibilityInfo = (el) => {
          if (!(el instanceof Element)) {
            return { visible: false, reason: "not_element" };
          }

          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const reasons = [];

          if (el.hasAttribute("hidden")) reasons.push("hidden_attr");
          if ((el.getAttribute("aria-hidden") || "").toLowerCase() === "true") reasons.push("aria_hidden");
          if (el instanceof HTMLInputElement && (el.type || "").toLowerCase() === "hidden") reasons.push("input_hidden_type");
          if (style.display === "none") reasons.push("display_none");
          if (style.visibility === "hidden" || style.visibility === "collapse") reasons.push("visibility_hidden");
          if (Number(style.opacity) === 0) reasons.push("opacity_0");
          if (rect.width <= 0 || rect.height <= 0) reasons.push("zero_size");

          const viewportWidth = Math.max(document.documentElement?.clientWidth || 0, window.innerWidth || 0);
          const viewportHeight = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
          if (rect.bottom < 0 || rect.right < 0 || rect.top > viewportHeight || rect.left > viewportWidth) {
            reasons.push("offscreen");
          }

          const visible = reasons.length === 0;
          return {
            visible,
            reason: visible ? "visible" : reasons.join("|"),
          };
        };

        const toCompactNode = (el) => {
          if (!(el instanceof Element)) return null;
          const path = buildPath(el);
          if (!path) return null;
          const visibility = getVisibilityInfo(el);
          const node = {
            ref: "ref_" + refHash(path),
            type: getType(el),
            visible: visibility.visible,
          };
          if (!visibility.visible) node.visibilityReason = visibility.reason;
          const name = getNodeName(el);
          if (name) node.name = name;
          if (el instanceof HTMLInputElement) {
            if (el.type) node.inputType = el.type;
            if (el.placeholder) node.placeholder = el.placeholder;
            node.value = el.value ?? "";
          }
          if (el instanceof HTMLTextAreaElement) {
            if (el.placeholder) node.placeholder = el.placeholder;
            node.value = el.value ?? "";
          }
          if (el instanceof HTMLSelectElement) {
            node.value = el.value;
            node.options = Array.from(el.options).map((o) => o.text);
          }
          if ("disabled" in el) node.disabled = !!el.disabled;
          return node;
        };

        const collectBasicInteractive = () => {
          const selectors = [
            "input",
            "textarea",
            "select",
            "button",
            "a[href]",
            "[role='button']",
            "[role='link']",
            "[contenteditable='true']",
          ];
          const seen = new Set();
          const nodes = [];
          const elements = Array.from(document.querySelectorAll(selectors.join(",")));
          for (const el of elements) {
            if (!(el instanceof Element)) continue;
            const path = buildPath(el);
            if (!path || seen.has(path)) continue;
            seen.add(path);
            const node = toCompactNode(el);
            if (node) nodes.push(node);
            if (nodes.length >= 200) break;
          }
          return nodes;
        };

        const buildNode = (el, currentDepth, path) => {
          if (!(el instanceof Element)) return null;
          const ref = "ref_" + refHash(path);
          const visibility = getVisibilityInfo(el);
          const node = {
            ref,
            type: getType(el),
            visible: visibility.visible,
          };
          if (!visibility.visible) node.visibilityReason = visibility.reason;

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
        if (!rootEl) {
          return {
            tree: collectBasicInteractive(),
            meta: {
              fallback: true,
              reason: "no_document_root",
              url: window.location.href,
              title: document.title || "",
              readyState: document.readyState,
            },
          };
        }

        const rootPath = rootEl.tagName.toLowerCase() + ":0";
        const fullTree = buildNode(rootEl, 0, rootPath);
        if (!fullTree) {
          return {
            tree: collectBasicInteractive(),
            meta: {
              fallback: true,
              reason: "failed_build_tree",
              url: window.location.href,
              title: document.title || "",
              readyState: document.readyState,
            },
          };
        }

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
          if (interactiveCandidates.length === 0) {
            return {
              tree: collectBasicInteractive(),
              meta: {
                fallback: true,
                reason: "no_interactive_candidates",
                url: window.location.href,
                title: document.title || "",
                readyState: document.readyState,
              },
            };
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

      let payload = evaluation.result?.value ?? { tree: [] };
      const currentTree = (payload as { tree?: unknown })?.tree;
      if (!ref_id && Array.isArray(currentTree) && currentTree.length === 0) {
        const fallbackExtraction = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
          expression: `(() => {
            const refHash = (input) => {
              let hash = 0;
              for (let i = 0; i < input.length; i += 1) {
                hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
              }
              return Math.abs(hash).toString(36);
            };
            const buildPath = (el) => {
              const segments = [];
              let current = el;
              while (current) {
                const parent = current.parentElement;
                const index = parent ? Array.from(parent.children).indexOf(current) : 0;
                segments.push(current.tagName.toLowerCase() + ":" + Math.max(index, 0));
                if (!parent) break;
                current = parent;
              }
              return segments.reverse().join(">");
            };
            const getName = (el) => {
              const aria = (el.getAttribute("aria-label") || "").trim();
              if (aria) return aria;
              const title = (el.getAttribute("title") || "").trim();
              if (title) return title;
              if (el instanceof HTMLInputElement && el.labels && el.labels.length > 0) {
                const labelText = Array.from(el.labels).map((label) => (label.textContent || "").trim()).filter(Boolean).join(" ");
                if (labelText) return labelText;
              }
              const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
              return text.slice(0, 120);
            };
            const getType = (el) => {
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
            const getVisibilityInfo = (el) => {
              if (!(el instanceof Element)) {
                return { visible: false, reason: "not_element" };
              }
              const style = window.getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              const reasons = [];
              if (el.hasAttribute("hidden")) reasons.push("hidden_attr");
              if ((el.getAttribute("aria-hidden") || "").toLowerCase() === "true") reasons.push("aria_hidden");
              if (el instanceof HTMLInputElement && (el.type || "").toLowerCase() === "hidden") reasons.push("input_hidden_type");
              if (style.display === "none") reasons.push("display_none");
              if (style.visibility === "hidden" || style.visibility === "collapse") reasons.push("visibility_hidden");
              if (Number(style.opacity) === 0) reasons.push("opacity_0");
              if (rect.width <= 0 || rect.height <= 0) reasons.push("zero_size");
              const viewportWidth = Math.max(document.documentElement?.clientWidth || 0, window.innerWidth || 0);
              const viewportHeight = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
              if (rect.bottom < 0 || rect.right < 0 || rect.top > viewportHeight || rect.left > viewportWidth) {
                reasons.push("offscreen");
              }
              const visible = reasons.length === 0;
              return {
                visible,
                reason: visible ? "visible" : reasons.join("|"),
              };
            };
            const selectors = ["input", "textarea", "select", "button", "a[href]", "[role='button']", "[role='link']", "[contenteditable='true']"];
            const elements = Array.from(document.querySelectorAll(selectors.join(",")));
            const seen = new Set();
            const tree = [];
            for (const el of elements) {
              if (!(el instanceof Element)) continue;
              const path = buildPath(el);
              if (!path || seen.has(path)) continue;
              seen.add(path);
              const visibility = getVisibilityInfo(el);
              const node = {
                ref: "ref_" + refHash(path),
                type: getType(el),
                visible: visibility.visible,
              };
              if (!visibility.visible) node.visibilityReason = visibility.reason;
              const name = getName(el);
              if (name) node.name = name;
              if (el instanceof HTMLInputElement) {
                if (el.type) node.inputType = el.type;
                if (el.placeholder) node.placeholder = el.placeholder;
                node.value = el.value ?? "";
              }
              if (el instanceof HTMLTextAreaElement) {
                if (el.placeholder) node.placeholder = el.placeholder;
                node.value = el.value ?? "";
              }
              if (el instanceof HTMLSelectElement) {
                node.value = el.value;
                node.options = Array.from(el.options).map((o) => o.text);
              }
              if ("disabled" in el) node.disabled = !!el.disabled;
              tree.push(node);
              if (tree.length >= 200) break;
            }
            return {
              tree,
              meta: {
                fallback: true,
                reason: "empty_tree_secondary_scan",
                url: window.location.href,
                title: document.title || "",
                readyState: document.readyState,
              },
            };
          })()`,
          awaitPromise: true,
          returnByValue: true,
          allowUnsafeEvalBlockedByCSP: true,
        })) as { result?: { value?: unknown } };
        const fallbackValue = fallbackExtraction.result?.value;
        if (fallbackValue) {
          payload = fallbackValue;
        }
      }

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
      "Read page structure as a ref-based tree, including per-element visibility metadata (visible, visibilityReason). Supports tabId, optional depth (default 15), filter ('all'|'interactive'), max_chars (default 50000), and ref_id for focused subtree reads.",
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
  async ({ ref, value, tabId, inputs }) => {
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

    return withTabActionLock(tabId, async () => {
      try {
        try {
          await ensureConsoleMonitor(tabId);
        } catch {
          // Best effort only; form input should still work if monitor installation fails.
        }

        const normalizedInputs =
          Array.isArray(inputs) && inputs.length > 0
            ? inputs
            : ref !== undefined && value !== undefined
              ? [{ ref, value }]
              : [];

        if (normalizedInputs.length === 0) {
          return JSON.stringify({
            success: false,
            action: "form_input",
            tabId,
            error: "Provide either (ref and value) or non-empty inputs array.",
          });
        }

        const applySingleInput = async (targetRef: string, nextValue: string | boolean | number) => {
          const payload = await withDebuggerSession(tabId, async (debuggee) => {
            await chrome.debugger.sendCommand(debuggee, "Runtime.enable");
            const evaluation = (await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
              expression: `(() => {
                const targetRef = ${JSON.stringify(targetRef)};
                const nextValue = ${JSON.stringify(nextValue)};

                const refHash = (input) => {
                  let hash = 0;
                  for (let i = 0; i < input.length; i += 1) {
                    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
                  }
                  return Math.abs(hash).toString(36);
                };

                const getRef = (path) => "ref_" + refHash(path);
                const root = document.documentElement || document.body;
                if (!root) {
                  return {
                    success: false,
                    action: "form_input",
                    ref: targetRef,
                    error: "No document root found.",
                  };
                }

                const findByRef = (el, path) => {
                  if (!(el instanceof Element)) return null;
                  if (getRef(path) === targetRef) return el;
                  const children = Array.from(el.children);
                  for (let i = 0; i < children.length; i += 1) {
                    const child = children[i];
                    const childPath = path + ">" + child.tagName.toLowerCase() + ":" + i;
                    const found = findByRef(child, childPath);
                    if (found) return found;
                  }
                  return null;
                };

                const target = findByRef(root, root.tagName.toLowerCase() + ":0");
                if (!target) {
                  return {
                    success: false,
                    action: "form_input",
                    ref: targetRef,
                    error: "Element reference not found. Use read_page or find again to refresh refs.",
                  };
                }

                const fireValueEvents = (el) => {
                  el.dispatchEvent(new Event("input", { bubbles: true }));
                  el.dispatchEvent(new Event("change", { bubbles: true }));
                };

                const toBoolean = (input) => {
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
              })()`,
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
                "Unknown form_input error";
              return {
                success: false,
                action: "form_input",
                ref: targetRef,
                error: message,
              };
            }

            return (
              (evaluation.result?.value as Record<string, unknown> | undefined) ?? {
                success: false,
                action: "form_input",
                ref: targetRef,
                error: "No result returned from page evaluation.",
              }
            );
          });

          const payloadRecord = (payload ?? {}) as Record<string, unknown>;
          if (payloadRecord.success !== true) {
            return {
              ...payloadRecord,
              tabId,
            };
          }

          const verified = await readFormValueByRef(tabId, targetRef);
          if (!verified.success) {
            return {
              success: false,
              action: "form_input",
              tabId,
              ref: targetRef,
              error: "Value write could not be verified.",
              verification: verified,
            };
          }

          const elementType = String(payloadRecord.elementType ?? "");
          const inputType = String(payloadRecord.inputType ?? "").toLowerCase();
          let expected: string | boolean;
          if (elementType === "input" && (inputType === "checkbox" || inputType === "radio")) {
            if (typeof nextValue === "boolean") {
              expected = nextValue;
            } else if (typeof nextValue === "number") {
              expected = nextValue !== 0;
            } else {
              const lowered = String(nextValue).trim().toLowerCase();
              expected = ["true", "1", "yes", "on"].includes(lowered);
            }
          } else if (elementType === "select") {
            expected = String(payloadRecord.value ?? "");
          } else {
            expected = String(nextValue ?? "");
          }

          const actual = verified.value;
          if (actual !== expected) {
            return {
              success: false,
              action: "form_input",
              tabId,
              ref: targetRef,
              error: "Value verification failed after input.",
              expected,
              actual,
              verification: verified,
            };
          }

          return {
            ...payloadRecord,
            tabId,
            verified: true,
            verification: {
              ref: targetRef,
              elementType: verified.elementType,
              ...(verified.elementType === "input" ? { inputType: verified.inputType } : {}),
              value: verified.value,
            },
          };
        };

        if (normalizedInputs.length === 1) {
          const single = normalizedInputs[0] as { ref: string; value: string | boolean | number };
          return JSON.stringify(await applySingleInput(single.ref, single.value));
        }

        const results: Array<Record<string, unknown>> = [];
        for (const entry of normalizedInputs) {
          const result = await applySingleInput(entry.ref, entry.value);
          results.push(result);
        }

        const succeeded = results.filter((r) => r.success === true).length;
        const failed = results.length - succeeded;
        return JSON.stringify({
          success: failed === 0,
          action: "form_input",
          mode: "batch",
          tabId,
          total: results.length,
          succeeded,
          failed,
          ...(failed > 0 ? { error: `Batch completed with ${failed} failed updates.` } : {}),
          results,
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
    });
  },
  {
    name: "form_input",
    description:
      "Set values in form elements using read_page/find refs. Supports either a single pair (ref, value) or batch mode via inputs array.",
    schema: z
      .object({
        tabId: z.number().int().describe("Tab ID to set form value in. Must be in current tab group/context."),
        ref: z.string().min(1).optional().describe("Single input ref from read_page/find (e.g., 'ref_1')."),
        value: z
          .union([z.string(), z.boolean(), z.number()])
          .optional()
          .describe(
            "Single input value. For checkboxes/radios prefer boolean; for selects use option value or visible text."
          ),
        inputs: z
          .array(
            z.object({
              ref: z.string().min(1).describe("Element ref from read_page/find."),
              value: z.union([z.string(), z.boolean(), z.number()]).describe("Value to set for this ref."),
            })
          )
          .min(1)
          .max(100)
          .optional()
          .describe("Batch inputs to set in one call. Prefer this for multi-field forms."),
      })
      .superRefine((data, ctx) => {
        const hasSingle = data.ref !== undefined || data.value !== undefined;
        const hasBothSingle = data.ref !== undefined && data.value !== undefined;
        const hasBatch = Array.isArray(data.inputs) && data.inputs.length > 0;
        if (!hasBatch && !hasBothSingle) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Provide either both 'ref' and 'value' or a non-empty 'inputs' array.",
          });
        }
        if (hasSingle && !hasBothSingle) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Single-input mode requires both 'ref' and 'value'.",
          });
        }
        if (hasBatch && hasSingle) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Provide either single-input fields (ref/value) or batch inputs, not both.",
          });
        }
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

          const activeFieldBefore = await readActiveFieldValue(tabId);
          if (activeFieldBefore.hasActiveField) {
            await withDebuggerSession(tabId, async (debuggee) => {
              await chrome.debugger.sendCommand(debuggee, "Input.insertText", { text });
            });
            const activeFieldAfter = await readActiveFieldValue(tabId);

            return JSON.stringify({
              success: true,
              action,
              tabId,
              mode: "insert_text",
              textEntered: text,
              ...(activeFieldAfter.hasActiveField ? { currentFieldValue: activeFieldAfter.value ?? "" } : {}),
              ...(activeFieldAfter.inputType === "email"
                ? { validEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(activeFieldAfter.value ?? "") }
                : {}),
            });
          }

          const tokens: string[] = [];
          const skippedCharacters: string[] = [];
          for (const char of text) {
            const token = charToKeyToken(char);
            if (!token) {
              skippedCharacters.push(char);
              continue;
            }
            tokens.push(token);
          }

          if (tokens.length === 0) {
            return fail("No typable key events could be derived from the provided text.", {
              skippedCharacters: skippedCharacters.slice(0, 20),
            });
          }

          const dispatchedTokens: string[] = [];
          const failedTokens: Array<{ token: string; error: string }> = [];
          await withDebuggerSession(tabId, async (debuggee) => {
            for (const token of tokens) {
              const dispatched = await dispatchKeyToken(debuggee, token, 0);
              if (!dispatched.ok) {
                failedTokens.push({ token, error: dispatched.error });
                continue;
              }
              dispatchedTokens.push(token);
            }
          });

          return JSON.stringify({
            success: failedTokens.length === 0 && skippedCharacters.length === 0,
            action,
            tabId,
            mode: "key_events",
            textEntered: text,
            requestedCharacters: text.length,
            dispatchedKeyEvents: dispatchedTokens.length,
            skippedCharactersCount: skippedCharacters.length,
            ...(skippedCharacters.length > 0 ? { skippedCharacters: skippedCharacters.slice(0, 20) } : {}),
            failedKeyEventsCount: failedTokens.length,
            ...(failedTokens.length > 0 ? { failedKeyEvents: failedTokens.slice(0, 10) } : {}),
            note:
              "Used keydown/keyup events because no editable field was focused. This is required for keyboard-test style pages.",
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
          const locationBeforeClick = await getPageLocation(tabId);
          await withDebuggerSession(tabId, async (debuggee) => {
            await dispatchClick(debuggee, resolved.coordinate, button, clickCount, parsedModifiers.bitmask);
          });
          const locationAfterClick = await getPageLocation(tabId);

          const clickInfo = await describeElementAtCoordinate(tabId, resolved.coordinate);
          const navigatedAfterClick =
            Boolean(locationBeforeClick?.url) &&
            Boolean(locationAfterClick?.url) &&
            locationBeforeClick?.url !== locationAfterClick?.url;
          if (
            resolved.fromRef &&
            ref &&
            clickInfo.element?.ref &&
            clickInfo.element.ref !== ref
          ) {
            if (!navigatedAfterClick) {
              const relationCheck = await verifyCoordinateMatchesRef(tabId, ref, resolved.coordinate);
              const permissionBlocked =
                typeof relationCheck.error === "string" &&
                relationCheck.error.includes("Extension manifest must request permission");
              if (!relationCheck.ok && !permissionBlocked) {
                return fail("Click target verification failed: clicked element does not match requested ref.", {
                  ref,
                  clickedElement: clickInfo.element,
                  verification: relationCheck,
                });
              }
            }
          }

          const maybeSubmitClick =
            action === "left_click" &&
            resolved.fromRef &&
            (resolved.element?.type === "button" ||
              /submit|apply/i.test(String(resolved.element?.name ?? "")));
          const submitOutcome = maybeSubmitClick ? await inspectSubmitOutcome(tabId) : null;
          return JSON.stringify({
            success: true,
            action,
            tabId,
            ...(resolved.fromRef ? { ref } : { coordinate: resolved.coordinate }),
            ...(parsedModifiers.normalized ? { modifiers: parsedModifiers.normalized } : {}),
            ...(clickInfo.element ? { clickedElement: clickInfo.element } : {}),
            ...(resolved.element ? { requestedElement: resolved.element } : {}),
            ...(locationBeforeClick ? { locationBeforeClick } : {}),
            ...(locationAfterClick ? { locationAfterClick } : {}),
            ...(navigatedAfterClick ? { navigationAfterClick: true } : {}),
            ...(submitOutcome ? { submitOutcome } : {}),
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
    schema: z
      .object({
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
      })
      .superRefine((data, ctx) => {
        const hasCoordinate = Array.isArray(data.coordinate) && data.coordinate.length === 2;
        const hasStartCoordinate = Array.isArray(data.start_coordinate) && data.start_coordinate.length === 2;
        const hasRef = typeof data.ref === "string" && data.ref.trim().length > 0;
        const hasText = typeof data.text === "string" && data.text.trim().length > 0;
        const hasDuration = typeof data.duration === "number";
        const hasScrollDirection = typeof data.scroll_direction === "string";
        const hasRegion = Array.isArray(data.region) && data.region.length === 4;

        if (data.action === "scroll_to" && !hasRef) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "action='scroll_to' requires 'ref'.",
            path: ["ref"],
          });
        }
        if (data.action === "scroll" && !hasCoordinate) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "action='scroll' requires 'coordinate'.",
            path: ["coordinate"],
          });
        }
        if (data.action === "scroll" && !hasScrollDirection) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "action='scroll' requires 'scroll_direction'.",
            path: ["scroll_direction"],
          });
        }
        if (data.action === "wait" && !hasDuration) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "action='wait' requires 'duration'.",
            path: ["duration"],
          });
        }
        if ((data.action === "type" || data.action === "key") && !hasText) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `action='${data.action}' requires non-empty 'text'.`,
            path: ["text"],
          });
        }
        if (data.action === "left_click_drag" && (!hasCoordinate || !hasStartCoordinate)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "action='left_click_drag' requires both 'start_coordinate' and 'coordinate'.",
          });
        }
        if (data.action === "zoom" && !hasRegion) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "action='zoom' requires 'region'.",
            path: ["region"],
          });
        }
        if (
          (data.action === "left_click" ||
            data.action === "right_click" ||
            data.action === "double_click" ||
            data.action === "triple_click" ||
            data.action === "hover") &&
          !hasCoordinate &&
          !hasRef
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `action='${data.action}' requires either 'coordinate' or 'ref'.`,
          });
        }
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
          let markPayload:
            | { success: true }
            | { success: false; error: string }
            | undefined;
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
            markPayload = markResult?.[0]?.result as
              | { success: true }
              | { success: false; error: string }
              | undefined;
          } catch {
            markPayload = await evaluateTabWithDebugger<{ success: true } | { success: false; error: string }>(
              tabId,
              `(() => {
                const targetRef = ${JSON.stringify(ref)};
                const attrName = ${JSON.stringify(markerAttr)};
                const attrValue = ${JSON.stringify(markerValue)};
                const refHash = (input) => {
                  let hash = 0;
                  for (let i = 0; i < input.length; i += 1) {
                    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
                  }
                  return Math.abs(hash).toString(36);
                };
                const getRef = (path) => "ref_" + refHash(path);
                const root = document.documentElement || document.body;
                if (!root) {
                  return { success: false, error: "No document root found." };
                }
                const findByRef = (el, path) => {
                  if (!(el instanceof Element)) return null;
                  if (getRef(path) === targetRef) return el;
                  const children = Array.from(el.children);
                  for (let i = 0; i < children.length; i += 1) {
                    const child = children[i];
                    const childPath = path + ">" + child.tagName.toLowerCase() + ":" + i;
                    const found = findByRef(child, childPath);
                    if (found) return found;
                  }
                  return null;
                };
                const target = findByRef(root, root.tagName.toLowerCase() + ":0");
                if (!(target instanceof HTMLInputElement) || target.type.toLowerCase() !== "file") {
                  return { success: false, error: "Target element is not a file input." };
                }
                target.setAttribute(attrName, attrValue);
                return { success: true };
              })()`
            );
          }

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
          try {
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
          } catch {
            await evaluateTabWithDebugger<void>(
              tabId,
              `(() => {
                const attrName = ${JSON.stringify(markerAttr)};
                const attrValue = ${JSON.stringify(markerValue)};
                const el = document.querySelector("[" + attrName + "=\\"" + attrValue + "\\"]");
                if (el) {
                  el.removeAttribute(attrName);
                }
              })()`
            );
          }
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
        let result: (
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
          | undefined);
        try {
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
          result = injection?.result as
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
            | undefined;
        } catch {
          result = await evaluateTabWithDebugger<
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
          >(
            tabId,
            `(() => {
              const targetRefArg = ${JSON.stringify(targetRef)};
              const dataUrl = ${JSON.stringify(storedImage.dataUrl)};
              const finalName = ${JSON.stringify(uploadFilename)};
              const contentType = ${JSON.stringify(mimeType)};
              const refHash = (input) => {
                let hash = 0;
                for (let i = 0; i < input.length; i += 1) {
                  hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
                }
                return Math.abs(hash).toString(36);
              };
              const getRef = (path) => "ref_" + refHash(path);
              const root = document.documentElement || document.body;
              if (!root) {
                return { success: false, error: "No document root found." };
              }
              const findByRef = (el, path) => {
                if (!(el instanceof Element)) return null;
                if (getRef(path) === targetRefArg) return el;
                const children = Array.from(el.children);
                for (let i = 0; i < children.length; i += 1) {
                  const child = children[i];
                  const childPath = path + ">" + child.tagName.toLowerCase() + ":" + i;
                  const found = findByRef(child, childPath);
                  if (found) return found;
                }
                return null;
              };
              return Promise.resolve().then(async () => {
                const target = findByRef(root, root.tagName.toLowerCase() + ":0");
                if (!target) {
                  return { success: false, error: "Element reference not found. Use read_page/find again to refresh refs." };
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
              });
            })()`
          );
        }
        result = result ?? { success: false as const, error: "Failed to upload image by ref." };

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
      let result: (
        | {
            success: true;
            method: "drag_and_drop";
            dropTarget: { coordinate: [number, number]; element: string };
            uploadedFile: { name: string; size: number; mimeType: string };
          }
        | { success: false; error: string }
        | undefined);
      try {
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
        result = injection?.result as
          | {
              success: true;
              method: "drag_and_drop";
              dropTarget: { coordinate: [number, number]; element: string };
              uploadedFile: { name: string; size: number; mimeType: string };
            }
          | { success: false; error: string }
          | undefined;
      } catch {
        result = await evaluateTabWithDebugger<
          | {
              success: true;
              method: "drag_and_drop";
              dropTarget: { coordinate: [number, number]; element: string };
              uploadedFile: { name: string; size: number; mimeType: string };
            }
          | { success: false; error: string }
        >(
          tabId,
          `(() => {
            const x = ${JSON.stringify(point[0])};
            const y = ${JSON.stringify(point[1])};
            const dataUrl = ${JSON.stringify(storedImage.dataUrl)};
            const finalName = ${JSON.stringify(uploadFilename)};
            const contentType = ${JSON.stringify(mimeType)};
            return Promise.resolve().then(async () => {
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
            });
          })()`
        );
      }
      result = result ?? { success: false as const, error: "Failed to upload image by coordinate." };

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
    schema: z
      .object({
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
      })
      .superRefine((data, ctx) => {
        const hasRef = typeof data.ref === "string" && data.ref.trim().length > 0;
        const hasCoordinate = Array.isArray(data.coordinate) && data.coordinate.length === 2;
        if (hasRef === hasCoordinate) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Provide exactly one of 'ref' or 'coordinate' (not both).",
          });
        }
      }),
  }
);

const readConsoleMessagesTool = tool(
  async ({ tabId, pattern, clear, limit, onlyErrors }) => {
    const scope = await validateTabInCurrentScope(tabId);
    if (!scope.ok) {
      return JSON.stringify({
        success: false,
        action: "read_console_messages",
        tabId,
        error: scope.error,
      });
    }

    const fail = (message: string, extras: Record<string, unknown> = {}) =>
      JSON.stringify({
        success: false,
        action: "read_console_messages",
        tabId,
        ...extras,
        error: message,
      });

    let compiledPattern: RegExp;
    try {
      compiledPattern = new RegExp(pattern, "i");
    } catch (error) {
      return fail(`Invalid regex pattern: ${String(error)}`, { pattern });
    }

    const appliedLimit = typeof limit === "number" ? Math.max(1, Math.floor(limit)) : 100;
    const shouldClear = Boolean(clear);
    const errorsOnly = Boolean(onlyErrors);

    try {
      await ensureConsoleMonitor(tabId);

      const currentDomain = parseHostname(scope.targetTab.url) ?? null;
      const filterEntries = (entries: ConsoleCapturedMessage[]) =>
        entries
          .filter((entry) => {
            if (!entry || typeof entry.message !== "string") {
              return false;
            }
            const entryDomain = parseHostname(entry.url);
            if (currentDomain && entryDomain && entryDomain !== currentDomain) {
              return false;
            }
            if (errorsOnly && !(entry.type === "error" || entry.type === "exception")) {
              return false;
            }
            const searchable = [
              entry.type ?? "",
              entry.source ?? "",
              entry.url ?? "",
              entry.message ?? "",
            ].join(" ");
            return compiledPattern.test(searchable);
          })
          .slice(-appliedLimit)
          .map((entry) => ({
            type: entry.type || "log",
            message: entry.message,
            timestamp: entry.timestamp || new Date().toISOString(),
            ...(entry.source ? { source: entry.source } : {}),
          }));

      let rawEntries = await readConsoleBuffer(tabId, false);
      let filtered = filterEntries(rawEntries);

      // Handles turns where an action tool and read_console_messages are invoked in parallel.
      if (filtered.length === 0) {
        await sleep(250);
        rawEntries = await readConsoleBuffer(tabId, false);
        filtered = filterEntries(rawEntries);
      }

      if (shouldClear) {
        await readConsoleBuffer(tabId, true);
      }

      return JSON.stringify({
        success: true,
        action: "read_console_messages",
        tabId,
        messagesCount: filtered.length,
        ...(shouldClear ? { messagesCleared: true } : {}),
        ...(limit !== undefined ? { limitApplied: appliedLimit } : {}),
        messages: filtered,
      });
    } catch (error) {
      return fail(String(error), { pattern });
    }
  },
  {
    name: "read_console_messages",
    description:
      "Read browser console messages from a tab filtered by regex pattern. Supports clear, limit, and onlyErrors options.",
    schema: z.object({
      tabId: z.number().int().describe("Tab ID to read console messages from."),
      pattern: z
        .string()
        .min(1)
        .describe(
          "Regex pattern to filter console messages, e.g. 'error|warning' or 'MyApp'."
        ),
      clear: z
        .boolean()
        .optional()
        .describe("If true, clear captured console messages after reading. Default false."),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum messages to return. Default 100."),
      onlyErrors: z
        .boolean()
        .optional()
        .describe("If true, return only error and exception messages. Default false."),
    }),
  }
);

const readNetworkRequestsTool = tool(
  async ({ tabId, limit, clear, urlPattern }) => {
    const scope = await validateTabInCurrentScope(tabId);
    if (!scope.ok) {
      return JSON.stringify({
        success: false,
        action: "read_network_requests",
        tabId,
        error: scope.error,
      });
    }

    const fail = (message: string, extras: Record<string, unknown> = {}) =>
      JSON.stringify({
        success: false,
        action: "read_network_requests",
        tabId,
        ...extras,
        error: message,
      });

    const appliedLimit = typeof limit === "number" ? Math.max(1, Math.floor(limit)) : 100;
    const shouldClear = Boolean(clear);
    const pattern = typeof urlPattern === "string" ? urlPattern : undefined;

    try {
      await ensureNetworkMonitor(tabId);

      let rawEntries = await readNetworkBuffer(tabId, false);
      if (rawEntries.length === 0) {
        await sleep(250);
        rawEntries = await readNetworkBuffer(tabId, false);
      }

      const filtered = rawEntries
        .filter((entry) => {
          if (!entry || typeof entry.url !== "string") {
            return false;
          }
          if (pattern && !entry.url.includes(pattern)) {
            return false;
          }
          return true;
        })
        .slice(-appliedLimit)
        .map((entry) => ({
          url: entry.url,
          method: entry.method || "GET",
          resourceType: entry.resourceType || "resource",
          ...(typeof entry.statusCode === "number" ? { statusCode: entry.statusCode } : {}),
          ...(typeof entry.responseTime === "number" ? { responseTime: entry.responseTime } : {}),
          ...(typeof entry.size === "number" ? { size: entry.size } : {}),
          timestamp: entry.timestamp || new Date().toISOString(),
          ...(entry.requestBody ? { requestBody: entry.requestBody } : {}),
        }));

      if (shouldClear) {
        await readNetworkBuffer(tabId, true);
      }

      return JSON.stringify({
        success: true,
        action: "read_network_requests",
        tabId,
        requestsCount: filtered.length,
        ...(pattern ? { pattern } : {}),
        ...(shouldClear ? { requestsCleared: true } : {}),
        ...(limit !== undefined ? { limitApplied: appliedLimit } : {}),
        requests: filtered,
      });
    } catch (error) {
      return fail(String(error), pattern ? { urlPattern: pattern } : {});
    }
  },
  {
    name: "read_network_requests",
    description:
      "Read captured network requests for a tab, with optional urlPattern filtering, limit, and clear behavior.",
    schema: z.object({
      tabId: z.number().int().describe("Tab ID to read network requests from."),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of requests to return. Default 100."),
      clear: z
        .boolean()
        .optional()
        .describe("If true, clear captured requests after reading. Default false."),
      urlPattern: z
        .string()
        .optional()
        .describe("Optional URL substring filter (e.g., '/api/' or 'example.com')."),
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

type ToolValidationError = {
  toolName: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasCoordinateTuple(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((x) => typeof x === "number");
}

function validateToolCallArgs(toolName: string, rawArgs: unknown): ToolValidationError[] {
  const errors: ToolValidationError[] = [];
  const args = isRecord(rawArgs) ? rawArgs : {};

  const requireInt = (field: string) => {
    const value = args[field];
    if (!(typeof value === "number" && Number.isInteger(value))) {
      errors.push({ toolName, message: `Parameter '${field}' is required and must be an integer.` });
    }
  };

  switch (toolName) {
    case "tabs_context":
    case "tabs_create":
    case "turn_answer_start":
      return errors;
    case "navigate":
      requireInt("tabId");
      if (!hasNonEmptyString(args.url)) {
        errors.push({ toolName, message: "Parameter 'url' is required." });
      }
      return errors;
    case "resize_window":
      requireInt("tabId");
      requireInt("width");
      requireInt("height");
      return errors;
    case "get_page_text":
      requireInt("tabId");
      return errors;
    case "read_page":
      requireInt("tabId");
      return errors;
    case "find":
      requireInt("tabId");
      if (!hasNonEmptyString(args.query)) {
        errors.push({ toolName, message: "Parameter 'query' is required." });
      }
      return errors;
    case "form_input": {
      requireInt("tabId");
      const hasRef = hasNonEmptyString(args.ref);
      const hasValue = Object.prototype.hasOwnProperty.call(args, "value");
      const hasInputs = Array.isArray(args.inputs) && args.inputs.length > 0;
      if (!hasInputs && !(hasRef && hasValue)) {
        errors.push({
          toolName,
          message: "Provide either both 'ref' and 'value' or a non-empty 'inputs' array.",
        });
      }
      if (hasInputs && (hasRef || hasValue)) {
        errors.push({
          toolName,
          message: "Use either single-input mode ('ref' + 'value') or batch mode ('inputs'), not both.",
        });
      }
      return errors;
    }
    case "computer": {
      requireInt("tabId");
      if (!hasNonEmptyString(args.action)) {
        errors.push({ toolName, message: "Parameter 'action' is required." });
        return errors;
      }

      const action = args.action;
      const hasCoordinate = hasCoordinateTuple(args.coordinate);
      const hasStart = hasCoordinateTuple(args.start_coordinate);
      const hasRef = hasNonEmptyString(args.ref);
      const hasText = hasNonEmptyString(args.text);
      const hasDuration = typeof args.duration === "number";
      const hasRegion = Array.isArray(args.region) && args.region.length === 4;

      if (action === "scroll_to" && !hasRef) {
        errors.push({ toolName, message: "Parameter 'ref' is required for action 'scroll_to'." });
      }
      if (action === "scroll") {
        if (!hasCoordinate) {
          errors.push({ toolName, message: "Parameter 'coordinate' is required for action 'scroll'." });
        }
        if (!hasNonEmptyString(args.scroll_direction)) {
          errors.push({ toolName, message: "Parameter 'scroll_direction' is required for action 'scroll'." });
        }
      }
      if (action === "wait" && !hasDuration) {
        errors.push({ toolName, message: "Parameter 'duration' is required for action 'wait'." });
      }
      if ((action === "type" || action === "key") && !hasText) {
        errors.push({ toolName, message: `Parameter 'text' is required for action '${action}'.` });
      }
      if (action === "left_click_drag" && (!hasCoordinate || !hasStart)) {
        errors.push({
          toolName,
          message: "Parameters 'start_coordinate' and 'coordinate' are required for action 'left_click_drag'.",
        });
      }
      if (action === "zoom" && !hasRegion) {
        errors.push({ toolName, message: "Parameter 'region' is required for action 'zoom'." });
      }
      if (
        (action === "left_click" ||
          action === "right_click" ||
          action === "double_click" ||
          action === "triple_click" ||
          action === "hover") &&
        !hasCoordinate &&
        !hasRef
      ) {
        errors.push({ toolName, message: `Action '${action}' requires either 'coordinate' or 'ref'.` });
      }
      return errors;
    }
    case "upload_image": {
      requireInt("tabId");
      if (!hasNonEmptyString(args.imageId)) {
        errors.push({ toolName, message: "Parameter 'imageId' is required." });
      }
      const hasRef = hasNonEmptyString(args.ref);
      const hasCoordinate = hasCoordinateTuple(args.coordinate);
      if (hasRef === hasCoordinate) {
        errors.push({ toolName, message: "Provide exactly one of 'ref' or 'coordinate'." });
      }
      return errors;
    }
    case "file_upload":
      requireInt("tabId");
      if (!hasNonEmptyString(args.ref)) {
        errors.push({ toolName, message: "Parameter 'ref' is required." });
      }
      if (!(Array.isArray(args.paths) && args.paths.length > 0)) {
        errors.push({ toolName, message: "Parameter 'paths' is required and must be a non-empty array." });
      }
      return errors;
    case "read_console_messages":
      requireInt("tabId");
      if (!hasNonEmptyString(args.pattern)) {
        errors.push({ toolName, message: "Parameter 'pattern' is required." });
      }
      return errors;
    case "read_network_requests":
      requireInt("tabId");
      return errors;
    case "javascript_tool":
      requireInt("tabId");
      if (args.action !== "javascript_exec") {
        errors.push({ toolName, message: "Parameter 'action' must be 'javascript_exec'." });
      }
      if (!hasNonEmptyString(args.text)) {
        errors.push({ toolName, message: "Parameter 'text' is required." });
      }
      return errors;
    default:
      errors.push({ toolName, message: `Unknown tool '${toolName}'.` });
      return errors;
  }
}

function buildToolValidationErrorMessage(toolName: string, validationErrors: ToolValidationError[]) {
  return JSON.stringify({
    success: false,
    action: toolName,
    error: `Tool argument validation failed: ${validationErrors.map((e) => e.message).join(" ")}`,
  });
}

function buildVisionContextMessageFromLastTool(messages: BaseMessage[]): HumanMessage | null {
  const lastMessage = messages.at(-1);
  if (!lastMessage || getMessageType(lastMessage) !== "tool") {
    return null;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(getTextContent(lastMessage.content)) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (payload.success !== true) {
    return null;
  }

  const action = typeof payload.action === "string" ? payload.action : "";
  if (action !== "screenshot" && action !== "zoom") {
    return null;
  }

  const imageId = typeof payload.imageId === "string" ? payload.imageId : "";
  if (!imageId) {
    return null;
  }

  const storedImage = screenshotStore.get(imageId);
  if (!storedImage) {
    return null;
  }
  if (storedImage.dataUrl.length > MAX_VISION_SCREENSHOT_DATA_URL_CHARS) {
    return null;
  }
  if (!storedImage.dataUrl.startsWith("data:image/")) {
    return null;
  }

  return new HumanMessage({
    content: [
      {
        type: "text",
        text:
          `Latest browser ${storedImage.kind} for visual context ` +
          `(imageId: ${storedImage.id}, tabId: ${storedImage.tabId}). ` +
          "Use this image to understand the current screen before deciding the next action.",
      },
      {
        type: "image_url",
        image_url: {
          url: storedImage.dataUrl,
        },
      },
    ] as any,
  });
}

type ParsedScrollResult = {
  success: boolean;
  action?: string;
  tabId?: number;
  direction?: string;
  newScrollPosition?: number;
};

function parseScrollToolResult(message: BaseMessage): ParsedScrollResult | null {
  if (getMessageType(message) !== "tool") {
    return null;
  }
  try {
    const parsed = JSON.parse(getTextContent(message.content)) as Record<string, unknown>;
    if (parsed.action !== "scroll") {
      return null;
    }
    return {
      success: parsed.success === true,
      action: typeof parsed.action === "string" ? parsed.action : undefined,
      tabId: typeof parsed.tabId === "number" ? parsed.tabId : undefined,
      direction: typeof parsed.direction === "string" ? parsed.direction : undefined,
      newScrollPosition:
        typeof parsed.newScrollPosition === "number" ? parsed.newScrollPosition : undefined,
    };
  } catch {
    return null;
  }
}

function detectRedundantScrollCall(
  messages: BaseMessage[],
  toolName: string,
  rawArgs: unknown
): ToolValidationError[] {
  if (toolName !== "computer" || !isRecord(rawArgs)) {
    return [];
  }
  if (rawArgs.action !== "scroll") {
    return [];
  }

  const tabId = typeof rawArgs.tabId === "number" ? rawArgs.tabId : undefined;
  const direction = typeof rawArgs.scroll_direction === "string" ? rawArgs.scroll_direction : undefined;
  if (!tabId || !direction) {
    return [];
  }

  const scrollResults: ParsedScrollResult[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const result = parseScrollToolResult(messages[i]);
    if (!result || !result.success) {
      continue;
    }
    if (result.tabId !== tabId || result.direction !== direction) {
      continue;
    }
    scrollResults.push(result);
    if (scrollResults.length === 2) {
      break;
    }
  }

  if (scrollResults.length < 2) {
    return [];
  }

  const [latest, previous] = scrollResults;
  if (
    typeof latest.newScrollPosition === "number" &&
    typeof previous.newScrollPosition === "number" &&
    latest.newScrollPosition === previous.newScrollPosition
  ) {
    const edge = direction === "down" ? "bottom" : direction === "up" ? "top" : "edge";
    return [
      {
        toolName,
        message:
          `Blocked redundant scroll: last two '${direction}' scroll calls had no position change ` +
          `(${latest.newScrollPosition}). Likely at page ${edge}.`,
      },
    ];
  }

  return [];
}

const tools = [
  tabsContextTool,
  tabsCreateTool,
  readPageTool,
  findTool,
  formInputTool,
  computerTool,
  uploadImageTool,
  fileUploadTool,
  readConsoleMessagesTool,
  readNetworkRequestsTool,
  navigateTool,
  resizeWindowTool,
  getPageTextTool,
  javascriptTool,
  turnAnswerStartTool,
];
const executionToolNode = new ToolNode(tools);
const toolNode = async (state: typeof MessagesAnnotation.State) => {
  const lastMessage = state.messages.at(-1);
  if (!lastMessage || getMessageType(lastMessage) !== "ai") {
    return { messages: [] };
  }

  const ai = lastMessage as unknown as {
    tool_calls?: Array<{ id?: string; name?: string; args?: unknown }>;
  };
  if (!Array.isArray(ai.tool_calls) || ai.tool_calls.length === 0) {
    return { messages: [] };
  }

  const validationMessages: ToolMessage[] = [];
  for (const call of ai.tool_calls) {
    const toolName = call.name ?? "unknown";
    const validationErrors = [
      ...validateToolCallArgs(toolName, call.args),
      ...detectRedundantScrollCall(state.messages as BaseMessage[], toolName, call.args),
    ];
    if (validationErrors.length > 0) {
      validationMessages.push(
        new ToolMessage({
          tool_call_id: call.id ?? crypto.randomUUID(),
          name: toolName,
          content: buildToolValidationErrorMessage(toolName, validationErrors),
        })
      );
    }
  }

  if (validationMessages.length > 0) {
    return { messages: validationMessages };
  }

  return executionToolNode.invoke(state);
};
const checkpointer = new MemorySaver();
let fallbackSettings: LlmSettings | undefined;
let fallbackAbortSignal: AbortSignal | undefined;

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

function hasToolCalls(message: BaseMessage): boolean {
  const maybeAi = message as unknown as {
    tool_calls?: Array<{ name?: string }>;
  };
  return Array.isArray(maybeAi.tool_calls) && maybeAi.tool_calls.length > 0;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const objectValue = value as Record<string, unknown>;
  const keys = Object.keys(objectValue).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`).join(",")}}`;
}

function getSingleToolCallSignature(message: BaseMessage): string | null {
  const maybeAi = message as unknown as {
    tool_calls?: Array<{ name?: string; args?: Record<string, unknown> }>;
  };
  if (!Array.isArray(maybeAi.tool_calls) || maybeAi.tool_calls.length !== 1) {
    return null;
  }
  const [call] = maybeAi.tool_calls;
  if (!call?.name) {
    return null;
  }
  return `${call.name}:${stableStringify(call.args ?? {})}`;
}

type ToolResultMeta = {
  success?: boolean;
  ref?: string;
};

function parseToolResultMeta(message: BaseMessage): ToolResultMeta {
  try {
    const raw = getTextContent(message.content);
    const parsed = JSON.parse(raw) as {
      success?: unknown;
      ref?: unknown;
      verification?: { ref?: unknown };
    };
    const ref =
      typeof parsed.ref === "string"
        ? parsed.ref
        : typeof parsed.verification?.ref === "string"
          ? parsed.verification.ref
          : undefined;
    return {
      success: typeof parsed.success === "boolean" ? parsed.success : undefined,
      ref,
    };
  } catch {
    return {};
  }
}

type ToolLoopAssessment = {
  shouldStop: boolean;
  reasonCode: "none" | "repeat_streak" | "failure_streak" | "low_diversity_churn" | "hard_cap";
  totalToolCalls: number;
  distinctSignatures: number;
  longestRepeatStreak: number;
  consecutiveFailures: number;
  uniqueRefsTouched: number;
};

function assessToolLoop(messages: BaseMessage[], maxScan = 160): ToolLoopAssessment {
  const tail: BaseMessage[] = [];
  const start = Math.max(0, messages.length - maxScan);
  for (let i = messages.length - 1; i >= start; i -= 1) {
    const message = messages[i];
    const type = getMessageType(message);
    if (type === "tool" || (type === "ai" && hasToolCalls(message))) {
      tail.push(message);
      continue;
    }
    break;
  }

  if (tail.length === 0) {
    return {
      shouldStop: false,
      reasonCode: "none",
      totalToolCalls: 0,
      distinctSignatures: 0,
      longestRepeatStreak: 0,
      consecutiveFailures: 0,
      uniqueRefsTouched: 0,
    };
  }

  const chronological = tail.reverse();
  const signatures: string[] = [];
  const refs = new Set<string>();
  let consecutiveFailures = 0;
  let failureStreakOpen = true;
  for (let i = chronological.length - 1; i >= 0; i -= 1) {
    const message = chronological[i];
    const type = getMessageType(message);
    if (type === "ai") {
      const signature = getSingleToolCallSignature(message);
      if (signature) {
        signatures.push(signature);
      }
      continue;
    }
    if (type === "tool") {
      const meta = parseToolResultMeta(message);
      if (meta.ref) {
        refs.add(meta.ref);
      }
      if (failureStreakOpen && meta.success === false) {
        consecutiveFailures += 1;
      } else if (meta.success === true) {
        failureStreakOpen = false;
      }
    }
  }

  let longestRepeatStreak = 0;
  let runningStreak = 0;
  let previousSignature = "";
  for (const signature of signatures) {
    if (signature === previousSignature) {
      runningStreak += 1;
    } else {
      previousSignature = signature;
      runningStreak = 1;
    }
    if (runningStreak > longestRepeatStreak) {
      longestRepeatStreak = runningStreak;
    }
  }

  const totalToolCalls = signatures.length;
  const distinctSignatures = new Set(signatures).size;
  const uniqueRefsTouched = refs.size;

  const hardCap = tail.length >= 140;
  const repeatedIdenticalCall = longestRepeatStreak >= 6;
  const repeatedFailures = consecutiveFailures >= 4;
  const lowDiversityChurn =
    totalToolCalls >= 24 && distinctSignatures <= 2 && (uniqueRefsTouched === 0 || uniqueRefsTouched <= 2);

  const reasonCode = hardCap
    ? "hard_cap"
    : repeatedIdenticalCall
      ? "repeat_streak"
      : repeatedFailures
        ? "failure_streak"
        : lowDiversityChurn
          ? "low_diversity_churn"
          : "none";

  return {
    shouldStop: reasonCode !== "none",
    reasonCode,
    totalToolCalls,
    distinctSignatures,
    longestRepeatStreak,
    consecutiveFailures,
    uniqueRefsTouched,
  };
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

  if (trimmed.startsWith("/read_console_messages")) {
    const raw = trimmed.replace(/^\/read_console_messages\s*/, "");
    const parts = raw.split(/\s+/).filter(Boolean);
    const parsedTabId = Number.parseInt(parts[0] ?? "", 10);
    const patternText = parts[1];
    if (Number.isInteger(parsedTabId) && patternText) {
      const clearFlag = parts.includes("clear=true");
      const onlyErrorsFlag = parts.includes("onlyErrors=true");
      const limitPart = parts.find((part) => part.startsWith("limit="));
      const parsedLimit = limitPart ? Number.parseInt(limitPart.replace(/^limit=/, ""), 10) : undefined;

      return {
        name: readConsoleMessagesTool.name,
        args: {
          tabId: parsedTabId,
          pattern: patternText,
          ...(clearFlag ? { clear: true } : {}),
          ...(onlyErrorsFlag ? { onlyErrors: true } : {}),
          ...(Number.isInteger(parsedLimit) ? { limit: parsedLimit } : {}),
        },
      };
    }
  }

  if (trimmed.startsWith("/read_network_requests")) {
    const raw = trimmed.replace(/^\/read_network_requests\s*/, "");
    const parts = raw.split(/\s+/).filter(Boolean);
    const parsedTabId = Number.parseInt(parts[0] ?? "", 10);
    if (Number.isInteger(parsedTabId)) {
      const clearFlag = parts.includes("clear=true");
      const limitPart = parts.find((part) => part.startsWith("limit="));
      const parsedLimit = limitPart ? Number.parseInt(limitPart.replace(/^limit=/, ""), 10) : undefined;
      const patternPart = parts.find((part) => part.startsWith("urlPattern="));
      const parsedUrlPattern = patternPart ? patternPart.replace(/^urlPattern=/, "") : undefined;

      return {
        name: readNetworkRequestsTool.name,
        args: {
          tabId: parsedTabId,
          ...(clearFlag ? { clear: true } : {}),
          ...(Number.isInteger(parsedLimit) ? { limit: parsedLimit } : {}),
          ...(parsedUrlPattern ? { urlPattern: parsedUrlPattern } : {}),
        },
      };
    }
  }

  return null;
}

async function loadLlmSettingsFromStorage(): Promise<LlmSettings | undefined> {
  const result = await chrome.storage.local.get("llmSettings");
  const settings = result.llmSettings as LlmSettings | undefined;
  if (!settings) return undefined;
  if (settings.provider === "openai") {
    if (!settings.apiKey || !settings.model) return undefined;
    return settings;
  }
  if (settings.provider === "ollama") {
    if (!settings.model) return undefined;
    return settings;
  }
  return undefined;
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
  if (!settings?.model) {
    return {
      messages: [
        new AIMessage("Missing LLM settings. Open extension Options and configure a provider + model."),
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

  const loopAssessment = assessToolLoop(state.messages as BaseMessage[]);
  if (loopAssessment.shouldStop) {
    const reasonText =
      loopAssessment.reasonCode === "repeat_streak"
        ? `repeated identical tool call (${loopAssessment.longestRepeatStreak}x in a row)`
        : loopAssessment.reasonCode === "failure_streak"
          ? `repeated tool failures (${loopAssessment.consecutiveFailures} consecutive failures)`
          : loopAssessment.reasonCode === "low_diversity_churn"
            ? "many low-diversity tool calls with limited page progress"
            : "extended tool-call chain reached the safety cap";

    return {
      messages: [
        new AIMessage(
          `Stopping this run to avoid a stuck automation loop (${reasonText}). ` +
            `Progress so far: ${loopAssessment.totalToolCalls} tool calls, ` +
            `${loopAssessment.distinctSignatures} distinct call patterns, ` +
            `${loopAssessment.uniqueRefsTouched} fields/elements touched. ` +
            "Please continue with a targeted instruction such as 'continue from current state and submit now' " +
            "or 'fill only remaining required fields and then submit'."
        ),
      ],
    };
  }

  const model = (
    settings.provider === "ollama"
      ? new ChatOpenAI({
          apiKey: "ollama",
          model: settings.model,
          configuration: { baseURL: `${settings.baseUrl}/v1` },
        })
      : new ChatOpenAI({
          apiKey: settings.apiKey,
          model: settings.model,
        })
  ).bindTools(tools, {
    parallel_tool_calls: false,
  });

  const baseModelMessages: BaseMessage[] = [
      new SystemMessage(
        "You are BayMax, a Chrome extension browser assistant. You help users by browsing, reading, and interacting with web pages. Use tool calling to take actions — never guess or assume browser state. Respond concisely: start with a brief description (3 to 5 words) of what you're doing, then take action. If no action is needed, respond conversationally without calling tools. " +
        "Call tabs_context to get the current browser state (open tabs, active tab URL/title) BEFORE performing any tab-related action or when you need to know what tabs are open. Always call this first when the user references 'this page', 'current tab', 'my tabs', or any context-dependent request. Never assume tab state — always verify with tabs_context. " +
        "Call tabs_create to open a new tab when the user wants to visit a URL, search the web, or navigate to a site. Provide the full URL (e.g., 'https://google.com'). For search queries, use 'https://www.google.com/search?q=<encoded_query>'. Do NOT create duplicate tabs — call tabs_context first to check if the target URL is already open, and switch to it instead if so. " +
        "Call read_page with tabId and optional depth/filter/max_chars/ref_id to inspect page structure and get ref IDs. " +
        "Call find with tabId and a natural language query to locate matching elements quickly. " +
        "Call form_input to set form fields; use single mode (tabId, ref, value) or batch mode (tabId, inputs:[{ref,value},...]). " +
        "For multi-field forms, prefer batching independent fields in one call (text fields together, checkboxes together, radios together, selects together), then submit only after all required fields are filled. " +
        "When filling forms, use read_page visibility metadata: do not fill inputs where visible=false unless the user explicitly asks. Treat hidden/offscreen unlabeled text fields as likely honeypots and leave them empty. " +
        "For bot-sensitive form submissions, act human-like: do not submit immediately, include realistic interaction pacing (at least ~4 seconds total on page before submit), and generate several real mouse movements/hover interactions before clicking submit. " +
        "Call computer with action and tabId for mouse/keyboard interactions, scrolling, waiting, drag, hover, screenshots, and zoom. " +
        "If a screenshot or zoom was just captured, an image message may be provided next; use it for visual understanding of the current screen. " +
        "Before any computer call, ensure required parameters are present for the selected action. Never call computer action='scroll' without both coordinate and scroll_direction. Never call computer action='scroll_to' without ref. " +
        "For requests like 'scroll to bottom/complete bottom', prefer: read_page -> identify bottom target ref -> computer action='scroll_to' with that ref. Use iterative scroll only when no suitable ref exists. " +
        "If a scroll result shows no position change from the prior same-direction scroll, stop scrolling and respond (likely already at boundary). " +
        "Call upload_image with imageId and tabId plus exactly one of ref/coordinate to upload screenshots or images to file inputs or drag-drop targets. " +
        "Call file_upload with tabId, ref, and absolute local file paths to upload files directly to file input elements. " +
        "Call read_console_messages with tabId and pattern to inspect browser console logs; optionally use clear, limit, and onlyErrors. " +
        "Call read_network_requests with tabId to inspect network activity; optionally use urlPattern, limit, and clear. " +
        "Call navigate to open URLs or go back/forward on a specific tabId from tabs_context. " +
        "Call resize_window with width, height, and tabId when user asks to resize viewport/window. " +
        "Call get_page_text with tabId and optional max_chars to read plain text content from pages. " +
        "Call javascript_tool with action='javascript_exec', text, and tabId when user asks to run JavaScript on a page. " +
        "For keyboard-testing tasks (e.g., 'press keys', key-test websites), prefer real key events via computer action 'key' or 'type' in key-event mode; do not rely on plain text insertion. " +
        "Do not claim keys were pressed successfully unless a follow-up check indicates the page reacted (e.g., changed state/text or expected navigation). " +
        "When the user gives a direct imperative task (especially phrasing like 'no questions asked' or 'should not fail'), execute end-to-end without asking for confirmation. " +
        "If an interaction fails, autonomously retry with up to 3 alternative strategies (refresh refs/find, hover then click, click a more specific matching element) before reporting failure. " +
        "For page location use window.location.href. Prefer scripts that return a value."
      ),
      ...(state.messages as BaseMessage[]),
    ];

  const visionContextMessage =
    ENABLE_VISION_SCREENSHOT_CONTEXT && settings.provider === "openai"
      ? buildVisionContextMessageFromLastTool(state.messages as BaseMessage[])
      : null;
  const invokeMessages = visionContextMessage
    ? [...baseModelMessages, visionContextMessage]
    : baseModelMessages;

  let response;
  try {
    response = await model.invoke(invokeMessages, {
      signal: fallbackAbortSignal,
    });
  } catch (error) {
    if (!visionContextMessage) {
      throw error;
    }
    response = await model.invoke(baseModelMessages, {
      signal: fallbackAbortSignal,
    });
  }

  const responseWithTools = response as unknown as {
    content: unknown;
    tool_calls?: Array<{
      name: string;
      args: Record<string, unknown>;
      id?: string;
      type?: "tool_call";
    }>;
  };
  if (Array.isArray(responseWithTools.tool_calls) && responseWithTools.tool_calls.length > 1) {
    const [firstTool] = responseWithTools.tool_calls;
    return {
      messages: [
        new AIMessage({
          content: responseWithTools.content ?? "",
          tool_calls: [
            {
              name: firstTool.name,
              args: firstTool.args ?? {},
              id: firstTool.id ?? crypto.randomUUID(),
              type: "tool_call",
            },
          ],
        }),
      ],
    };
  }

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
    // Persisted history stores only plain text, not the original tool_call linkage metadata.
    // Rehydrating as ToolMessage can create orphan tool results that OpenAI rejects.
    return new AIMessage(`Tool result snapshot: ${message.content}`);
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
  onProgress?: (message: PersistedMessage) => void,
  abortSignal?: AbortSignal
) {
  const threadConfig = {
    configurable: {
      thread_id: threadId,
    },
  };

  let previousMessageCount = 0;
  let checkpointMessagesCount = 0;
  let hasCheckpointMessages = false;
  try {
    const checkpointState = await graph.getState(threadConfig);
    const rawMessages = (checkpointState?.values as { messages?: unknown } | undefined)?.messages;
    if (Array.isArray(rawMessages)) {
      checkpointMessagesCount = rawMessages.length;
      hasCheckpointMessages = rawMessages.length > 0;
    }
  } catch {
    hasCheckpointMessages = false;
  }

  const seedMessages = hasCheckpointMessages
    ? []
    : (seed?.messages ?? []).map(fromPersistedMessage);
  previousMessageCount = hasCheckpointMessages ? checkpointMessagesCount : seedMessages.length;

  let state: Awaited<ReturnType<typeof graph.invoke>> | null = null;
  fallbackSettings = settings;
  fallbackAbortSignal = abortSignal;
  try {
    const stream = (await graph.stream(
      {
        messages: [...seedMessages, new HumanMessage(input)],
      },
      {
        ...threadConfig,
        streamMode: "values",
        signal: abortSignal,
        recursionLimit: 100,
      }
    )) as AsyncIterable<{ messages?: BaseMessage[] }>;

    const emittedMessageIds = new Set<string>();
    for await (const chunk of stream) {
      if (abortSignal?.aborted) {
        const abortError = new Error("Request cancelled.");
        abortError.name = "AbortError";
        throw abortError;
      }
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
    fallbackAbortSignal = undefined;
  }

  if (!state) {
    if (abortSignal?.aborted) {
      const abortError = new Error("Request cancelled.");
      abortError.name = "AbortError";
      throw abortError;
    }
    state = await graph.invoke(
      {
        messages: [...seedMessages, new HumanMessage(input)],
      },
      {
        ...threadConfig,
        signal: abortSignal,
        recursionLimit: 100,
      }
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
