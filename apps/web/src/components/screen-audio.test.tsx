import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ScreenAudio } from './screen-audio.js';

class FakeStream extends EventTarget {
  constructor(public tracks: MediaStreamTrack[] = []) { super(); }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
}
afterEach(() => { cleanup();vi.restoreAllMocks();vi.unstubAllGlobals(); });

it('plays an audio-only stream continuously across visibility changes and updates late audio tracks', async () => {
  vi.stubGlobal('MediaStream', FakeStream);
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  const videoTrack = { kind:'video', stop:vi.fn() } as unknown as MediaStreamTrack;
  const audioTrack = { kind:'audio', stop:vi.fn() } as unknown as MediaStreamTrack;
  const stream = new FakeStream([videoTrack]);
  const view = render(<ScreenAudio stream={stream as unknown as MediaStream} muted={false} volume={0.4} />);
  const audio=view.container.querySelector('audio')!;
  expect(audio.srcObject).toBeFalsy();
  await act(async()=>{stream.tracks.push(audioTrack);stream.dispatchEvent(new Event('addtrack'));});
  expect((audio.srcObject as unknown as FakeStream).tracks).toEqual([audioTrack]);
  expect(audio.volume).toBe(0.4);
  const attached = audio.srcObject;
  vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');
  fireEvent(document,new Event('visibilitychange'));
  expect(audio.srcObject).toBe(attached);
  expect(audio.muted).toBe(false);
  expect(play).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(audio.srcObject).toBeNull();
  expect(audioTrack.stop).not.toHaveBeenCalled();
});

it('never attaches the local preview audio and offers user-gesture recovery after autoplay rejection', async()=>{
  const play=vi.spyOn(HTMLMediaElement.prototype,'play').mockRejectedValue(new DOMException('blocked','NotAllowedError'));
  const track={attach:vi.fn(e=>e),detach:vi.fn(e=>e)};
  const view=render(<ScreenAudio track={track} muted volume={1} />);
  expect(track.attach).not.toHaveBeenCalled();
  view.rerender(<ScreenAudio track={track} muted={false} volume={1} />);
  await act(async()=>{});
  expect(view.getByRole('button',{name:'Click to resume audio'})).toBeVisible();
  play.mockResolvedValue();
  await act(async()=>window.dispatchEvent(new Event('babagan-resume-media')));
  expect(view.queryByRole('button')).toBeNull();
});
