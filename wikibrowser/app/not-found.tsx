import Link from "next/link";

export default function NotFoundPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <section className="max-w-xl rounded-2xl border border-line bg-paper p-8 shadow-sm">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">404</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-ink">Page not found</h1>
        <p className="mt-4 text-sm leading-6 text-muted">
          Open a wiki browser route with <code>/&lt;database-id&gt;/Wiki</code>, or return to the start page.
        </p>
        <div className="mt-6 flex flex-wrap gap-2 text-sm">
          <Link className="rounded-2xl bg-action px-3 py-2 font-bold text-white no-underline hover:bg-accent" href="/">
            Open start page
          </Link>
          <span className="rounded-lg border border-line bg-white px-3 py-2 font-mono text-xs text-muted">
            /&lt;database-id&gt;/Wiki
          </span>
        </div>
      </section>
    </main>
  );
}
