# Browser Agent

Single-package browser-agent app with:

- Next.js App Router frontend in `src/app`
- Next.js API/backend routes in `src/app/api`
- OpenAI Agents SDK server logic in `src/server`
- Chrome extension side panel source in `extension`

This step implements a stateful streaming chatbot with one OpenAI Agent and no
tools. Browser automation tools, authentication, durable production storage, and
multi-agent routing are intentionally not implemented yet.

## Commands

```bash
pnpm dev
pnpm start
pnpm build
pnpm build:extension
pnpm dev:extension
pnpm lint
pnpm typecheck
```

## Environment

Create `.env.local` from `.env.example`:

```bash
OPENAI_API_KEY=sk-your-openai-api-key
OPENAI_AGENT_MODEL=gpt-5.5
```

The OpenAI API key is used only by Next.js backend routes. Do not put it in the
Chrome extension.

## Backend Routes

- `GET /api/health`
- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/:sessionId`
- `POST /api/sessions/:sessionId/messages`

`POST /api/sessions/:sessionId/messages` streams plain text chunks as the agent
generates the assistant response.

## Admin

The root route `/` is the basic admin monitor. It lists recent sessions, status,
last activity, conversation messages, and latest run state.

## Chrome Extension

Extension source lives in `extension/src` and static manifest assets live in
`extension/public`. The extension uses Manifest V3 and Chrome Side Panel API.

Build output is written to `extension/dist`. Load that folder in Chrome
Developer Mode.

The extension options page stores the backend URL in Chrome storage. It offers a
production option for `https://claw-mocha.vercel.app` and a development option
that enables a custom backend URL field. The side panel uses the saved URL to
create/resume a chat session and stream assistant responses from the backend.

## Storage

The current session store uses the Agents SDK `MemorySession` and an in-process
development store for session, message, and run records. Replace
`src/server/storage/chat-store.ts` with durable Vercel-compatible storage before
production use.
