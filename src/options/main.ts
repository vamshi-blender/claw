const modelInput = document.querySelector<HTMLInputElement>("#model");
const apiKeyInput = document.querySelector<HTMLInputElement>("#apiKey");
const saveButton = document.querySelector<HTMLButtonElement>("#saveBtn");
const statusOutput = document.querySelector<HTMLPreElement>("#status");

if (!modelInput || !apiKeyInput || !saveButton || !statusOutput) {
  throw new Error("Options UI is missing required elements.");
}

type LlmSettings = {
  provider: "openai";
  model: string;
  apiKey: string;
};

async function loadSettings() {
  const result = await chrome.storage.local.get("llmSettings");
  const settings = result.llmSettings as LlmSettings | undefined;

  if (!settings) {
    modelInput.value = "gpt-4.1-mini";
    return;
  }

  modelInput.value = settings.model || "gpt-4.1-mini";
  apiKeyInput.value = settings.apiKey || "";
}

async function saveSettings() {
  const model = modelInput.value.trim();
  const apiKey = apiKeyInput.value.trim();

  if (!apiKey) {
    statusOutput.textContent = "API key is required.";
    return;
  }

  const settings: LlmSettings = {
    provider: "openai",
    model,
    apiKey,
  };

  await chrome.storage.local.set({ llmSettings: settings });
  statusOutput.textContent = "Saved.";
}

saveButton.addEventListener("click", () => {
  void saveSettings();
});

void loadSettings();
