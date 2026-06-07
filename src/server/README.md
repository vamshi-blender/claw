# Server Foundation

This folder contains the first backend agent foundation:

- `agents/` defines the single OpenAI Agents SDK assistant.
- `storage/` owns session, message, and run records.
- `http/` holds shared API response helpers.

The current store uses the Agents SDK `MemorySession` plus an in-process record
store. That is enough for local development and one running server process, but
it is not production persistence. Before deploying real user traffic, replace
`storage/chat-store.ts` with a durable Vercel-compatible database-backed store
and a persistent Agents SDK `Session` implementation.
