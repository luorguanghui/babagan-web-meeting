import { describe, expect, it, vi } from 'vitest';
import { createScreenShareController } from './screen-share.js';
import { captureNativeScreen, type openNativeVideoTrack } from './native-capture.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function source(withAudio = false) {
  const makeTrack = (kind: string) => {
    const track = Object.assign(new EventTarget(), { kind, readyState: 'live',
      stop: vi.fn(() => { track.readyState = 'ended'; }), applyConstraints: vi.fn(async () => {}),
      getSettings: () => ({ displaySurface: 'monitor', deviceId: 'screen:0:0', width: 1920, height: 1080 }) });
    return track;
  };
  const video = makeTrack('video'), audio = withAudio ? makeTrack('audio') : undefined;
  const tracks = [video, ...(audio ? [audio] : [])] as unknown as MediaStreamTrack[];
  const stream = { getTracks: () => tracks, getVideoTracks: () => tracks.filter(t => t.kind === 'video'),
    getAudioTracks: () => tracks.filter(t => t.kind === 'audio'), removeTrack: (track: MediaStreamTrack) => tracks.splice(tracks.indexOf(track), 1),
    addTrack: (track: MediaStreamTrack) => tracks.push(track) } as unknown as MediaStream;
  return { video, audio, stream };
}

function controllerFor(getDisplayMedia: (constraints: DisplayMediaStreamOptions, signal?: AbortSignal) => Promise<MediaStream>,
  extra: Partial<Parameters<typeof createScreenShareController>[0]> = {}) {
  const releaseGrant = vi.fn(async () => {}), publish = vi.fn(async () => {}), release = vi.fn(async () => {});
  const controller = createScreenShareController({ requestGrant: async () => {}, releaseGrant, getDisplayMedia,
    publisher: { publish, release }, ...extra });
  return { controller, releaseGrant, publish, release };
}

describe('capture startup cancellation', () => {
  it('settles startup without waiting for the picker and stops a late selected stream', async () => {
    const picker = deferred<MediaStream>(); const selected = source(true);
    const capture = vi.fn<(options: DisplayMediaStreamOptions, signal?: AbortSignal) => Promise<MediaStream>>(() => picker.promise);
    const h = controllerFor(capture); let settled = false;
    const starting = h.controller.start().then(() => { settled = true; });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    await h.controller.stop();
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(capture.mock.calls[0][1]?.aborted).toBe(true);
    expect(h.releaseGrant).toHaveBeenCalledOnce();
    picker.resolve(selected.stream); await starting;
    await vi.waitFor(() => expect(selected.video.stop).toHaveBeenCalledOnce());
    expect(selected.audio?.stop).toHaveBeenCalledOnce(); expect(h.publish).not.toHaveBeenCalled();
  });

  it.each(['stop', 'ended'] as const)('owns tracks and closes the pending audio choice on %s', async action => {
    const selected = source(true); const audioChoice = deferred<'share-audio'>();
    const choose = vi.fn(() => audioChoice.promise), cancelPendingCapture = vi.fn();
    const h = controllerFor(async () => selected.stream, { supportsOwnAudioRestriction: () => false,
      chooseUnrestrictedSystemAudio: choose, cancelPendingCapture });
    let settled = false; const starting = h.controller.start().then(() => { settled = true; });
    await vi.waitFor(() => expect(choose).toHaveBeenCalledOnce());
    if (action === 'stop') void h.controller.stop(); else selected.video.dispatchEvent(new Event('ended'));
    expect(selected.video.stop).toHaveBeenCalledOnce(); expect(selected.audio?.stop).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(cancelPendingCapture).toHaveBeenCalledOnce(); expect(h.releaseGrant).toHaveBeenCalledOnce();
    expect(h.publish).not.toHaveBeenCalled(); expect(h.controller.getState().status).toBe('idle');
    audioChoice.resolve('share-audio'); await starting;
    expect(h.publish).not.toHaveBeenCalled(); expect(selected.video.stop).toHaveBeenCalledOnce();
  });

  it('never publishes a source that ends while video constraints are pending', async () => {
    const selected = source(); const constraints = deferred<void>();
    selected.video.applyConstraints.mockImplementation(() => constraints.promise);
    const h = controllerFor(async () => selected.stream); let settled = false;
    const starting = h.controller.start().then(() => { settled = true; });
    await vi.waitFor(() => expect(selected.video.applyConstraints).toHaveBeenCalledOnce());
    selected.video.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(settled).toBe(true));
    constraints.resolve(); await starting;
    expect(h.publish).not.toHaveBeenCalled(); expect(h.releaseGrant).toHaveBeenCalledOnce();
  });

  it('rejects an already ended selected video before publishing', async () => {
    const selected = source(); selected.video.readyState = 'ended'; const h = controllerFor(async () => selected.stream);
    await expect(h.controller.start()).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.publish).not.toHaveBeenCalled(); expect(h.releaseGrant).toHaveBeenCalledOnce();
  });

  it('keeps stop responsive while a late grant and its release block the next start', async () => {
    const grant = deferred<void>(), released = deferred<void>(); const selected = source();
    const requestGrant = vi.fn().mockImplementationOnce(() => grant.promise).mockResolvedValue(undefined);
    const releaseGrant = vi.fn().mockImplementationOnce(() => released.promise).mockResolvedValue(undefined);
    const capture = vi.fn(async () => selected.stream); const h = controllerFor(capture, { requestGrant, releaseGrant });
    const first = h.controller.start(); await h.controller.stop();
    const next = h.controller.start(); await Promise.resolve();
    expect(requestGrant).toHaveBeenCalledOnce();
    grant.resolve(); await vi.waitFor(() => expect(releaseGrant).toHaveBeenCalledOnce());
    expect(requestGrant).toHaveBeenCalledOnce(); expect(capture).not.toHaveBeenCalled();
    released.resolve(); await Promise.all([first, next]);
    expect(h.controller.getState()).toMatchObject({ status: 'sharing', stream: selected.stream });
    await h.controller.stop();
  });

  it('keeps repeated stops waiting for the same active publication release', async () => {
    const release = deferred<void>(); const selected = source();
    const h = controllerFor(async () => selected.stream, { publisher: { publish: async () => {}, release: () => release.promise } });
    await h.controller.start(); const first = h.controller.stop(); let secondSettled = false;
    const second = h.controller.stop().then(() => { secondSettled = true; });
    await Promise.resolve(); expect(secondSettled).toBe(false);
    release.resolve(); await Promise.all([first, second]); expect(selected.video.stop).toHaveBeenCalledOnce();
  });

  it('releases a failed publication once when stop overlaps its cleanup', async () => {
    const released = deferred<void>(), selected = source();
    const release = vi.fn(() => released.promise), releaseGrant = vi.fn(async () => {});
    const h = controllerFor(async () => selected.stream, { releaseGrant,
      publisher: { publish: async () => { throw new Error('publication failed'); }, release } });
    const starting = h.controller.start().catch(error => error);
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    const stopped = h.controller.stop(); released.resolve(); await Promise.all([starting, stopped]);
    expect(release).toHaveBeenCalledOnce(); expect(releaseGrant).toHaveBeenCalledOnce();
    expect(selected.video.stop).toHaveBeenCalledOnce(); expect(h.controller.getState().status).toBe('idle');
  });

  it('cancels a queued restart when stop is called again before the old grant settles', async () => {
    const grant = deferred<void>(); const capture = vi.fn(async () => source().stream);
    const requestGrant = vi.fn().mockImplementationOnce(() => grant.promise).mockResolvedValue(undefined);
    const h = controllerFor(capture, { requestGrant });
    const first = h.controller.start(); await h.controller.stop();
    const restart = h.controller.start(); await h.controller.stop();
    grant.resolve(); await Promise.all([first, restart]);
    expect(requestGrant).toHaveBeenCalledOnce(); expect(capture).not.toHaveBeenCalled();
  });

  it('serializes cleanup if a state subscriber stops startup synchronously', async () => {
    const grant = deferred<void>(), released = deferred<void>();
    const requestGrant = vi.fn().mockImplementationOnce(() => grant.promise).mockResolvedValue(undefined);
    const releaseGrant = vi.fn().mockImplementationOnce(() => released.promise).mockResolvedValue(undefined);
    const capture = vi.fn(async () => source().stream); const h = controllerFor(capture, { requestGrant, releaseGrant });
    let cancelled = false;
    h.controller.subscribe(state => { if (state.status === 'starting' && !cancelled) { cancelled = true; void h.controller.stop(); } });
    const first = h.controller.start(), restart = h.controller.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(capture).not.toHaveBeenCalled();
    grant.resolve(); released.resolve(); await Promise.all([first, restart]);
    expect(capture).toHaveBeenCalledOnce(); await h.controller.stop();
  });
});

describe('native capture cancellation', () => {
  const connection = { port: 25191, token: 'a'.repeat(43) };

  it('never starts the helper when a cancelled picker resolves late', async () => {
    const selected = source(true), picker = deferred<MediaStream>(), abort = new AbortController(); const open = vi.fn();
    let settled = false;
    const pending = captureNativeScreen(connection, { video: true }, { capture: () => picker.promise, open, signal: abort.signal })
      .catch(error => { settled = true; return error; });
    abort.abort(); await vi.waitFor(() => expect(settled).toBe(true));
    picker.resolve(selected.stream);
    await vi.waitFor(() => expect(selected.video.stop).toHaveBeenCalledOnce());
    expect(await pending).toMatchObject({ name: 'AbortError' }); expect(open).not.toHaveBeenCalled();
    expect(selected.audio?.stop).toHaveBeenCalledOnce();
  });

  it('aborts native first-frame startup and releases the selected stream on stop', async () => {
    const selected = source(true), firstFrame = deferred<MediaStreamTrack>(), abort = new AbortController();
    const open = vi.fn<typeof openNativeVideoTrack>(() => firstFrame.promise);
    let settled = false;
    const pending = captureNativeScreen(connection, { video: true }, { capture: async () => selected.stream, open, signal: abort.signal })
      .catch(error => { settled = true; return error; });
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce()); abort.abort();
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(open.mock.calls[0][2]?.signal?.aborted).toBe(true);
    expect(selected.video.stop).toHaveBeenCalledOnce(); expect(selected.audio?.stop).toHaveBeenCalledOnce();
    const lateNative = source(); firstFrame.resolve(lateNative.video as unknown as MediaStreamTrack);
    await vi.waitFor(() => expect(lateNative.video.stop).toHaveBeenCalledOnce());
    expect(await pending).toMatchObject({ name: 'AbortError' });
  });
});
