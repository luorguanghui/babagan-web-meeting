import { CloudflareSfuStatusResponseSchema, type CloudflareSfuPublication, type CloudflareSfuStatusResponse } from '@meeting/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest } from '../api/client.js';
import { CloudflareScreenSession, createCloudflareScreenApi } from './cloudflare-sfu.js';
import { CloudflareScreenRecovery, isTerminalCloudflareError } from './cloudflare-recovery.js';
export function useCloudflareScreen(slug: string, identity: string, fetchIceServers: () => Promise<RTCIceServer[]>) {
  const [publication, setPublication] = useState<CloudflareSfuPublication | null>(null);
  const publicationRef = useRef<CloudflareSfuPublication | null>(null);
  const [stream, setStream] = useState<MediaStream>();
  const [error, setError] = useState<string>();
  const [available, setAvailable] = useState<boolean>();
  const [revision, setRevision] = useState(0);
  const [recovering, setRecovering] = useState(false);
  const [publisherRecovering, setPublisherRecovering] = useState(false);
  const [sourceIdentity, setSourceIdentity] = useState<string>();
  const sourceIdentityRef = useRef<string | undefined>(undefined);
  const viewer = useRef<CloudflareScreenRecovery | undefined>(undefined);
  const closeTail = useRef<Promise<void>>(Promise.resolve());
  const api = useMemo(() => createCloudflareScreenApi(slug), [slug]);
  const reportError = useCallback((e: unknown) => setError(`Cloudflare SFU: ${e instanceof Error ? e.message : 'Screen connection failed.'}`), []);
  const createSession = useCallback((onStream?: (s: MediaStream) => void, onError = reportError, onRecovering = setPublisherRecovering) => new CloudflareScreenRecovery({
    createSession: (s, e) => new CloudflareScreenSession({ api, fetchIceServers, onStream: s, onError: e }),
    onStream, onError, onRecovering: value => { onRecovering(value); if (!value) setError(undefined); }
  }), [api, fetchIceServers, reportError]);
  const announce = useCallback((next: CloudflareSfuPublication | null) => {
    publicationRef.current = next;
    if (next) { sourceIdentityRef.current = next.sharerIdentity; setSourceIdentity(next.sharerIdentity); }
    setPublication(current => current?.shareId === next?.shareId ? current : next);
  }, []);
  const reset = useCallback(() => {
    announce(null); sourceIdentityRef.current = undefined; setSourceIdentity(undefined);
    setRecovering(false); setPublisherRecovering(false); setError(undefined);
  }, [announce]);
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
    setRecovering(Boolean(sourceIdentity && sourceIdentity !== identity && !publication));
    if (!publication || publication.sharerIdentity === identity)
      return;
    let received = false;
    const slow = setTimeout(() => { if (active && !received) setRecovering(true); }, 2500);
    const session = createSession(s => {
      if (active) { received = true; clearTimeout(slow); setStream(s); }
    }, e => {
      if (!active) return;
      if (isTerminalCloudflareError(e)) { clearTimeout(slow); setRecovering(false); }
      reportError(e);
    }, value => { if (active) setRecovering(value); });
    viewer.current = session;
    void closeTail.current.then(async () => {
      if (active)
        await session.subscribe(publication);
    }).catch(e => { if (active)
      reportError(e); });
    return () => {
      active = false;
      clearTimeout(slow);
      if (viewer.current === session)
        viewer.current = undefined;
      const preceding = closeTail.current;
      closeTail.current = Promise.all([preceding, session.close()]).then(() => undefined);
    };
  }, [createSession, identity, publication, reportError, revision, sourceIdentity]);
  const retry = useCallback(() => { setRevision(r => r + 1); }, []);
  const close = useCallback(async () => { await viewer.current?.close(); viewer.current = undefined; }, []);
  const clearError = useCallback(() => setError(undefined), []);
  return { publication, publicationRef, stream, error, available, announce, reset, sourceIdentity, sourceIdentityRef, recovering, publisherRecovering, createSession, viewer, reportError, clearError, retry, close };
}
