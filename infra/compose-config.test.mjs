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
    '443/udp',
    '50000-60000/udp',
    '7881/tcp',
    '80/tcp'
  ].sort());
  assert.equal((services.api.ports ?? []).length, 0, 'API must remain private');
  assert.equal(
    (services.livekit.ports ?? []).filter((port) => String(port.target) === '7880').length,
    0,
    'LiveKit signal port 7880 must remain private'
  );
  assert.deepEqual(
    services.livekit.command,
    ['--config', '/etc/livekit/livekit.yaml', '--node-ip', '203.0.113.10'],
    'LiveKit must explicitly load its mounted configuration and advertise the configured public IP'
  );
  assert.equal(
    services.caddy.user,
    undefined,
    'Caddy must use its image default user so fresh TLS volumes can initialize safely'
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
