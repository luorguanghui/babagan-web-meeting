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
  assert.match(
    services.livekit.image,
    /@sha256:100b9a870616d02f5e3795b34e0b593b5054a26f8131a94fd3fa322ed3154b16$/,
    'LiveKit may use a registry mirror but must match the production v1.11.0 image digest'
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
  for (const serviceName of ['api', 'caddy']) {
    const extraHosts = services[serviceName].extra_hosts ?? {};
    const hostGateway = Array.isArray(extraHosts)
      ? extraHosts.some((entry) => /^host\.docker\.internal[:=]host-gateway$/.test(entry))
      : extraHosts['host.docker.internal'] === 'host-gateway';
    assert.equal(hostGateway, true, `${serviceName} must resolve the Docker host gateway`);
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
