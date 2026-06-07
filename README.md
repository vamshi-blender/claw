# Browser Agent Foundation

Single-package project foundation for a browser-agent app with:

- Next.js App Router frontend in `src/app`
- Next.js API/backend routes in `src/app/api`
- future server logic folders in `src/server`
- Chrome extension source in `extension`

This foundation intentionally does not implement the OpenAI SDK agent, tool
calling loop, database, authentication, real browser tools, or production admin
monitoring features yet.

## Commands

```bash
pnpm dev
pnpm build
pnpm build:extension
pnpm lint
pnpm typecheck
```

## Backend Health Check

The minimal backend connectivity route is available at:

- `GET /api/health`

It returns:

```json
{ "ok": true, "service": "backend" }
```

## Chrome Extension

Extension source lives in `extension/src` and static manifest assets live in
`extension/public`.

Build output is written to `extension/dist`.
