export default function Page() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-2xl space-y-4">
        <p className="text-sm font-medium text-muted-foreground">
          Browser Agent Foundation
        </p>
        <h1 className="text-3xl font-semibold tracking-normal">
          Next.js app ready for frontend, backend routes, and extension
          connectivity.
        </h1>
        <p className="max-w-xl text-sm leading-6 text-muted-foreground">
          This project currently includes a minimal admin placeholder, a health
          API route, and a Chrome extension shell for configuring the backend
          URL.
        </p>
      </div>
    </main>
  )
}
