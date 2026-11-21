import { useId, type ReactNode } from 'react';

export function TaskPageLayout({
  eyebrow,
  title,
  lede,
  context,
  contextLabel,
  icon,
  surfaceTitle,
  after,
  children,
  className
}: {
  eyebrow: string;
  title: string;
  lede: string;
  context?: ReactNode;
  contextLabel?: string;
  icon?: ReactNode;
  surfaceTitle?: string;
  after?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  const Context = contextLabel ? 'section' : 'aside';
  return <main className={className ? `task-page-shell ${className}` : 'task-page-shell'}>
    <section className="task-page" aria-labelledby={headingId}>
      <Context className="task-context" aria-label={contextLabel ?? `${title} context`}>
        {icon && <span className="task-context-icon" aria-hidden="true">{icon}</span>}
        <p className="eyebrow">{eyebrow}</p>
        <h1 id={headingId}>{title}</h1>
        <p className="lede">{lede}</p>
        {context}
      </Context>
      <section className="task-surface" aria-label={surfaceTitle ?? title}>
        {surfaceTitle && <h2 className="task-surface-title">{surfaceTitle}</h2>}
        {children}
      </section>
    </section>
    {after}
  </main>;
}
