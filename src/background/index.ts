import { runGraphTurn, type LlmSettings, type PersistedThreadState } from "./graph";

type RunGraphRequest = {
  type: "RUN_GRAPH";
  threadId: string;
  input: string;
  requestId?: string;
};

type CancelGraphRequest = {
  type: "CANCEL_GRAPH";
  requestId: string;
};

type GraphRequest = RunGraphRequest | CancelGraphRequest;

const THREAD_PREFIX = "thread:";
const activeRuns = new Map<string, AbortController>();

function keyForThread(threadId: string) {
  return `${THREAD_PREFIX}${threadId}`;
}

async function loadThreadState(threadId: string): Promise<PersistedThreadState | undefined> {
  const key = keyForThread(threadId);
  const result = await chrome.storage.local.get(key);
  return result[key] as PersistedThreadState | undefined;
}

async function saveThreadState(threadId: string, state: PersistedThreadState) {
  const key = keyForThread(threadId);
  await chrome.storage.local.set({ [key]: state });
}

async function loadLlmSettings(): Promise<LlmSettings | undefined> {
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

async function ensureClawTabGroup(tab: chrome.tabs.Tab) {
  if (!tab.id || (typeof tab.groupId === "number" && tab.groupId >= 0)) {
    return;
  }

  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(groupId, { title: "🔥Claw", color: "yellow" });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) {
    return;
  }

  await Promise.allSettled([chrome.sidePanel.open({ tabId: tab.id }), ensureClawTabGroup(tab)]);
});

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const lowered = error.message.toLowerCase();
  return error.name === "AbortError" || lowered.includes("aborted") || lowered.includes("cancel");
}

chrome.runtime.onMessage.addListener((message: GraphRequest, _sender, sendResponse) => {
  if (message.type === "CANCEL_GRAPH") {
    const controller = activeRuns.get(message.requestId);
    if (controller) {
      controller.abort();
      activeRuns.delete(message.requestId);
      sendResponse({ ok: true, cancelled: true });
      return;
    }
    sendResponse({ ok: true, cancelled: false });
    return;
  }

  if (message.type !== "RUN_GRAPH") {
    return;
  }

  (async () => {
    let controller: AbortController | undefined;
    try {
      const llmSettings = await loadLlmSettings();
      if (!llmSettings) {
        sendResponse({ ok: false, error: "Open Options and configure a provider + model first." });
        return;
      }

      if (message.requestId) {
        controller = new AbortController();
        activeRuns.set(message.requestId, controller);
      }

      const seed = await loadThreadState(message.threadId);
      const result = await runGraphTurn(
        message.threadId,
        message.input,
        llmSettings,
        seed,
        (progressMessage) => {
          if (!message.requestId) {
            return;
          }
          void chrome.runtime
            .sendMessage({
              type: "RUN_GRAPH_PROGRESS",
              requestId: message.requestId,
              threadId: message.threadId,
              message: progressMessage,
            })
            .catch(() => {
              // Ignore if there is no active sidepanel listener.
            });
        },
        controller?.signal
      );
      await saveThreadState(message.threadId, result.state);
      sendResponse({ ok: true, ...result });
    } catch (error) {
      if (isAbortError(error)) {
        sendResponse({ ok: false, cancelled: true, error: "Request cancelled." });
        return;
      }
      sendResponse({ ok: false, error: (error as Error).message });
    } finally {
      if (message.requestId) {
        activeRuns.delete(message.requestId);
      }
    }
  })();

  return true;
});
