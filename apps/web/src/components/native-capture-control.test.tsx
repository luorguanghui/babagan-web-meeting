import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MeetingSettings } from './meeting-controls.js';
import { LanguageProvider } from '../i18n/i18n.js';
afterEach(cleanup);
it('offers a native primary-screen choice only when the local launcher supplied a capability, and locks it while sharing', () => {
  const change = vi.fn();
  const props = { connection: 'connected' as const, microphoneEnabled: false, audioPlaybackBlocked: false, devices: [], leaving: false,
    onMicrophoneToggle: vi.fn(), onMicrophoneDeviceChange: vi.fn(), onSpeakerDeviceChange: vi.fn(), onResumeAudio: vi.fn(), onLeave: vi.fn(),
    nativeCaptureAvailable: true, nativeCaptureEnabled: true, onNativeCaptureChange: change };
  const view = render(<LanguageProvider><MeetingSettings {...props} section="share" /></LanguageProvider>);
  const choice = screen.getByRole('combobox', { name: 'Screen capture' });
  expect(choice).toHaveValue('native'); fireEvent.change(choice, { target: { value: 'browser' } }); expect(change).toHaveBeenCalledWith(false);
  view.rerender(<LanguageProvider><MeetingSettings {...props} screenShareActive section="share" /></LanguageProvider>);
  expect(choice).toBeDisabled();
  view.rerender(<LanguageProvider><MeetingSettings {...props} nativeCaptureAvailable={false} section="share" /></LanguageProvider>);
  expect(screen.queryByRole('combobox', { name: 'Screen capture' })).not.toBeInTheDocument();
});
it('keeps manual diagnostic export available after sharing stops and reports download failure', async () => {
  const onExport = vi.fn(async () => { throw new Error('download unavailable'); });
  render(<LanguageProvider><MeetingSettings connection="connected" microphoneEnabled={false} audioPlaybackBlocked={false} devices={[]} leaving={false}
    onMicrophoneToggle={vi.fn()} onMicrophoneDeviceChange={vi.fn()} onSpeakerDeviceChange={vi.fn()} onResumeAudio={vi.fn()} onLeave={vi.fn()}
    nativeCaptureAvailable onExportNativeDiagnostics={onExport} section="share" /></LanguageProvider>);
  const button = screen.getByRole('button', { name: 'Export last native share diagnostic' });
  expect(button).not.toBeDisabled(); fireEvent.click(button);
  expect(onExport).toHaveBeenCalledOnce(); expect(await screen.findByRole('status')).toHaveTextContent('Could not download');
});
