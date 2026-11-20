const principles = ['Private by default', 'Model agnostic', 'Vietnamese ready'];

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col justify-between px-6 py-10 sm:px-10">
      <nav className="flex items-center justify-between border-b border-white/10 pb-5">
        <span className="text-sm font-semibold tracking-[0.22em] text-emerald-300">
          MM RESEARCH
        </span>
        <span className="rounded-full border border-emerald-300/30 px-3 py-1 text-xs text-emerald-100">
          Foundation 2.1
        </span>
      </nav>
      <section className="py-24 sm:py-32">
        <p className="mb-6 text-sm font-medium uppercase tracking-[0.3em] text-emerald-300">
          Enterprise intelligence, under your control
        </p>
        <h1 className="max-w-4xl text-5xl font-semibold leading-tight tracking-tight sm:text-7xl">
          AI infrastructure built for private, high-stakes work.
        </h1>
        <p className="mt-8 max-w-2xl text-lg leading-8 text-slate-300">
          MM AI Platform is the self-hosted foundation for secure legal, financial, and research
          workflows—designed to keep enterprise knowledge inside private infrastructure.
        </p>
        <div className="mt-12 flex flex-wrap gap-3">
          {principles.map((principle) => (
            <span
              className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm text-slate-200"
              key={principle}
            >
              {principle}
            </span>
          ))}
        </div>
      </section>
      <footer className="border-t border-white/10 pt-5 text-sm text-slate-400">
        Local-first architecture · No external AI inference
      </footer>
    </main>
  );
}
