import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ApiRequestError } from './api/client.js';
import { ConnectionBanner } from './components/connection-banner.js';
import { MeetingErrorBoundary } from './components/error-boundary.js';
import { MeetingControls } from './components/meeting-controls.js';

describe('meeting accessibility', () => {
  it('announces the connection state with text rather than color alone', () => {
    render(<ConnectionBanner state={{ kind: 'reconnecting', since: 1 }} online={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('You are offline');
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting');
  });

  it('explains rate-limit recovery in the polite connection announcement', () => {
    render(<ConnectionBanner state={{ kind: 'reconnecting', since: 1 }} online={true} rateLimited />);
    expect(screen.getByText(/service is busy/i)).toHaveAttribute('role', 'status');
  });

  it('exposes all meeting controls through semantic labels', () => {
    render(<MeetingControls
      connection="connected" microphoneEnabled={false} audioPlaybackBlocked={false} devices={[]}
      leaving={false} screenShareAuthorized={true}
      onMicrophoneToggle={() => undefined} onMicrophoneDeviceChange={() => undefined}
      onSpeakerDeviceChange={() => undefined} onResumeAudio={() => undefined}
      onLeave={() => undefined} onScreenShareToggle={() => undefined}
    />);
    expect(screen.getByRole('button', { name: 'Unmute microphone' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Share screen' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Leave meeting' })).toBeEnabled();
    expect(screen.getByLabelText('Microphone device')).toBeInTheDocument();
    expect(screen.getByLabelText('Speaker device')).toBeInTheDocument();
  });

  it('shows the API correlation ID when an unexpected rendered error reaches the boundary', () => {
    const Broken = () => { throw new ApiRequestError('Unavailable', 503, { error: { code: 'MEDIA_SERVICE_UNAVAILABLE', message: 'Unavailable', correlationId: 'corr-123' } }); };
    render(<MeetingErrorBoundary><Broken /></MeetingErrorBoundary>);
    expect(screen.getByRole('alert')).toHaveTextContent('Support ID: corr-123');
  });
});
