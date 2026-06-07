# Architecture and Implementation Plan

## Summary

Rebuild the project as a single Next.js/Vercel application plus a separately built Chrome extension in the same repository. The active LangGraph/LangChain architecture should be removed entirely and archived only for reference.

The new backend should use the official `openai` npm SDK with the Responses API as the core model and tool-calling primitive. The application backend should own the higher-level orchestration loop, client-side tool queue, confirmations, persistence, and resume behavior.

Key decisions:

- Use Next.js App Router for the admin frontend and backend API routes.
- Use Neon Postgres via the Vercel Marketplace for durable sessions, runs, tool calls, events, errors, and admin history.
- Use Drizzle ORM for database schema and typed queries.
- Use shared-token auth for v1: one admin password/session cookie and one extension install token.
- Do not use persistent WebSockets for v1. Use Vercel-compatible HTTP streaming plus resumable run endpoints.
- Keep browser-only tools in the Chrome extension. The backend coordinates tool calls but does not execute browser APIs.
- Store `OPENAI_API_KEY` only on the backend. The extension must never receive or store it.

Important correction: Vercel Postgres as a first-party standalone service is no longer available for new projects. Existing Vercel Postgres databases were migrated to Neon in December 2024. For this rebuild, use Neon Postgres through the Vercel Marketplace instead of `@vercel/postgres`.

Official references:

- Responses API: https://developers.openai.com/api/reference/responses/overview
- Function/tool calling: https://developers.openai.com/api/docs/guides/function-calling
- Streaming Responses: https://developers.openai.com/api/docs/guides/streaming-responses
- Conversation state: https://developers.openai.com/api/docs/guides/conversation-state
- Responses migration guidance: https://developers.openai.com/api/docs/guides/migrate-to-responses
- Postgres on Vercel / Neon migration: https://vercel.com/docs/postgres
- Neon on Vercel Marketplace: https://vercel.com/changelog/neon-now-available-on-vercel-marketplace

## Proposed Architecture

The repository should become a simple monorepo-style Next.js project:

```text
src/
  app/
    page.tsx
    admin/
      page.tsx
      sessions/[sessionId]/page.tsx
    api/
      auth/
      extension/
      sessions/
      runs/
      admin/
  server/
    agent/
      run-loop.ts
      openai-client.ts
      prompts.ts
      tool-router.ts
      confirmations.ts
    db/
      schema.ts
      client.ts
      queries.ts
    auth/
      admin-auth.ts
      extension-auth.ts
  lib/
    validation.ts
    ids.ts
    errors.ts
  types/
    protocol.ts
    tools.ts
    runs.ts

extension/
  src/
    background/
    sidepanel/
    options/
    tools/
  public/
    manifest.json
  build.mjs
  dist/

old-code/
  README.md
  tools.md
  package.old.json
  scripts/
  public/
  src/
```

Backend responsibilities:

- Own all OpenAI SDK calls using `openai.responses.create`.
- Maintain sessions, runs, messages, response IDs, tool calls, events, errors, and confirmations in Neon Postgres.
- Build the available tool list from registered extension capabilities plus server-side tools.
- Execute server-side tools directly.
- Pause when the model requests an extension-side tool, stream a `tool.requested` event, and wait for the extension to return the result.
- Resume the Responses API loop with `function_call_output` tied to the original `call_id`.
- Require confirmation before sensitive actions such as navigation, form submit, file upload, JavaScript execution, and destructive actions.
- Expose admin APIs for sessions, runs, tool calls, errors, and configuration.

Chrome extension responsibilities:

- Store `backendUrl` and extension install token in `chrome.storage.local`.
- Register itself with the backend on startup.
- Register available client-side tools and permissions.
- Start/resume runs through backend API calls.
- Execute browser-only tools locally using Chrome APIs, content scripts, and debugger APIs where needed.
- Return tool results to the backend.
- Show user-facing run status, streamed text, pending tool calls, errors, and confirmation prompts.
- Build separately into `extension/dist`, loadable through Chrome Extensions Developer Mode.

Admin frontend responsibilities:

- Show a simple dashboard for active/recent sessions.
- Show session detail pages with messages, run status, tool calls/results, errors, and confirmation history.
- Show basic settings/configuration values from environment or database.
- Keep UI practical and functional; avoid polish-heavy work in v1.

## Communication Protocol

Use a resumable, Vercel-compatible protocol.

Do not use WebSockets for v1. WebSockets are a poor default here because Vercel serverless functions are not designed for long-lived bidirectional browser-agent control. The simpler reliable pattern is stepwise HTTP streaming plus explicit resume endpoints.

Flow:

1. Extension sends a user message to `POST /api/runs`.
2. Backend streams Server-Sent Events until one of these happens:
   - final assistant output completes
   - model requests an extension-side tool
   - confirmation is required
   - run fails or is cancelled
3. If a client tool is requested, the stream ends with `run.waiting_for_tool`.
4. Extension executes the tool locally.
5. Extension posts the result to `POST /api/runs/:runId/tool-results`.
6. Backend resumes the OpenAI Responses loop and streams the next step.
7. Repeat until completion.

Core API endpoints:

- `POST /api/auth/admin/login`
- `POST /api/extension/register`
- `POST /api/extension/tools`
- `POST /api/sessions`
- `GET /api/sessions/:sessionId`
- `POST /api/runs`
- `GET /api/runs/:runId`
- `POST /api/runs/:runId/tool-results`
- `POST /api/runs/:runId/confirmations`
- `POST /api/runs/:runId/cancel`
- `GET /api/admin/sessions`
- `GET /api/admin/runs/:runId`
- `GET /api/admin/errors`

Shared event types in `src/types/protocol.ts`:

- `extension.registered`
- `tools.registered`
- `run.started`
- `model.text.delta`
- `model.output.completed`
- `tool.requested`
- `tool.result.received`
- `confirmation.required`
- `run.waiting_for_tool`
- `run.completed`
- `run.failed`
- `run.cancelled`

Tool definition shape in `src/types/tools.ts`:

```ts
type ToolRuntime = "server" | "extension";

type ToolDefinition = {
  name: string;
  description: string;
  runtime: ToolRuntime;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  requiredPermissions: string[];
  requiresConfirmation: boolean;
  timeoutMs: number;
  maxRetries: number;
};
```

Initial extension-side tools:

- `tabs_context`
- `tabs_create`
- `navigate`
- `read_page`
- `find`
- `form_input`
- `computer`
- `get_page_text`
- `javascript_exec`
- `read_console_messages`
- `read_network_requests`
- `file_upload`
- `upload_image`

The backend should only expose tools that are both known in the shared registry and reported as available by the registered extension instance.

## Agent Lifecycle

Use the Responses API directly through the official `openai` npm package.

Run loop behavior:

- Send stable `instructions` on every Responses call.
- Use `previous_response_id` for continuity.
- Store every OpenAI `response.id` in Postgres.
- Store app-level events and messages in Postgres for admin visibility.
- Use `parallel_tool_calls: false` in v1 to keep extension execution simple and predictable.
- Use strict JSON schemas for function tools.
- Convert model function calls into internal `tool_call` records.
- If `runtime === "server"`, execute immediately and continue the loop.
- If `runtime === "extension"`, pause and return a tool request to the extension.
- If confirmation is required, pause before tool execution and wait for user approval.
- On tool result, resume with a `function_call_output` item containing the original `call_id`.
- On tool failure, retry according to `maxRetries`; then return a structured failure result to the model.
- Stop loops after a configured max step count, such as 20 model/tool steps per run.

Structured outputs:

- Use tool input/output schemas for tool execution.
- Use a small structured run-summary schema for admin records when a run completes or fails.
- Do not force every user-facing assistant message into JSON; stream natural text normally.

## Old Code Migration

Move useful old files into `old-code` for reference only:

- `src/background/graph.ts`: browser tool logic reference.
- `src/background/index.ts`: extension message-handling reference.
- `src/sidepanel/*`: rough UI reference only.
- `src/options/*`: backend URL/settings UI reference only.
- `public/manifest.json`: permissions/reference manifest.
- `scripts/build.mjs`: extension build reference.
- `tools.md`: tool documentation reference, but stale.
- `README.md`, `test.html`, old `package.json`, old lockfile, and old `tsconfig.json`: archive for context.

Discard from active architecture:

- LangGraph `StateGraph`
- LangGraph `MemorySaver`
- LangChain `tool`
- LangChain message abstractions
- `@langchain/*` dependencies
- in-extension OpenAI/Ollama model execution
- storing OpenAI API keys in extension storage
- old thread state model
- stale `tools.md` claims for non-existent tools like `gif_creator` and `update_plan`

## Implementation Phases

1. Planning/documentation phase
   - Create `ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md`.
   - Do not migrate or rebuild yet.

2. Project foundation
   - Replace active package setup with Next.js, React, TypeScript, `openai`, `zod`, Drizzle, and Neon database dependencies.
   - Add scripts: `dev`, `build`, `start`, `lint`, `typecheck`, `build:extension`, `dev:extension`, `db:generate`, `db:migrate`.
   - Add `.env.example` with `OPENAI_API_KEY`, `DATABASE_URL`, `ADMIN_PASSWORD`, `EXTENSION_INSTALL_TOKEN`, and default model.

3. Old-code archive
   - Move current implementation into `old-code`.
   - Remove LangGraph/LangChain dependencies from active package files.
   - Keep old code unimported.

4. Backend foundation
   - Add Postgres schema for clients, sessions, runs, messages, tool definitions, tool calls, events, confirmations, and errors.
   - Add admin auth and extension token auth.
   - Add OpenAI Responses client wrapper.
   - Add run-loop orchestration with resumable tool execution.

5. Extension foundation
   - Add MV3 extension structure under `extension`.
   - Add settings/options page for backend URL and extension token.
   - Add side panel chat/status UI.
   - Add background service worker for API calls, stream handling, tool execution, and cancellation.
   - Add separate build script outputting `extension/dist`.

6. Tool migration
   - Port browser tool logic from old `graph.ts` into modular extension tools.
   - Define shared tool metadata and schemas.
   - Add confirmation gates for risky tools.
   - Add timeouts and structured error results.

7. Admin dashboard
   - Add basic sessions list.
   - Add run detail view.
   - Add tool call/error/event inspection.
   - Add basic configuration visibility.

8. Verification
   - Typecheck app and extension.
   - Build Next.js app.
   - Build extension and verify `extension/dist/manifest.json` is loadable.
   - Test local backend URL connection.
   - Test production backend URL connection.
   - Test one full browser-agent run with at least one client-side tool call.

## Test Plan

Core tests:

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run build:extension`

Manual scenarios:

- Admin login works with shared password.
- Extension saves local backend URL and production backend URL.
- Extension registers with valid token and fails with invalid token.
- User starts a run from the extension and receives streamed text.
- Model requests `tabs_context`; extension executes it and backend resumes.
- Model requests `read_page` then `form_input`; tool results appear in admin.
- Confirmation is required before `javascript_exec`, file upload, and form submission.
- Cancellation stops an active run.
- Admin can inspect recent sessions, tool calls, errors, and run status.
- No OpenAI API key is stored in extension storage or sent to the extension.

## Future Usage

Local development:

```bash
npm install
cp .env.example .env.local
npm run dev
```

Extension development:

```bash
npm run build:extension
```

Then load `extension/dist` in Chrome Extensions Developer Mode.

Backend URL setup:

- For local dev, set the extension backend URL to `http://localhost:3000`.
- For production, set it to the Vercel deployment URL, for example `https://your-app.vercel.app`.
- The selected backend URL is saved in extension storage.

Vercel deployment:

- Deploy the Next.js app normally to Vercel.
- Install Neon Postgres from the Vercel Marketplace and connect it to the project.
- Configure `OPENAI_API_KEY`, `DATABASE_URL`, `ADMIN_PASSWORD`, and `EXTENSION_INSTALL_TOKEN` in Vercel environment variables.
- Run database migrations.
- Build the extension separately and distribute/load `extension/dist`.

## Risks and Open Questions

Risks:

- Browser automation through Chrome extension APIs is permission-sensitive and can be brittle across websites.
- Serverless time limits mean long autonomous runs must be split into resumable steps.
- Tool schemas can become large; keep initial available tools controlled for better model accuracy and lower token cost.
- Admin history requires durable Postgres storage; in-memory storage is not acceptable for production.
- File upload and debugger-based tools need careful permission handling and user confirmation.

Resolved decisions:

- Auth model: shared admin password plus extension install token.
- Storage: Neon Postgres via Vercel Marketplace.
- Transport: stepwise HTTP streaming/resume, not WebSockets.
- OpenAI integration: official `openai` npm SDK with Responses API as the core model/tool-calling primitive; app-owned orchestration for extension tool execution.
- Old architecture: archive only, no active LangGraph/LangChain code.
