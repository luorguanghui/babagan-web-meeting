import type { ScreenMoqPublication } from '@meeting/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiRequestError } from '../api/client.js';
import { createScreenMoqApi } from './screen-moq-api.js';
import { MoqScreenPublisher, type MoqMediaSession } from './screen-moq.js';
import { supportsMoqPublisher, supportsMoqSubscriber } from './screen-moq-support.js';
import type { ScreenSharePublishOptions } from './screen-share.js';

type ViewerError = 'unsupported' | 'connection';
const pollMs = 2_500;

export function useScreenMoq(slug: string, identity: string, enabled: boolean) {
  const api = useMemo(() => createScreenMoqApi(slug), [slug]);
  const publisher = useRef<MoqScreenPublisher | undefined>(undefined);
  const closingPublisher = useRef<Promise<void> | undefined>(undefined);
  const [available, setAvailable] = useState(false);
  const [publication, setPublication] = useState<ScreenMoqPublication | null>(null);
  const [source, setSource] = useState<{ shareId: string; stream: MediaStream }>();
  const viewerMedia = useRef<MoqMediaSession | undefined>(undefined);
  const [viewerError, setViewerError] = useState<ViewerError>();
  const [publisherFailed, setPublisherFailed] = useState(false);
  const [publisherRecovering, setPublisherRecovering] = useState(false);

  const stop = useCallback(() => {
    const prior = publisher.current;
    if (!prior) return closingPublisher.current ?? Promise.resolve();
    publisher.current = undefined;
    setPublisherRecovering(false);
    const closing = prior.close().finally(() => {
      if (closingPublisher.current === closing) closingPublisher.current = undefined;
    });
    closingPublisher.current = closing;
    return closing;
  }, []);

  useEffect(() => {
    if (enabled) return () => { void stop(); };
  }, [enabled, stop]);

  useEffect(() => {
    setAvailable(false);
    setPublication(null);
    if (!enabled) return;
    const lifetime = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await api.status(lifetime.signal);
        if (lifetime.signal.aborted) return;
        setAvailable(next.available);
        setPublication(prior => prior?.shareId === next.publication?.shareId ? prior : next.publication);
        if (!next.available) return;
      } catch (error) {
        if (lifetime.signal.aborted || (error instanceof ApiRequestError && [401, 403, 404, 410].includes(error.status))) {
          if (!lifetime.signal.aborted) {
            setAvailable(false);
            setPublication(null);
          }
          return;
        }
      }
      timer = setTimeout(() => { void refresh(); }, pollMs);
    };
    void refresh();
    return () => { lifetime.abort(); clearTimeout(timer); };
  }, [api, enabled]);

  const remote = enabled && publication?.sharerIdentity !== identity ? publication : null;
  const shareId = remote?.shareId;
  useEffect(() => {
    setSource(undefined);
    setViewerError(undefined);
    if (!shareId) return;
    if (!supportsMoqSubscriber()) {
      setViewerError('unsupported');
      return;
    }

    const lifetime = new AbortController();
    const signal = lifetime.signal;
    let media: MoqMediaSession | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let retryMs = 2_000;
    const closeMedia = () => {
      if (viewerMedia.current === media) viewerMedia.current = undefined;
      media?.close();
      media = undefined;
    };
    const connect = async () => {
      const loaded = await import('./screen-moq-media.js');
      const connection = await api.subscribe(shareId, signal);
      const session = await loaded.openMoqSubscriber(connection, signal);
      if (signal.aborted) { session.close(); return; }
      media = session;
      viewerMedia.current = session;
      retryMs = 2_000;
      setSource({ shareId, stream: session.stream });
      setViewerError(undefined);
      await session.closed;
      if (!signal.aborted) throw new Error('The MoQ subscriber disconnected.');
    };
    const subscribe = () => {
      void connect().catch(error => {
        if (signal.aborted) return;
        closeMedia();
        setSource(undefined);
        setViewerError('connection');
        if (error instanceof ApiRequestError && [401, 403, 404, 410].includes(error.status)) return;
        timer = setTimeout(subscribe, retryMs);
        retryMs = Math.min(retryMs * 2, 15_000);
      });
    };
    subscribe();
    return () => {
      lifetime.abort();
      clearTimeout(timer);
      closeMedia();
    };
  }, [api, shareId]);

  const publish = useCallback(async (stream: MediaStream, options: ScreenSharePublishOptions) => {
    setPublisherFailed(false);
    let lastRecoveryAt = -Infinity;
    const createPublisher = (): MoqScreenPublisher => {
      const owner = new MoqScreenPublisher(api, async (connection, source, configuration, signal) => {
        const { openMoqPublisher } = await import('./screen-moq-media.js');
        signal.throwIfAborted();
        return openMoqPublisher(connection, source, configuration, signal);
      }, () => { void recover(owner); });
      return owner;
    };
    async function recover(owner: MoqScreenPublisher) {
      if (publisher.current !== owner) return;
      if (Date.now() - lastRecoveryAt < 30_000) {
        setPublisherFailed(true);
        return;
      }
      lastRecoveryAt = Date.now();
      setPublisherRecovering(true);
      await owner.close();
      if (publisher.current !== owner) return;
      const replacement = createPublisher();
      publisher.current = replacement;
      try {
        await replacement.start(stream, options);
      } catch {
        if (publisher.current === replacement) setPublisherFailed(true);
      } finally {
        if (publisher.current === replacement) setPublisherRecovering(false);
      }
    }
    const owner = createPublisher();
    publisher.current = owner;
    await owner.start(stream, options);
  }, [api]);

  const clearPublisherError = useCallback(() => setPublisherFailed(false), []);
  const getStatsSession = useCallback((role: 'sender' | 'viewer') =>
    role === 'sender' ? publisher.current?.getStatsSession() : viewerMedia.current, []);
  return {
    publishAvailable: available && supportsMoqPublisher(),
    remote,
    stream: source?.shareId === shareId ? source?.stream : undefined,
    viewerError,
    getStatsSession,
    publisherFailed,
    publisherRecovering,
    clearPublisherError,
    publish,
    stop
  };
}
