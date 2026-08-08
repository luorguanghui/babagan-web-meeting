import { Component, type ReactNode } from 'react';

import { ApiRequestError } from '../api/client.js';

interface ErrorBoundaryProps { children: ReactNode; }
interface ErrorBoundaryState { error?: Error; }

export class MeetingErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): ErrorBoundaryState { return { error }; }
  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const correlationId = error instanceof ApiRequestError ? error.details?.error.correlationId : undefined;
    return <main className="shell"><section className="panel" role="alert" aria-live="assertive">
      <h1>Something went wrong</h1><p>Please return to the meeting link and try again.</p>
      {correlationId && <p>Support ID: {correlationId}</p>}
    </section></main>;
  }
}
