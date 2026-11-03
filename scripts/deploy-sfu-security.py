"""Prebuilt API-only SFU migration. Activate API before requiring gateway auth."""
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3

APP = Path('/opt/babagan-web-meeting')
PAYLOAD = Path(__file__).resolve().parent
BASE_API = 'dc07f5516b97f4bac665ecae55fbd8bddad6339b'
BASE_WEB = '5012ef1a06575a1a8b9ae7e960e415a576b422f3'
SOURCE_BASE = APP / 'var/releases/update-20261102T182654Z-background-audio-prebuilt/source'
UPDATER_HASH = '46fa0fe69c63de317928ab554e01c011bb249e24872092feb0d1a45179671782'
MODULES = {'app.js', 'config.js', 'server.js', 'services/cloudflare-sfu-client.js',
           'services/cloudflare-sfu.js', 'smoke/cloudflare-sfu-check-cli.js'}

def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def deploy():
    if not __debug__ or os.geteuid() != 0:
        raise RuntimeError('Run with sudo and normal Python assertions enabled')
    os.umask(0o077)
    updater = APP / 'scripts/update-release.py'
    assert sha256(updater) == UPDATER_HASH, 'Updater changed; inspect before deployment'
    spec = importlib.util.spec_from_file_location('release_helpers', updater)
    u = importlib.util.module_from_spec(spec); spec.loader.exec_module(u)
    run = u.command
    state, env = APP / 'var/releases', APP / 'infra/.env.production'
    assert state.stat().st_mode & 0o777 == 0o700 and not state.is_symlink()
    assert shutil.disk_usage(APP).free > 10 * 1024 ** 3
    manifest = json.loads((PAYLOAD / 'build-manifest.json').read_text())
    token = (PAYLOAD / 'gateway-token.txt').read_text().strip()
    assert re.fullmatch(r'[a-f0-9]{64}', token), 'Invalid gateway credential'
    assert sha256(PAYLOAD / 'sfu-security.bundle') == manifest['bundleSha256']
    assert sha256(PAYLOAD / 'candidate-smoke.mjs') == manifest['smokeSha256']
    modules = {str(p.relative_to(PAYLOAD / 'api-modules')): sha256(p) for p in (PAYLOAD / 'api-modules').rglob('*') if p.is_file()}
    assert modules == manifest['apiModules'] and set(modules) == MODULES
    with Path('/run/lock/babagan-meeting-update.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert not (state / 'pending-release.env').exists() and not (state / 'update-pending.json').exists()
        names = ['babagan-meeting-' + name + '-1' for name in u.SERVICES]
        inspect = lambda: json.loads(run(['docker', 'inspect', *names]))
        before = inspect(); api = next(c for c in before if c['Name'] == '/babagan-meeting-api-1')
        files = u.compose_chain(APP, api['Config']['Labels']['com.docker.compose.project.config_files'])
        original_snapshot = u.configuration_snapshot(env, files)
        baseline = u.running_commits(state, before, ['api', 'web'])
        assert baseline == {'api': BASE_API, 'web': BASE_WEB}, 'Running source changed'
        assert run(['git', '-C', str(SOURCE_BASE), 'rev-parse', 'HEAD']) == BASE_WEB
        database = Path(run(['docker', 'volume', 'inspect', '--format', '{{.Mountpoint}}', 'babagan-meeting_api-data'])) / 'meetings.sqlite'
        u.require_no_meeting(database)
        u.require_unchanged(env, files, original_snapshot, before, inspect)
        compose = ['docker', 'compose', '--env-file', str(env)]
        for path in files: compose += ['-f', path]
        run(compose + ['config', '-q'])
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        release = state / ('update-' + stamp + '-sfu-security-prebuilt'); release.mkdir(mode=0o700)
        print('Release directory:', release, flush=True)
        source = release / 'source'
        run(['git', 'clone', '--no-hardlinks', '--no-tags', str(SOURCE_BASE), str(source)])
        run(['git', '-C', str(source), 'bundle', 'verify', str(PAYLOAD / 'sfu-security.bundle')])
        run(['git', '-C', str(source), 'fetch', str(PAYLOAD / 'sfu-security.bundle'), manifest['branch']])
        sha = manifest['candidateCommit']; run(['git', '-C', str(source), 'checkout', '--detach', sha])
        changes = set(run(['git', '-C', str(source), 'diff', '--name-only', BASE_API, sha, '--', 'apps/api/src']).splitlines())
        assert {p for p in changes if not p.endswith('.test.ts')} == {'apps/api/src/' + m.removesuffix('.js') + '.ts' for m in MODULES}
        for path, blob in manifest['sourceInputs'].items():
            assert run(['git', '-C', str(source), 'rev-parse', 'HEAD:' + path]) == blob
        u.require_forward_update(source, baseline, sha, ['api'])
        u.save(release / 'before.json', u.container_metadata(before)); u.save(release / 'build-manifest.json', manifest)
        u.save(release / 'source.json', {'commit': sha, 'ref': manifest['branch'], 'services': ['api']})
        image = 'babagan-meeting-api:update-' + sha + '-' + stamp
        base_tag = 'babagan-meeting-api:sfu-security-base-' + stamp
        run(['docker', 'tag', api['Image'], base_tag])
        dockerfile = release / 'Dockerfile.api-prebuilt'
        dockerfile.write_text(f'FROM {base_tag}\nCOPY --chown=10001:10001 api-modules/ /app/dist/\nLABEL org.opencontainers.image.revision="{sha}"\n')
        with (release / 'api-build.log').open('w') as log:
            run(['docker', 'build', '--network=none', '--pull=false', '-f', str(dockerfile), '-t', image, str(PAYLOAD)], output=log)
        image_id = run(['docker', 'image', 'inspect', image, '--format', '{{.Id}}'])
        # Temporary candidate env stays private and is never printed.
        candidate_env = release / 'candidate.env'
        original_env = env.read_text()
        assert not re.search(r'^CLOUDFLARE_SFU_GATEWAY_TOKEN=.+', original_env, re.M), 'Credential already exists; inspect before overwrite'
        updated_env = re.sub(r'^CLOUDFLARE_SFU_GATEWAY_TOKEN=.*\n?', '', original_env, flags=re.M).rstrip() + '\nCLOUDFLARE_SFU_GATEWAY_TOKEN=' + token + '\n'
        candidate_env.write_text(updated_env); candidate_env.chmod(0o600)
        # The mounted test contains no credentials and must be readable by the
        # production container's UID 10001. Keep the env/token files mode 600.
        (PAYLOAD / 'candidate-smoke.mjs').chmod(0o644)
        with (release / 'candidate-smoke.log').open('w') as log:
            run(['docker', 'run', '--rm', '--network=none', '--env-file', str(candidate_env),
                 '-e', 'NODE_ENV=test', '-e', 'DATABASE_PATH=:memory:', '-v', str(PAYLOAD / 'candidate-smoke.mjs') + ':/app/candidate-smoke.mjs:ro',
                 '--entrypoint', 'node', image, '/app/candidate-smoke.mjs'], output=log)
        print('Candidate startup and cleanup smoke passed', flush=True)
        u.require_unchanged(env, files, original_snapshot, before, inspect); u.require_no_meeting(database)
        backup = Path(run(['bash', str(source / 'scripts/backup.sh'), str(database), str(release / 'database-backup'), '100']).removeprefix('Backup created: '))
        assert backup.is_file() and backup.resolve().is_relative_to(release)
        shutil.copy2(env, release / 'previous.env'); (release / 'previous.env').chmod(0o600)
        override = release / 'override.yml'
        override.write_text(json.dumps({'services': {'api': {'image': image, 'environment': {'CLOUDFLARE_SFU_GATEWAY_TOKEN': '${CLOUDFLARE_SFU_GATEWAY_TOKEN:?required}'}}}}, indent=2)); override.chmod(0o600)
        candidate = compose + ['-f', str(override)]
        candidate_check = ['docker', 'compose', '--env-file', str(candidate_env)]
        for path in files: candidate_check += ['-f', path]
        run(candidate_check + ['-f', str(override), 'config', '-q'])
        # The old API ignores this new variable, permitting verified rollback
        # before the separate Worker authentication cutover.
        rollback = u.write_rollback(release, compose, before, ['api'])
        snapshot = {**original_snapshot, str(env): hashlib.sha256(updated_env.encode()).hexdigest()}
        pending = state / 'update-pending.json'
        u.save(pending, {'commit': sha, 'releaseDirectory': str(release), 'rollbackScript': str(rollback), 'services': ['api'],
                         'previousEnv': str(release / 'previous.env'), 'previousConfigHashes': original_snapshot, 'candidateConfigHashes': snapshot})
        def unchanged():
            assert u.configuration_snapshot(env, files) == snapshot, 'Configuration changed concurrently'
        def verify():
            unchanged(); u.verify_containers(before, u.wait_healthy(inspect), {'api': image_id})
            for name, digest in modules.items():
                assert run(['docker', 'exec', 'babagan-meeting-api-1', 'sha256sum', '/app/dist/' + name]).split()[0] == digest
            for path, expected in [('/health/live', 'ok'), ('/health/ready', 'ready')]:
                assert json.loads(run(['curl', '--fail', '--silent', '--max-time', '20', 'https://meet.babagan.cloud' + path]))['status'] == expected
            assert run(['docker', 'exec', 'babagan-meeting-api-1', 'node', 'dist/smoke/cloudflare-sfu-check-cli.js']) == 'CLOUDFLARE_SFU_AUTH_OK'
        def verify_rollback():
            unchanged(); u.verify_containers(before, u.wait_healthy(inspect), {'api': api['Image']})
        stopped = False
        try:
            temporary_env = env.with_name('.env.sfu-security-pending')
            temporary_env.write_text(updated_env); temporary_env.chmod(0o600); os.replace(temporary_env, env)
            unchanged()
            # Hold the admission write lock through stopping the old API. A
            # concurrent create cannot commit after the final empty-room check.
            # Release before starting the replacement so migrations can run.
            with sqlite3.connect(database, timeout=10) as admission:
                admission.execute('BEGIN IMMEDIATE')
                assert admission.execute("select count(*) from meetings where status in ('created','active','grace')").fetchone()[0] == 0, 'A meeting opened; deployment cancelled'
                stopped = True
                run(['docker', 'stop', '--time', '30', 'babagan-meeting-api-1'])
                admission.rollback()
            u.activate(candidate, ['api'], rollback, verify, release, verify_rollback=verify_rollback, rollback_guard=unchanged)
        except Exception:
            unchanged()
            if stopped: run(['bash', str(rollback)])
            u.verify_containers(before, u.wait_healthy(inspect), {'api': api['Image']})
            restore = env.with_name('.env.sfu-security-restore')
            restore.write_bytes((release / 'previous.env').read_bytes()); restore.chmod(0o600); os.replace(restore, env)
            assert u.configuration_snapshot(env, files) == original_snapshot
            pending.rename(release / 'pending-rolledback.json')
            raise
        record = {'status': 'deployed-and-verified', 'commit': sha, 'services': ['api'], 'serviceCommits': {**baseline, 'api': sha},
                  'containers': u.container_metadata(inspect()),
                  'buildMethod': 'verified-local-api-artifact', 'composeFiles': files + [str(override)],
                  'rollbackScript': str(rollback), 'databaseBackup': str(backup), 'databaseBackupSha256': sha256(backup),
                  'verifiedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        u.save(release / 'release.json', record); u.save(state / 'current-update.json', record)
        pending.rename(release / 'pending-completed.json')
        print('API_UPDATE_SUCCEEDED', sha, flush=True)
        print('Worker authentication cutover may now proceed; old API rollback requires coordinated gateway handling.', flush=True)

if __name__ == '__main__':
    deploy()
