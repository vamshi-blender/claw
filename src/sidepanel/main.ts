type GraphResponse = {
  ok: boolean;
  response?: string;
  state?: {
    turn: number;
    messages: Array<{
      role: "user" | "assistant" | "tool";
      content: string;
    }>;
    lastToolResult: string | null;
  };
  cancelled?: boolean;
  error?: string;
};

type ChatMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
};

type GraphProgressMessage = {
  type: "RUN_GRAPH_PROGRESS";
  requestId: string;
  threadId: string;
  message: ChatMessage;
};

const threadInput = document.querySelector<HTMLInputElement>("#threadId");
const promptInput = document.querySelector<HTMLTextAreaElement>("#prompt");
const runButton = document.querySelector<HTMLButtonElement>("#runBtn");
const optionsButton = document.querySelector<HTMLButtonElement>("#optionsBtn");
const memoryToggleButton = document.querySelector<HTMLButtonElement>("#memoryToggleBtn");
const debugPanel = document.querySelector<HTMLElement>("#debugPanel");
const newThreadButton = document.querySelector<HTMLButtonElement>("#newThreadBtn");
const messagesOutput = document.querySelector<HTMLElement>("#messages");
const memoryOutput = document.querySelector<HTMLPreElement>("#memory");

if (
  !threadInput ||
  !promptInput ||
  !runButton ||
  !optionsButton ||
  !memoryToggleButton ||
  !debugPanel ||
  !newThreadButton ||
  !messagesOutput ||
  !memoryOutput
) {
  throw new Error("Side panel UI is missing required elements.");
}

let activeRequestId: string | null = null;

function setRunState(isRunning: boolean) {
  runButton.disabled = false;
  runButton.textContent = isRunning ? "Stop" : "Send";
}

function setDebugPanelVisible(visible: boolean) {
  debugPanel.classList.toggle("hidden", !visible);
  debugPanel.setAttribute("aria-hidden", String(!visible));
  memoryToggleButton.setAttribute("aria-pressed", String(visible));
  memoryToggleButton.title = visible ? "Hide thread memory" : "Show thread memory";
}

function appendAssistantBubble(content: string, isToolCall = false) {
  const bubble = document.createElement("div");
  bubble.className = `message assistant${isToolCall ? " tool-call" : ""}`;
  bubble.textContent = content;
  messagesOutput.appendChild(bubble);
  messagesOutput.scrollTop = messagesOutput.scrollHeight;
}

function renderMessages(messages: ChatMessage[]) {
  messagesOutput.textContent = "";

  if (messages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "message system";
    empty.textContent = "Start a new conversation.";
    messagesOutput.appendChild(empty);
    return;
  }

  for (const message of messages) {
    if (message.role === "tool") {
      continue;
    }
    const bubble = document.createElement("div");
    bubble.className = `message ${message.role}`;
    bubble.textContent = message.content;
    messagesOutput.appendChild(bubble);
  }

  messagesOutput.scrollTop = messagesOutput.scrollHeight;
}

function setPendingUserMessage(input: string) {
  const existing = Array.from(messagesOutput.querySelectorAll(".message.pending"));
  for (const node of existing) {
    node.remove();
  }

  const bubble = document.createElement("div");
  bubble.className = "message user pending";
  bubble.textContent = input;
  messagesOutput.appendChild(bubble);
  messagesOutput.scrollTop = messagesOutput.scrollHeight;
}

async function runGraph() {
  if (activeRequestId) {
    await stopGraph();
    return;
  }

  let threadId = threadInput.value.trim();
  if (!threadId) {
    threadId = crypto.randomUUID();
    threadInput.value = threadId;
  }
  const input = promptInput.value.trim();

  if (!input) {
    return;
  }

  setPendingUserMessage(input);
  const requestId = crypto.randomUUID();
  activeRequestId = requestId;
  setRunState(true);
  promptInput.value = "";
  promptInput.style.height = "40px";

  try {
    const response = (await chrome.runtime.sendMessage({
      type: "RUN_GRAPH",
      requestId,
      threadId,
      input,
    })) as GraphResponse;

    if (activeRequestId !== requestId) {
      return;
    }

    if (!response.ok) {
      if (!response.cancelled) {
        appendAssistantBubble(`Error: ${response.error ?? "Unknown error"}`);
      }
      activeRequestId = null;
      setRunState(false);
      return;
    }

    renderMessages(response.state?.messages ?? []);
    memoryOutput.textContent = JSON.stringify(response.state, null, 2);
    activeRequestId = null;
    setRunState(false);
  } catch (error) {
    if (activeRequestId === requestId) {
      appendAssistantBubble(`Error: ${(error as Error).message ?? "Failed to send request"}`);
      activeRequestId = null;
      setRunState(false);
    }
  }
}

async function stopGraph() {
  if (!activeRequestId) {
    return;
  }
  const requestId = activeRequestId;
  runButton.disabled = true;
  runButton.textContent = "Stopping...";
  try {
    await chrome.runtime.sendMessage({
      type: "CANCEL_GRAPH",
      requestId,
    });
  } catch {
    // Ignore if background page is not reachable momentarily.
  } finally {
    runButton.disabled = false;
    if (activeRequestId === requestId) {
      runButton.textContent = "Stop";
    }
  }
}

runButton.addEventListener("click", () => {
  void runGraph();
});

promptInput.addEventListener("input", () => {
  promptInput.style.height = "40px";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 140)}px`;
});

promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void runGraph();
  }
});

optionsButton.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message: GraphProgressMessage) => {
  if (message.type !== "RUN_GRAPH_PROGRESS") {
    return;
  }
  if (!activeRequestId || message.requestId !== activeRequestId) {
    return;
  }
  if (message.message.role !== "assistant" || !message.message.content.trim()) {
    return;
  }

  const isToolCall = message.message.content.startsWith("Calling tool:");
  appendAssistantBubble(message.message.content, isToolCall);
});

memoryToggleButton.addEventListener("click", () => {
  const isHidden = debugPanel.classList.contains("hidden");
  setDebugPanelVisible(isHidden);
});

newThreadButton.addEventListener("click", () => {
  threadInput.value = crypto.randomUUID();
  renderMessages([]);
  memoryOutput.textContent = "";
});

setDebugPanelVisible(false);
renderMessages([]);
threadInput.value = crypto.randomUUID();
setRunState(false);
