import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const composeFile = resolve(root, 'infra', 'docker-compose.yml');
const environmentFile = resolve(root, 'infra', '.env.production.example');

assert.ok(existsSync(composeFile), 'infra/docker-compose.yml must exist');
assert.ok(existsSync(environmentFile), 'infra/.env.production.example must exist');

export function assertProductionComposeConfig(config) {
  const services = config.services;
  assert.ok(services, 'rendered Compose config must include services');

  const exposedPorts = Object.values(services).flatMap((service) =>
    (service.ports ?? [])
      .filter((port) => port.published)
      .map((port) => `${port.published}/${port.protocol ?? 'tcp'}`)
  );

  assert.deepEqual(exposedPorts.sort(), [
    '443/tcp',
    '80/tcp'
  ].sort());
  assert.equal((services.api.ports ?? []).length, 0, 'API must remain private');
  assert.equal(
    services.livekit.network_mode,
    'host',
    'LiveKit must bypass Docker bridge NAT so ICE and embedded TURN share the host network path'
  );
  assert.equal((services.livekit.ports ?? []).length, 0, 'host-networked LiveKit must not publish Docker ports');
  assert.equal((services.livekit.expose ?? []).length, 0, 'host-networked LiveKit must not declare bridge-only exposed ports');
  assert.ok(services.coturn, 'coturn relay service must be present');
  assert.equal(services.coturn.network_mode, 'host', 'coturn must preserve host ICE addresses and relay ports');
  assert.equal((services.coturn.ports ?? []).length, 0, 'host-networked coturn must not publish Docker ports');
  assert.equal(services.coturn.read_only, true, 'coturn root filesystem must be read-only');
  assert.match(
    services.coturn.image,
    /coturn\/coturn:4\.17\.2-r0@sha256:aa68aab64a3b929d57fc2924c98ea447bf996cf8dade2508e7b71eaf23f1f14e$/,
    'coturn must use the approved immutable multi-architecture image'
  );
  assert.ok((services.coturn.cap_drop ?? []).includes('ALL'), 'coturn must drop inherited Linux capabilities');
  assert.ok(
    (services.coturn.volumes ?? []).some((volume) =>
      volume.target === '/caddy-data' && volume.read_only === true
    ),
    'coturn must mount Caddy certificate storage read-only'
  );
  assert.equal(services.api.environment.P2P_TURN_TTL_SECONDS, '600');
  assert.equal(services.api.environment.CLOUDFLARE_TURN_HTTPS_PROXY, '');
  assert.match(services.api.environment.P2P_TURN_URLS, /turns:turn\.babagan\.cloud:5349\?transport=tcp/);
  const livekitVersionMatch = services.livekit.image.match(/:v?(\d+)\.(\d+)\.(\d+)(?:@sha256:[0-9a-f]{64})?$/);
  assert.ok(livekitVersionMatch, 'LiveKit image must use a semantic version tag');
  const livekitVersion = livekitVersionMatch.slice(1).map(Number);
  assert.ok(
    livekitVersion[0] > 1 ||
      (livekitVersion[0] === 1 && livekitVersion[1] > 11) ||
      (livekitVersion[0] === 1 && livekitVersion[1] === 11 && livekitVersion[2] >= 0),
    'LiveKit image version must be v1.11.0 or newer'
  );
  assert.equal(
    services.livekit.user,
    undefined,
    'host-networked LiveKit must use the image default user so TURN can bind UDP 443 under the host low-port policy'
  );
  assert.deepEqual(
    services.livekit.command,
    ['--config', '/etc/livekit/livekit.yaml', '--node-ip', '203.0.113.10'],
    'LiveKit must explicitly load its mounted configuration and advertise the configured public IP'
  );
  assert.equal(
    services.api.environment.LIVEKIT_INTERNAL_URL,
    'ws://host.docker.internal:7880',
    'API media control must reach host-networked LiveKit through the Docker host gateway'
  );
  assert.deepEqual(
    Object.keys(services.api.networks ?? {}).sort(),
    ['backend', 'edge'],
    'API must keep its private application network and gain an egress route to the Docker host gateway'
  );
  assert.equal(services.edge.ipam.config[0].subnet, '172.30.0.0/16');
  assert.equal(services.edge.ipam.config[0].gateway, '172.30.0.1');
  assert.equal(services.backend.ipam.config[0].subnet, '172.31.0.0/16');
  assert.equal(services.backend.ipam.config[0].gateway, '172.31.0.1');
  for (const serviceName of ['api', 'caddy']) {
    const extraHosts = services[serviceName].extra_hosts ?? {};
    const edgeGateway = Array.isArray(extraHosts)
      ? extraHosts.some((entry) => /^host\.docker\.internal[:=]172\.30\.0\.1$/.test(entry))
      : extraHosts['host.docker.internal'] === '172.30.0.1';
    assert.equal(edgeGateway, true, `${serviceName} must resolve the edge network gateway`);
  }
  assert.equal(
    services.caddy.user,
    undefined,
    'Caddy must use its image default user so fresh TLS volumes can initialize safely'
  );
  assert.match(
    services.caddy.image,
    /@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d$/,
    'Caddy may use a registry mirror but must match the approved image digest'
  );
  assert.match(
    services.api.build.args.NODE_IMAGE,
    /@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f$/,
    'API build may use a Node registry mirror but must retain the approved image digest'
  );
  assert.equal(services.web.build.args.NODE_IMAGE, services.api.build.args.NODE_IMAGE);
  assert.equal(services.web.build.args.CADDY_IMAGE, services.caddy.image);
}

const injectedConfig = process.env.COMPOSE_CONFIG_JSON;
if (injectedConfig) {
  assertProductionComposeConfig(JSON.parse(injectedConfig));
} else {
  const rendered = spawnSync(
    'docker',
    ['compose', '--env-file', environmentFile, '-f', composeFile, 'config', '--format', 'json'],
    { cwd: root, encoding: 'utf8' }
  );

  if (rendered.error) {
    throw new Error(`Docker Compose is required to render the production config: ${rendered.error.message}`);
  }

  assert.equal(rendered.status, 0, rendered.stderr || 'Docker Compose config rendering failed');
  assertProductionComposeConfig(JSON.parse(rendered.stdout));
}
