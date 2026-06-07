Implemented the first OpenAI Agents SDK tool pass.

Reviewed official docs:
- OpenAI tools + Agents SDK usage: https://developers.openai.com/api/docs/guides/tools
- Function/tool calling, schemas, streaming: https://developers.openai.com/api/docs/guides/function-calling
- Agent definitions: https://developers.openai.com/api/docs/guides/agents/define-agents
- Running agents, sessions, streaming loop: https://developers.openai.com/api/docs/guides/agents/running-agents

What changed:
- Added SDK function tools in `src/server/tools/browser-tools.ts`.
- Updated the agent to create a session/run-bound tool-enabled agent.
- Added extension bridge routes under `src/app/api/extension/...`.
- Added tool-call logging and extension connection state to `chatStore`.
- Updated side panel to lock to the current Chrome window, poll tool requests, execute Chrome/browser actions, and stream tool status.
- Updated admin page to show extension window status and recent tool activity.
- Added extension permissions: `tabs`, `scripting`.

Tools now exposed:
`tabs_context`, `tabs_create`, `navigate`, `resize_window`, `get_page_text`, `read_page`, `find`, `form_input`, `computer`, `upload_image`, `file_upload`, `read_console_messages`, `read_network_requests`, `javascript_tool`, `turn_answer_start`.

Execution split:
- Backend: OpenAI agent, tool schemas, tool-call queueing/logging, streaming events.
- Extension: browser/window/tab/DOM/page actions.
- `turn_answer_start`: backend no-op compatibility signal.

Important caveat: `file_upload`, full `upload_image`, drag, zoom-crop, and live console capture are graceful foundation implementations, not complete production automation yet. They return explicit tool results instead of crashing.

Validation passed:
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`
- `pnpm build:extension`

Extension build passed with the existing non-fatal Vite `"use client"` warnings from shadcn/Radix modules.

How to test:
1. Run/reuse the Next dev server.
2. Run `pnpm build:extension`.
3. Reload `extension/dist` in Chrome Developer Mode.
4. Open the side panel in a Chrome window.
5. Ask things like: “list my tabs”, “read the current page”, “find the search input”, or “navigate this tab to example.com”.
6. Open `/` admin page to see tool activity for the session.