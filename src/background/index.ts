import { runGraphTurn, type LlmSettings, type PersistedThreadState } from "./graph";

type RunGraphRequest = {
  type: "RUN_GRAPH";
  threadId: string;
  input: string;
};

const THREAD_PREFIX = "thread:";

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
  if (!settings || settings.provider !== "openai") {
    return undefined;
  }
  if (!settings.apiKey || !settings.model) {
    return undefined;
  }
  return settings;
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

chrome.runtime.onMessage.addListener((message: RunGraphRequest, _sender, sendResponse) => {
  if (message.type !== "RUN_GRAPH") {
    return;
  }

  (async () => {
    try {
      const llmSettings = await loadLlmSettings();
      if (!llmSettings) {
        sendResponse({ ok: false, error: "Open Options and save OpenAI API key + model first." });
        return;
      }

      const seed = await loadThreadState(message.threadId);
      const result = await runGraphTurn(message.threadId, message.input, llmSettings, seed);
      await saveThreadState(message.threadId, result.state);
      sendResponse({ ok: true, ...result });
    } catch (error) {
      sendResponse({ ok: false, error: (error as Error).message });
    }
  })();

  return true;
});
