import { CloudflareSfuStatusResponseSchema, type CloudflareSfuPublication, type CloudflareSfuStatusResponse } from '@meeting/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest } from '../api/client.js';
import { CloudflareScreenSession, createCloudflareScreenApi } from './cloudflare-sfu.js';
export function useCloudflareScreen(slug: string, identity: string, fetchIceServers: () => Promise<RTCIceServer[]>) {
  const [publication, setPublication] = useState<CloudflareSfuPublication | null>(null);
  const publicationRef = useRef<CloudflareSfuPublication | null>(null);
  const [stream, setStream] = useState<MediaStream>();
  const [error, setError] = useState<string>();
  const [available, setAvailable] = useState<boolean>();
  const [revision, setRevision] = useState(0);
  const viewer = useRef<CloudflareScreenSession | undefined>(undefined);
  const closeTail = useRef<Promise<void>>(Promise.resolve());
  const api = useMemo(() => createCloudflareScreenApi(slug), [slug]);
  const reportError = useCallback((e: unknown) => setError(`Cloudflare SFU: ${e instanceof Error ? e.message : 'Screen connection failed.'}`), []);
  const createSession = useCallback((onStream?: (s: MediaStream) => void, onError = reportError) => new CloudflareScreenSession({ api, fetchIceServers, onStream, onError }), [api, fetchIceServers, reportError]);
  const announce = useCallback((next: CloudflareSfuPublication | null) => {
    publicationRef.current = next;
    setPublication(current => current?.shareId === next?.shareId ? current : next);
  }, []);
  useEffect(() => {
    let active = true;
    void apiRequest<CloudflareSfuStatusResponse>(`/meetings/${encodeURIComponent(slug)}/screen-sfu`, CloudflareSfuStatusResponseSchema, { signal: AbortSignal.timeout(15000) }).then(status => {
      if (active)
        setAvailable(status.available);
      // Discovery belongs to the ordered websocket snapshot; an older HTTP
      // status response must not resurrect a withdrawn publication.
    }).catch(() => { if (active)
      setAvailable(false); });
    return () => { active = false; };
  }, [slug]);
  useEffect(() => {
    let active = true;
    setStream(undefined);
    setError(undefined);
    if (!publication || publication.sharerIdentity === identity)
      return;
    const session = createSession(s => { if (active)
      setStream(s); }, e => { if (active)
      reportError(e); });
    viewer.current = session;
    void closeTail.current.then(async () => {
      if (active)
        await session.subscribe(publication);
    }).catch(e => { if (active)
      reportError(e); });
    return () => {
      active = false;
      if (viewer.current === session)
        viewer.current = undefined;
      const preceding = closeTail.current;
      closeTail.current = Promise.all([preceding, session.close()]).then(() => undefined);
    };
  }, [createSession, identity, publication, reportError, revision]);
  const retry = useCallback(() => { setRevision(r => r + 1); }, []);
  const close = useCallback(async () => { await viewer.current?.close(); viewer.current = undefined; }, []);
  const clearError = useCallback(() => setError(undefined), []);
  return { publication, publicationRef, stream, error, available, announce, createSession, viewer, reportError, clearError, retry, close };
}
