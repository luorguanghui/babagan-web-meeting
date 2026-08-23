import { useId, type ReactNode } from 'react';

export function TaskPageLayout({
  eyebrow,
  title,
  lede,
  context,
  children
}: {
  eyebrow: string;
  title: string;
  lede: string;
  context?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return <main className="task-page-shell">
    <section className="task-page" aria-labelledby={headingId}>
      <aside className="task-context" aria-label={`${title} context`}>
        <p className="eyebrow">{eyebrow}</p>
        <h1 id={headingId}>{title}</h1>
        <p className="lede">{lede}</p>
        {context}
      </aside>
      <section className="task-surface" aria-label={title}>{children}</section>
    </section>
  </main>;
}
