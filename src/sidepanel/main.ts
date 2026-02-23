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

const threadInput = document.querySelector<HTMLInputElement>("#threadId");
const promptInput = document.querySelector<HTMLTextAreaElement>("#prompt");
const runButton = document.querySelector<HTMLButtonElement>("#runBtn");
const optionsButton = document.querySelector<HTMLButtonElement>("#optionsBtn");
const newThreadButton = document.querySelector<HTMLButtonElement>("#newThreadBtn");
const latestOutput = document.querySelector<HTMLPreElement>("#latest");
const memoryOutput = document.querySelector<HTMLPreElement>("#memory");

if (!threadInput || !promptInput || !runButton || !optionsButton || !newThreadButton || !latestOutput || !memoryOutput) {
  throw new Error("Side panel UI is missing required elements.");
}

async function runGraph() {
  const threadId = threadInput.value.trim() || "default-thread";
  const input = promptInput.value.trim();

  if (!input) {
    latestOutput.textContent = "Enter input first.";
    return;
  }

  latestOutput.textContent = "Running...";

  const response = (await chrome.runtime.sendMessage({
    type: "RUN_GRAPH",
    threadId,
    input,
  })) as GraphResponse;

  if (!response.ok) {
    latestOutput.textContent = `Error: ${response.error ?? "Unknown error"}`;
    return;
  }

  latestOutput.textContent = response.response ?? "No response";
  memoryOutput.textContent = JSON.stringify(response.state, null, 2);
}

runButton.addEventListener("click", () => {
  void runGraph();
});

optionsButton.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

newThreadButton.addEventListener("click", () => {
  threadInput.value = crypto.randomUUID();
  latestOutput.textContent = "";
  memoryOutput.textContent = "";
});
