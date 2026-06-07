import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
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

          <Card size="sm" className="gap-0 py-0">
            {sessions.length === 0 ? (
              <CardContent className="p-4 text-sm text-muted-foreground">
                No sessions yet. Start a chat from the Chrome side panel.
              </CardContent>
            ) : (
              sessions.map((session) => (
                <Button
                  key={session.id}
                  asChild
                  variant="ghost"
                  className="h-auto justify-start rounded-none px-4 py-3 first:rounded-t-xl last:rounded-b-xl"
                >
                  <a href={`/?session=${session.id}`}>
                    <span className="grid min-w-0 flex-1 gap-1 text-left">
                      <span className="flex items-center justify-between gap-3">
                        <span className="truncate font-medium">
                          {session.title}
                        </span>
                        <Badge variant="outline">{session.status}</Badge>
                      </span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {formatDate(session.lastMessageAt ?? session.updatedAt)}
                      </span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {session.messageCount} messages
                        {session.lastRun
                          ? ` - run ${session.lastRun.status}`
                          : ""}
                      </span>
                    </span>
                  </a>
                </Button>
              ))
            )}
          </Card>
        </section>

        <Card className="min-h-[640px] gap-0 py-0">
          {selectedSession ? (
            <div className="flex h-full flex-col">
              <CardHeader className="border-b p-4">
                <CardTitle className="text-xl">
                  {selectedSession.title}
                </CardTitle>
                <CardDescription>{selectedSession.id}</CardDescription>
                <CardAction>
                  <Badge variant="outline">{selectedSession.status}</Badge>
                </CardAction>
                {selectedSession.error ? (
                  <>
                    <Separator className="my-2" />
                    <Badge variant="destructive" className="h-auto py-1">
                      {selectedSession.error}
                    </Badge>
                  </>
                ) : null}
              </CardHeader>

              <CardContent className="flex-1 space-y-4 overflow-auto p-4">
                {selectedSession.messages.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    This session has no messages yet.
                  </p>
                ) : (
                  selectedSession.messages.map((message) => (
                    <Card key={message.id} size="sm" className="gap-2 p-3">
                      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                        <Badge variant="outline">{message.role}</Badge>
                        <time>{formatDate(message.createdAt)}</time>
                      </div>
                      <p className="whitespace-pre-wrap leading-6">
                        {message.content}
                      </p>
                    </Card>
                  ))
                )}
              </CardContent>

              <CardFooter className="text-xs text-muted-foreground">
                Runs: {selectedSession.runs.length}
                {selectedSession.runs.at(-1)
                  ? ` - latest ${selectedSession.runs.at(-1)?.status}`
                  : ""}
              </CardFooter>
            </div>
          ) : (
            <div className="flex h-full min-h-[640px] items-center justify-center p-6 text-sm text-muted-foreground">
              Select a session to inspect conversation history and run status.
            </div>
          )}
        </Card>
      </div>
    </main>
  )
}
