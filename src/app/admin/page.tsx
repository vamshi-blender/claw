export default function AdminPage() {
  return (
    <main className="min-h-svh p-6">
      <section className="mx-auto flex w-full max-w-5xl flex-col gap-4 py-10">
        <p className="text-sm font-medium text-muted-foreground">Admin</p>
        <h1 className="text-3xl font-semibold tracking-normal">
          Future admin dashboard
        </h1>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          This area is reserved for monitoring sessions, agent runs, connected
          extensions, tool calls, errors, and backend activity.
        </p>
      </section>
    </main>
  )
}
