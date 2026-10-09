#!/usr/bin/env python3
"""Existing-server application update; first installations use deploy.sh."""
import argparse
from contextlib import ExitStack
import datetime
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import sqlite3
import subprocess
import sys
import time
from html.parser import HTMLParser

SERVICES = ['api', 'web', 'caddy', 'livekit', 'coturn']


def command(args, output=None, env=None):
    result = subprocess.run(args, text=True, env=env, stdout=output or subprocess.PIPE,
                            stderr=subprocess.STDOUT if output else subprocess.PIPE)
    if result.returncode:
        # Do not echo command arguments, Docker env values or handshake tokens.
        raise RuntimeError(f'{args[0]} failed (exit {result.returncode}); check the protected release log')
    return (result.stdout or '').strip()


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    path.chmod(0o600)


def container_metadata(containers):
    return [{'name': c['Name'], 'containerId': c['Id'], 'imageId': c['Image'],
             'image': c['Config']['Image'], 'health': c['State']['Health']['Status']}
            for c in containers]


def compose_chain(app, value):
    result = []
    for filename in value.split(','):
        path = Path(filename).resolve()
        if not path.is_relative_to(app.resolve()) or not path.is_file():
            raise ValueError('An active Compose file is missing or outside the installation')
        result.append(str(path))
    if not result:
        raise ValueError('The active Compose configuration is missing')
    return result


def require_no_meeting(database):
    if not database.is_file():
        raise RuntimeError('The existing meeting database is missing')
    with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as db:
        count = db.execute("select count(*) from meetings where status in ('created','active','grace')").fetchone()[0]
    if count:
        raise RuntimeError('An open meeting exists; finish it before updating')


def write_rollback(release, compose, before, selected):
    # Immutable IDs remain valid even if a mutable image tag is reused later.
    previous = release / 'previous-images.yml'
    previous.write_text('services:\n' + ''.join(
        f'  {service}:\n    image: {next(c["Image"] for c in before if c["Name"] == "/babagan-meeting-" + service + "-1")}\n'
        for service in selected))
    previous.chmod(0o600)
    rollback = release / 'rollback.sh'
    rollback.write_text('#!/bin/bash\nset -Eeuo pipefail\n' + shlex.join(
        compose + ['-f', str(previous), 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', *selected]) + '\n')
    rollback.chmod(0o700)
    return rollback


def verify_containers(before, after, image_ids):
    for old in before:
        current = next(c for c in after if c['Name'] == old['Name'])
        service = old['Name'].removeprefix('/babagan-meeting-').removesuffix('-1')
        if current['State']['Health']['Status'] != 'healthy':
            raise RuntimeError(f'{service} is not healthy')
        if service in image_ids:
            if current['Image'] != image_ids[service]:
                raise RuntimeError(f'{service} is not running the candidate image')
        elif current['Id'] != old['Id'] or current['Image'] != old['Image']:
            raise RuntimeError(f'{service} was unexpectedly replaced')


def public_asset(html):
    class Scripts(HTMLParser):
        def __init__(self):
            super().__init__()
            self.sources = []
        def handle_starttag(self, tag, attributes):
            values = dict(attributes)
            if tag == 'script' and values.get('type') == 'module':
                self.sources.append(values.get('src', ''))
    parser = Scripts()
    parser.feed(html)
    if len(parser.sources) != 1 or not re.fullmatch(r'/assets/[A-Za-z0-9_-]+\.js', parser.sources[0]):
        raise ValueError('The public page has no safe, unambiguous module asset')
    return parser.sources[0]


def activate(compose, selected, rollback, verify, log_directory=None):
    with ExitStack() as stack:
        activation_log = stack.enter_context((log_directory / 'activation.log').open('w')) if log_directory else None
        rollback_log = stack.enter_context((log_directory / 'rollback.log').open('w')) if log_directory else None
        try:
            command(compose + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', *selected], output=activation_log)
            verify()
        except Exception as original:
            failure = {'activationOrVerificationError': str(original)}
            try:
                command(['bash', str(rollback)], output=rollback_log)
                failure['applicationImagesRestored'] = True
            except Exception as recovery:
                failure['rollbackError'] = str(recovery)
                failure['applicationImagesRestored'] = False
                raise RuntimeError('Update and application rollback both failed; inspect protected failure.json and logs') from original
            finally:
                if log_directory:
                    save(log_directory / 'failure.json', failure)
            raise


def update(options):
    app = options.app_dir.resolve()
    env_file = app / 'infra/.env.production'
    if not env_file.is_file() or env_file.stat().st_mode & 0o777 != 0o600:
        raise RuntimeError('Existing production env must exist with mode 600')
    state = app / 'var/releases'
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    if (state / 'pending-release.env').exists() or (state / 'update-pending.json').exists():
        raise RuntimeError('An unresolved deployment exists; recover it before updating')
    import fcntl
    lock_path = Path(os.environ.get('BABAGAN_UPDATE_LOCK_FILE', '/run/lock/babagan-meeting-update.lock'))
    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (state / 'pending-release.env').exists() or (state / 'update-pending.json').exists():
            raise RuntimeError('An unresolved deployment exists; recover it before updating')
        perform_update(options, app, env_file, state)


def perform_update(options, app, env_file, state):
    public_base = next((line.split('=', 1)[1] for line in env_file.read_text().splitlines()
                        if line.startswith('PUBLIC_BASE_URL=')), '').rstrip('/')
    if not re.fullmatch(r'https://[A-Za-z0-9.-]+(?::[0-9]+)?', public_base):
        raise RuntimeError('PUBLIC_BASE_URL must be a plain HTTPS origin')
    env_checksum = hashlib.sha256(env_file.read_bytes()).hexdigest()
    names = ['babagan-meeting-' + s + '-1' for s in SERVICES]
    inspect = lambda: json.loads(command(['docker', 'inspect', *names]))
    before = inspect()
    if not all(c['State']['Health']['Status'] == 'healthy' for c in before):
        raise RuntimeError('All existing services must be healthy before updating')
    web = next(c for c in before if c['Name'] == '/babagan-meeting-web-1')
    if web['Config']['Labels'].get('com.docker.compose.project') != 'babagan-meeting':
        raise RuntimeError('The running web service belongs to another Compose project')
    files = compose_chain(app, web['Config']['Labels']['com.docker.compose.project.config_files'])
    compose = ['docker', 'compose', '--env-file', str(env_file)]
    for filename in files:
        compose += ['-f', filename]
    command(compose + ['config', '-q'])
    mount = Path(command(['docker', 'volume', 'inspect', '--format', '{{.Mountpoint}}', 'babagan-meeting_api-data']))
    database = mount / 'meetings.sqlite'
    require_no_meeting(database)
    if hashlib.sha256(env_file.read_bytes()).hexdigest() != env_checksum:
        raise RuntimeError('Production environment changed during the build; candidate retained without activation')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    release = state / ('update-' + stamp + '-' + str(os.getpid()))
    release.mkdir(mode=0o700)
    print(f'Release directory: {release}', flush=True)
    repository = command(['git', '-C', str(app), 'remote', 'get-url', 'origin'])
    source = release / 'source'
    print('Fetching reviewed release source...', flush=True)
    with (release / 'source-fetch.log').open('w') as log:
        command(['git', 'clone', '--depth', '1', '--no-single-branch', '--branch', options.ref, repository, str(source)], output=log)
    if options.commit:
        command(['git', '-C', str(source), 'fetch', '--depth', '1', 'origin', options.commit])
        command(['git', '-C', str(source), 'checkout', '--detach', options.commit])
    sha = command(['git', '-C', str(source), 'rev-parse', 'HEAD'])
    if not re.fullmatch(r'[0-9a-f]{40}', sha) or (options.commit and sha != options.commit):
        raise RuntimeError('Candidate source identity did not verify')
    if command(['git', '-C', str(source), 'status', '--porcelain']):
        raise RuntimeError('Candidate source is dirty')
    selected = ['web'] if options.web_only else ['api', 'web']
    save(release / 'before.json', container_metadata(before))
    save(release / 'source.json', {'commit': sha, 'ref': options.ref, 'services': selected})
    backup_output = command(['bash', str(source / 'scripts/backup.sh'), str(database), str(release / 'database-backup'), '100'])
    backup = Path(backup_output.removeprefix('Backup created: ')).resolve()
    if not backup.is_relative_to(release / 'database-backup') or not backup.is_file():
        raise RuntimeError('Database backup did not produce the expected protected snapshot')
    backup_sha = hashlib.sha256(backup.read_bytes()).hexdigest()
    if not backup.with_name(backup.name + '.sha256').read_text().startswith(backup_sha + ' '):
        raise RuntimeError('Database backup checksum did not verify')
    backup_record = {'databaseBackup': str(backup), 'databaseBackupSha256': backup_sha}
    save(release / 'backup.json', backup_record)
    image_ids = {}
    images = {}
    for service in selected:
        images[service] = f'babagan-meeting-{service}:update-{sha}-{stamp}'
        print(f'Building {service}...', flush=True)
        with (release / (service + '-build.log')).open('w') as log:
            command(['docker', 'build', '--progress=plain', '-f', str(source / f'apps/{service}/Dockerfile'),
                     '-t', images[service], str(source)], output=log)
        image_ids[service] = command(['docker', 'image', 'inspect', images[service], '--format', '{{.Id}}'])
    if hashlib.sha256(env_file.read_bytes()).hexdigest() != env_checksum:
        raise RuntimeError('Production environment changed during the build; candidate retained without activation')
    if any(c['Id'] != before[index]['Id'] for index, c in enumerate(inspect())):
        raise RuntimeError('The installation changed while building; candidate retained without activation')
    if (state / 'pending-release.env').exists() or (state / 'update-pending.json').exists():
        raise RuntimeError('A pending deployment appeared during the build; candidate retained without activation')
    require_no_meeting(database)
    rollback = write_rollback(release, compose, before, selected)
    override = release / 'override.yml'
    override.write_text('services:\n' + ''.join(f'  {s}:\n    image: {images[s]}\n' for s in selected))
    override.chmod(0o600)
    candidate = compose + ['-f', str(override)]
    command(candidate + ['config', '-q'])
    pending = state / 'update-pending.json'
    save(pending, {'commit': sha, 'releaseDirectory': str(release), 'rollbackScript': str(rollback),
                   'previous': container_metadata(before), 'status': 'prepared', **backup_record})
    save(release / 'pending.json', json.loads(pending.read_text()))
    # Migrations run only for API updates. Any failure leaves backup and pending
    # evidence intact; image rollback never silently replaces the database.
    if 'api' in selected:
        with (release / 'migration.log').open('w') as log:
            command(['docker', 'run', '--rm', '--network', 'none', '--env-file', str(env_file),
                     '-e', 'DATABASE_PATH=/data/meetings.sqlite', '-v', 'babagan-meeting_api-data:/data',
                     '--entrypoint', 'node', images['api'], '--input-type=module', '-e',
                     'import {createDatabase} from "./dist/db/database.js"; import {migrate} from "./dist/db/migrate.js"; '
                     'const db=createDatabase(process.env.DATABASE_PATH); try { migrate(db); } finally { db.close(); }'], output=log)
    def fetch(url):
        return subprocess.check_output(['curl', '--fail', '--silent', '--show-error', '--max-time', '30',
                                        '--proto', '=https', url])
    proof = {}
    def verify():
        for attempt in range(60):
            after = inspect()
            if all(c['State']['Health']['Status'] == 'healthy' for c in after):
                break
            time.sleep(2)
        verify_containers(before, after, image_ids)
        asset = public_asset(fetch(public_base + '/').decode())
        digest = hashlib.sha256(fetch(public_base + asset)).hexdigest()
        expected = command(['docker', 'exec', 'babagan-meeting-web-1', 'sha256sum', '/srv' + asset]).split()[0]
        if digest != expected:
            raise RuntimeError('Public JavaScript does not match the running container')
        proof.update(publicAsset=asset, publicAssetSha256=digest, containers=container_metadata(after))
        api_image = images.get('api') or next(c['Image'] for c in before if c['Name'] == '/babagan-meeting-api-1')
        smoke_env = dict(os.environ, SKIP_CLOUDFLARE_SMOKE='1' if options.skip_cloudflare_smoke else '0')
        with (release / 'smoke.log').open('w') as log:
            command(['bash', str(source / 'scripts/deployment-smoke.sh'), files[0], str(env_file), api_image,
                     public_base, public_base.replace('https://', 'wss://') + '/rtc'], output=log, env=smoke_env)
    activate(candidate, selected, rollback, verify, release)
    record = {'status': 'deployed-and-verified', 'commit': sha, 'services': selected,
              'verifiedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'rollbackScript': str(rollback), 'composeFiles': files + [str(override)],
              'cloudflareSmokeSkipped': options.skip_cloudflare_smoke, **backup_record, **proof}
    save(release / 'release.json', record)
    save(state / 'current-update.json', record)
    pending.rename(release / 'pending-completed.json')
    print(f'UPDATE SUCCEEDED: {sha}\nRelease record: {release / "release.json"}\nRollback: {rollback}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-dir', type=Path, default=Path('/opt/babagan-web-meeting'))
    parser.add_argument('--ref', default='main', help='reviewed remote branch (default: main)')
    parser.add_argument('--commit', help='optional exact reviewed 40-character commit')
    parser.add_argument('--web-only', action='store_true', help='only update the static web service')
    parser.add_argument('--skip-cloudflare-smoke', action='store_true', help='explicitly waive only the Cloudflare provider check')
    options = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]*', options.ref) or '..' in options.ref:
        parser.error('invalid branch name')
    if options.commit and not re.fullmatch(r'[0-9a-f]{40}', options.commit):
        parser.error('--commit must be a full lowercase SHA')
    if sys.platform != 'linux':
        parser.error('run this updater on the existing Linux server')
    os.umask(0o077)
    try:
        update(options)
    except Exception as error:
        print(f'UPDATE FAILED: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
