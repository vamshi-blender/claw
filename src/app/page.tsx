import { Button } from "@/components/ui/button"
import { chatStore } from "@/server/storage/chat-store"

type PageProps = {
  searchParams?: Promise<{
    session?: string
  }>
}

function formatDate(value?: string) {
  if (!value) {
    return "No activity"
  }

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

export default async function Page({ searchParams }: PageProps) {
  const params = await searchParams
  const sessions = chatStore.listSessions()
  const selectedSessionId = params?.session ?? sessions[0]?.id
  const selectedSession = selectedSessionId
    ? chatStore.getSession(selectedSessionId)
    : null

  return (
    <main className="min-h-svh bg-background p-6">
      <div className="mx-auto grid w-full max-w-7xl gap-6 lg:grid-cols-[360px_1fr]">
        <section className="space-y-4">
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              Browser Agent Admin
            </p>
            <h1 className="text-3xl font-semibold tracking-normal">
              Session monitor
            </h1>
          </div>

          <div className="divide-y rounded-md border">
            {sessions.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                No sessions yet. Start a chat from the Chrome side panel.
              </div>
            ) : (
              sessions.map((session) => (
                <a
                  key={session.id}
                  href={`/?session=${session.id}`}
                  className="block p-4 text-sm hover:bg-muted/60"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-medium">{session.title}</span>
                    <span className="rounded-md border px-2 py-0.5 text-xs text-muted-foreground">
                      {session.status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatDate(session.lastMessageAt ?? session.updatedAt)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {session.messageCount} messages
                    {session.lastRun ? ` - run ${session.lastRun.status}` : ""}
                  </p>
                </a>
              ))
            )}
          </div>
        </section>

        <section className="min-h-[640px] rounded-md border">
          {selectedSession ? (
            <div className="flex h-full flex-col">
              <header className="border-b p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-xl font-semibold tracking-normal">
                      {selectedSession.title}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {selectedSession.id}
                    </p>
                  </div>
                  <Button variant="outline" size="sm">
                    {selectedSession.status}
                  </Button>
                </div>
                {selectedSession.error ? (
                  <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                    {selectedSession.error}
                  </p>
                ) : null}
              </header>

              <div className="flex-1 space-y-4 overflow-auto p-4">
                {selectedSession.messages.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    This session has no messages yet.
                  </p>
                ) : (
                  selectedSession.messages.map((message) => (
                    <article
                      key={message.id}
                      className="rounded-md border p-3 text-sm"
                    >
                      <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                        <span className="font-medium uppercase">
                          {message.role}
                        </span>
                        <time>{formatDate(message.createdAt)}</time>
                      </div>
                      <p className="whitespace-pre-wrap leading-6">
                        {message.content}
                      </p>
                    </article>
                  ))
                )}
              </div>

              <footer className="border-t p-4 text-xs text-muted-foreground">
                Runs: {selectedSession.runs.length}
                {selectedSession.runs.at(-1)
                  ? ` - latest ${selectedSession.runs.at(-1)?.status}`
                  : ""}
              </footer>
            </div>
          ) : (
            <div className="flex h-full min-h-[640px] items-center justify-center p-6 text-sm text-muted-foreground">
              Select a session to inspect conversation history and run status.
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
