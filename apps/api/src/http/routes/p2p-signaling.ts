import type { WebSocket } from '@fastify/websocket';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AppConfig } from '../../config.js';
import type { P2pSocket } from '../../p2p/room-registry.js';
import { P2pRoomRegistry } from '../../p2p/room-registry.js';
import { P2pSignalingSession } from '../../p2p/signaling-session.js';
import { participantCookie, readSignedSessionCookie } from '../../security/session-token.js';
import type { ParticipantApplicationService } from '../../services/participant-application-service.js';
import { SessionAuthenticationError } from '../auth.js';
import { assertTrustedOrigin } from '../origin.js';

const SlugParamsSchema = Type.Object({ slug: Type.String({ minLength: 22, maxLength: 256 }) });

export interface P2pSignalingDependencies {
  participants: ParticipantApplicationService;
  p2p: P2pRoomRegistry;
  config: Pick<AppConfig, 'publicBaseUrl'>;
}

export interface P2pHandshakeSession {
  identity: string;
  nickname: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Auth result captured by the pre-upgrade `onRequest` hook. */
    p2pAuth?: P2pHandshakeSession;
  }
}

/**
 * Authenticates the upgrade request with the participant session cookie and
 * rejects invalid or expired sessions/meetings. Throws are turned into HTTP
 * error responses (401 for invalid/revoked sessions, 404 for unknown
 * meetings) by the error handler before the upgrade happens.
 */
export function authenticateP2pHandshake(
  request: FastifyRequest,
  participants: ParticipantApplicationService,
  slugValue: string
): P2pHandshakeSession {
  const raw = readSignedSessionCookie(request, participantCookie);
  if (!raw) throw new SessionAuthenticationError();
  const session = participants.authenticate(raw, slugValue);
  return { identity: session.identity, nickname: session.nickname };
}

export function registerP2pSignalingRoute(app: FastifyInstance, dependencies: P2pSignalingDependencies): void {
  app.get('/api/v1/meetings/:slug/p2p', {
    websocket: true,
    schema: { params: SlugParamsSchema },
    // Auth lives in an async `onRequest` hook: it runs before the upgrade and
    // a throw becomes an HTTP error response (401/404/410). Note it must be
    // async — a synchronous hook that returns undefined would leave Fastify's
    // hook chain stalled for upgrade requests. A passing `preValidation` hook
    // also hangs the upgrade with @fastify/websocket 11.x, so we avoid it.
    onRequest: async (request) => {
      assertTrustedOrigin(request, dependencies.config.publicBaseUrl);
      // Auth is performed once, before the upgrade, so a throw becomes an HTTP
      // error response. The result is reused by the ws handler — re-running
      // authentication there could throw uncaught inside the socket callback
      // (e.g. when a session is revoked between upgrade and first message).
      request.p2pAuth = authenticateP2pHandshake(request, dependencies.participants, slug(request.params));
    }
  }, (socket, request) => {
    const value = slug(request.params);
    const auth = request.p2pAuth ?? authenticateP2pHandshake(request, dependencies.participants, value);
    const adapter = createSocketAdapter(socket);
    const session = new P2pSignalingSession({
      registry: dependencies.p2p,
      slug: value,
      identity: auth.identity,
      nickname: auth.nickname,
      socket: adapter,
      getShareIdentity: () => dependencies.participants.getShareIdentity(value)
    });
    adapter.on('message', (raw) => session.handleMessage(String(raw)));
    adapter.on('close', () => session.teardown());
    adapter.on('error', () => session.teardown());
    session.start();
  });
}

/** Wraps the ws `WebSocket` in the minimal `P2pSocket` interface. */
function createSocketAdapter(socket: WebSocket): P2pSocket {
  return {
    send: (raw) => socket.send(raw),
    close: (code) => socket.close(code),
    on: (event, listener) => {
      if (event === 'message') {
        socket.on('message', (data: unknown) => listener(String(data)));
      } else {
        socket.on(event, listener);
      }
    }
  };
}

function slug(params: unknown): string {
  return (params as { slug: string }).slug;
}
