# LangGraph CDP Chrome Extension (Minimal)

Minimal MV3 Chrome extension that uses LangGraph in the background service worker as the orchestration "brain".

## What this demonstrates

- Stateful orchestration with `StateGraph`
- OpenAI or Ollama chatbot responses (`ChatOpenAI` / Ollama-compatible endpoint) for non-tool prompts
- Tool calling with a mock CDP tool
- Explicit state fields (`input`, `response`, `turn`, `messages`, `pendingToolCall`, `lastToolResult`)
- Memory via:
  - LangGraph `MemorySaver` checkpointer (thread-level state while worker instance is alive)
  - `chrome.storage.local` persistence (survives service-worker restarts)
- Side panel UI -> background messaging -> graph invocation loop
- Options page for selecting provider (OpenAI or Ollama), model, and credentials

## Architecture

- `sidepanel.html` + `sidepanel.js`:
  - UI for input/thread id
  - Sends `RUN_GRAPH` messages to background worker
- `options.html` + `options.js`:
  - Saves provider (`openai` or `ollama`), `model`, and credentials into `chrome.storage.local` as `llmSettings`
  - For Ollama: saves `baseUrl` (default `http://localhost:11434`) instead of an API key
  - Includes a **Test Connection** button (Ollama only) to verify Ollama is reachable before saving
- `background.js` (service worker):
  - Hosts LangGraph app
  - Loads/saves thread memory in `chrome.storage.local`
  - Loads `llmSettings` and injects model credentials per run
  - Invokes graph with thread-aware config (`thread_id`)
- `graph.ts`:
  - Defines state schema with `Annotation.Root`
  - Planner node routes to either tool node or response node
  - Mock tool (`mock_cdp_action`) is designed to be replaced by real CDP tools

## CDP integration path

Replace the mock tool implementation in `src/background/graph.ts` with real actions (likely through `chrome.debugger` in MV3 background worker), and add permission updates in `manifest.json` as needed.

## Tradeoffs

- Running LangGraph in-extension is feasible and implemented here.
- LangGraph currently imports `node:async_hooks`; browser bundling required a lightweight shim (`src/shims/async_hooks.ts`).
- MV3 service workers are ephemeral, so in-memory checkpointers alone are not durable; this project persists thread snapshots in `chrome.storage.local`.
- For production with provider API keys and heavy model/tool workloads, a hybrid architecture (extension UI + backend LangGraph runtime) is usually safer and easier to scale.

## Local setup

1. Install dependencies:
   - `npm install`
2. Build extension assets:
   - `npm run build`
3. In Chrome, open `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked** and select the repo `dist` folder.
6. Click the extension action icon to open the side panel.
7. Open extension options and configure your provider + model (see below).

## Provider configuration

### OpenAI
1. Open extension options.
2. Select **OpenAI** from the Provider dropdown.
3. Enter your model name (e.g. `gpt-4.1-mini-2025-04-14`).
4. Enter your OpenAI API key (`sk-...`).
5. Click **Save Settings**.

### Ollama (local)
Ollama is the default provider on first launch, with model `gpt-oss:20b-cloud`.

**One-time setup — allow cross-origin requests from the extension:**

Set the `OLLAMA_ORIGINS` environment variable to `*` in your system environment variables, then restart Ollama. Without this, Ollama will reject requests coming from the `chrome-extension://` origin.

> On Windows: open *System Properties → Environment Variables*, add a new User variable:
> - Name: `OLLAMA_ORIGINS`
> - Value: `*`
>
> Then restart the Ollama app/service.

**In extension options:**
1. Select **Ollama (local)** from the Provider dropdown.
2. Enter your model name (e.g. `gpt-oss:20b-cloud`, `qwen3.5:cloud`, `ministral-3:3b`).
3. Set Base URL (default: `http://localhost:11434`).
4. Click **Test Connection** to verify Ollama is reachable and CORS is configured correctly.
5. Click **Save Settings**.

> **Note:** Not all Ollama models support tool/function calling. Models confirmed to work:
> - `gpt-oss:20b-cloud` ✓
> - `qwen3.5:cloud` ✓
> - `ministral-3:3b` ✗ (no tool calling — will not work with this extension)

## Quick test

- Input: `hello`
  - Expected: OpenAI chatbot response
- Input: `/cdp click #login-button`
  - Expected: mock tool route and tool result text
- Input: `/runjs document.title`
  - Expected: executes on active tab and returns script result
- Reuse the same thread id to observe accumulated memory state in the panel.

## Folder structure

```text
public/
  manifest.json
scripts/
  build.mjs
src/
  background/
    graph.ts
    index.ts
  shims/
    async_hooks.ts
  options/
    index.html
    main.ts
  sidepanel/
    index.html
    main.ts
    styles.css
dist/ (generated)
package.json
tsconfig.json
```
