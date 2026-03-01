const providerSelect = document.querySelector<HTMLSelectElement>("#provider");
const modelInput = document.querySelector<HTMLInputElement>("#model");
const apiKeyInput = document.querySelector<HTMLInputElement>("#apiKey");
const apiKeyLabel = document.querySelector<HTMLLabelElement>("#apiKeyLabel");
const baseUrlInput = document.querySelector<HTMLInputElement>("#baseUrl");
const baseUrlLabel = document.querySelector<HTMLLabelElement>("#baseUrlLabel");
const testRow = document.querySelector<HTMLDivElement>("#testRow");
const testBtn = document.querySelector<HTMLButtonElement>("#testBtn");
const testStatus = document.querySelector<HTMLSpanElement>("#testStatus");
const saveButton = document.querySelector<HTMLButtonElement>("#saveBtn");
const statusOutput = document.querySelector<HTMLPreElement>("#status");

if (
  !providerSelect || !modelInput || !apiKeyInput || !apiKeyLabel ||
  !baseUrlInput || !baseUrlLabel || !testRow || !testBtn || !testStatus ||
  !saveButton || !statusOutput
) {
  throw new Error("Options UI is missing required elements.");
}

type LlmSettings =
  | { provider: "openai"; model: string; apiKey: string }
  | { provider: "ollama"; model: string; baseUrl: string };

function applyProviderUI(provider: string) {
  if (provider === "ollama") {
    apiKeyLabel.style.display = "none";
    baseUrlLabel.style.display = "";
    testRow.style.display = "";
  } else {
    apiKeyLabel.style.display = "";
    baseUrlLabel.style.display = "none";
    testRow.style.display = "none";
  }
}

providerSelect.addEventListener("change", () => {
  applyProviderUI(providerSelect.value);
  if (providerSelect.value === "ollama" && !modelInput.value) {
    modelInput.value = "gpt-oss:20b-cloud";
  }
});

testBtn.addEventListener("click", async () => {
  const baseUrl = baseUrlInput.value.trim() || "http://localhost:11434";
  testStatus.textContent = "Testing…";
  try {
    const res = await fetch(`${baseUrl}/api/tags`);
    if (res.ok) {
      const data = await res.json() as { models?: { name: string }[] };
      const count = data.models?.length ?? 0;
      testStatus.textContent = `Connected — ${count} model(s) available.`;
    } else {
      testStatus.textContent = `Error: HTTP ${res.status}`;
    }
  } catch {
    testStatus.textContent = "Failed to reach Ollama. Is it running? Check OLLAMA_ORIGINS env var.";
  }
});

async function loadSettings() {
  const result = await chrome.storage.local.get("llmSettings");
  const settings = result.llmSettings as LlmSettings | undefined;

  if (!settings) {
    providerSelect.value = "ollama";
    modelInput.value = "gpt-oss:20b-cloud";
    baseUrlInput.value = "http://localhost:11434";
    applyProviderUI("ollama");
    return;
  }

  providerSelect.value = settings.provider;
  modelInput.value = settings.model;

  if (settings.provider === "openai") {
    apiKeyInput.value = settings.apiKey;
  } else if (settings.provider === "ollama") {
    baseUrlInput.value = settings.baseUrl;
  }

  applyProviderUI(settings.provider);
}

async function saveSettings() {
  const provider = providerSelect.value;
  const model = modelInput.value.trim();

  if (!model) {
    statusOutput.textContent = "Model name is required.";
    return;
  }

  let settings: LlmSettings;

  if (provider === "openai") {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      statusOutput.textContent = "API key is required for OpenAI.";
      return;
    }
    settings = { provider: "openai", model, apiKey };
  } else {
    const baseUrl = baseUrlInput.value.trim() || "http://localhost:11434";
    settings = { provider: "ollama", model, baseUrl };
  }

  await chrome.storage.local.set({ llmSettings: settings });
  statusOutput.textContent = "Saved.";
}

saveButton.addEventListener("click", () => {
  void saveSettings();
});

void loadSettings();
