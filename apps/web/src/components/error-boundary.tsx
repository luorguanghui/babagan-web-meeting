import { Component, type ReactNode } from 'react';

import { ApiRequestError } from '../api/client.js';
import { type Translate, useI18n } from '../i18n/i18n.js';

interface ErrorBoundaryProps { children: ReactNode; t: Translate; }
interface ErrorBoundaryState { error?: Error; }

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {};
  static getDerivedStateFromError(error: Error): ErrorBoundaryState { return { error }; }
  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const correlationId = error instanceof ApiRequestError ? error.details?.error.correlationId : undefined;
    return <main className="shell"><section className="panel" role="alert" aria-live="assertive">
      <h1>{this.props.t('error.heading')}</h1><p>{this.props.t('error.retry')}</p>
      {correlationId && <p>{this.props.t('error.supportId', { id: correlationId })}</p>}
    </section></main>;
  }
}

export function MeetingErrorBoundary({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return <ErrorBoundary t={t}>{children}</ErrorBoundary>;
}
