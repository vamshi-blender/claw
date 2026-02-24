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
  const threadId = threadInput.value.trim() || "default-thread";
  const input = promptInput.value.trim();

  if (!input) {
    return;
  }

  setPendingUserMessage(input);
  runButton.disabled = true;
  const requestId = crypto.randomUUID();
  activeRequestId = requestId;

  const response = (await chrome.runtime.sendMessage({
    type: "RUN_GRAPH",
    requestId,
    threadId,
    input,
  })) as GraphResponse;

  if (!response.ok) {
    appendAssistantBubble(`Error: ${response.error ?? "Unknown error"}`);
    runButton.disabled = false;
    activeRequestId = null;
    return;
  }

  renderMessages(response.state?.messages ?? []);
  memoryOutput.textContent = JSON.stringify(response.state, null, 2);
  runButton.disabled = false;
  promptInput.value = "";
  promptInput.style.height = "40px";
  activeRequestId = null;
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
