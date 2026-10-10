import importlib.util
import json
from pathlib import Path
import tempfile
import shutil
import hashlib
import os
import sys
import subprocess
from types import SimpleNamespace
from contextlib import closing
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release_updater', Path(__file__).with_name('update-release.py'))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class UpdateTests(unittest.TestCase):
    def test_codec_http_check_rejects_missing_isolation_and_modified_wasm(self):
        base = 'https://example.test'
        data = b'wasm bytes'
        record = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
        manifest = {'releaseReady': True, 'sources': {'sources/source.tar.gz': record},
                    'artifacts': {'encoder.wasm': record, 'encoder.mjs': record}}
        def fetch(url):
            return json.dumps(manifest).encode() if url.endswith('manifest.json') else data
        good = lambda url: {'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp',
                            'content-type': 'application/wasm'}
        with self.assertRaises(RuntimeError):
            updater.verify_codec_http(base, fetch, lambda url: {})
        updater.verify_codec_http(base, fetch, good)
        with self.assertRaises(RuntimeError):
            updater.verify_codec_http(base, lambda url: fetch(url) if url.endswith('manifest.json') else b'changed', good)

    def test_codec_http_rejects_empty_artifacts_and_unavailable_corresponding_source(self):
        data = b'verified bytes'
        record = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
        manifest = {'releaseReady': True, 'sources': {'sources/source.tar.gz': record}, 'artifacts': {}}
        good = lambda url: {'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp',
                            'content-type': 'application/wasm'}
        def fetch(url):
            if url.endswith('manifest.json'):
                return json.dumps(manifest).encode()
            return b'404 source body' if '/sources/' in url else data
        with self.assertRaisesRegex(RuntimeError, 'artifact'):
            updater.verify_codec_http('https://example.test', fetch, good)
        manifest['artifacts'] = {'encoder.wasm': record, 'encoder.mjs': record}
        with self.assertRaisesRegex(RuntimeError, 'hash'):
            updater.verify_codec_http('https://example.test', fetch, good)
    def test_compose_chain_preserves_overlays_and_rejects_other_projects(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / 'infra/docker-compose.yml'
            overlay = root / 'var/releases/current/override.yml'
            for path in [base, overlay]:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('services: {}')
            self.assertEqual(updater.compose_chain(root, f'{base},{overlay}'), [str(base), str(overlay)])
            with self.assertRaises(ValueError):
                updater.compose_chain(root, f'{base},{Path(directory).parent / "outside.yml"}')

    def test_frames_and_secrets_are_not_in_saved_container_metadata(self):
        container = {'Name': '/babagan-meeting-web-1', 'Id': 'container', 'Image': 'sha256:old',
                     'Config': {'Image': 'web:old', 'Env': ['COOKIE_SECRET=secret']},
                     'State': {'Health': {'Status': 'healthy'}}}
        safe = updater.container_metadata([container])
        self.assertEqual(safe[0]['imageId'], 'sha256:old')
        self.assertNotIn('secret', json.dumps(safe))

    def test_meeting_check_uses_readonly_database_and_refuses_open_room(self):
        with tempfile.TemporaryDirectory() as directory:
            import sqlite3
            database = Path(directory) / 'meetings.sqlite'
            with closing(sqlite3.connect(database)) as db:
                db.execute('create table meetings(status text)')
                db.execute("insert into meetings values('active')")
                db.commit()
            with self.assertRaisesRegex(RuntimeError, 'meeting'):
                updater.require_no_meeting(database)
            with closing(sqlite3.connect(database)) as db:
                db.execute("update meetings set status='ended'")
                db.commit()
            updater.require_no_meeting(database)

    def test_rollback_pins_actual_previous_image_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory)
            before = [{'Name': '/babagan-meeting-web-1', 'Image': 'sha256:old',
                       'Config': {'Image': 'mutable-tag:latest'}}]
            rollback = updater.write_rollback(release, ['docker', 'compose', '-f', 'base.yml'], before, ['web'])
            text = rollback.read_text()
            self.assertIn('sha256:old', (release / 'previous-images.yml').read_text())
            self.assertNotIn('mutable-tag:latest', text)
            self.assertIn('--no-deps --no-build --pull never web', text)

    def test_health_verification_rejects_any_unexpected_service_replacement(self):
        def container(service, identity):
            return {'Name': f'/babagan-meeting-{service}-1', 'Id': identity, 'Image': 'sha256:' + identity,
                    'State': {'Health': {'Status': 'healthy'}}}
        before = [container('web', 'old'), container('api', 'api')]
        after = [container('web', 'new'), container('api', 'changed')]
        with self.assertRaisesRegex(RuntimeError, 'api'):
            updater.verify_containers(before, after, {'web': 'sha256:new'})
        after[1] = before[1]
        updater.verify_containers(before, after, {'web': 'sha256:new'})

    def test_public_asset_check_rejects_unsafe_asset_path(self):
        self.assertEqual(updater.public_asset('<script type="module" src="/assets/index-new.js"></script>'),
                         '/assets/index-new.js')
        for path in ['https://another.example/script.js', '/assets/../secret', '/assets/file.js?token=x']:
            with self.assertRaises(ValueError):
                updater.public_asset(f'<script type="module" src="{path}"></script>')

    def test_activation_failure_restores_images_and_retains_pending_record(self):
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory)
            rollback = release / 'rollback.sh'
            rollback.write_text('# rollback')
            pending = release / 'pending.json'
            pending.write_text('{}')
            calls = []
            def run(args, **kwargs):
                calls.append(args)
                if args[0] != 'bash':
                    raise RuntimeError('smoke failed')
                return ''
            with patch.object(updater, 'command', side_effect=run):
                with self.assertRaisesRegex(RuntimeError, 'smoke failed'):
                    updater.activate(['docker', 'compose'], ['web'], rollback, lambda: None)
            self.assertEqual(calls[-1], ['bash', str(rollback)])
            self.assertTrue(pending.exists())

    def test_both_failures_are_logged_without_losing_original_error(self):
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory)
            rollback = release / 'rollback.sh'
            rollback.write_text('# rollback')
            def fail(args, output=None, **kwargs):
                output.write('protected command diagnostics\n')
                raise RuntimeError('rollback failed' if args[0] == 'bash' else 'activation failed')
            with patch.object(updater, 'command', side_effect=fail):
                with self.assertRaisesRegex(RuntimeError, 'both failed') as raised:
                    updater.activate(['docker', 'compose'], ['web'], rollback, lambda: None, release)
            self.assertEqual(str(raised.exception.__cause__), 'activation failed')
            evidence = json.loads((release / 'failure.json').read_text())
            self.assertEqual(evidence['activationOrVerificationError'], 'activation failed')
            self.assertEqual(evidence['rollbackError'], 'rollback failed')
            self.assertFalse(evidence['applicationImagesRestored'])
            for name in ['activation.log', 'rollback.log']:
                self.assertIn('diagnostics', (release / name).read_text())

    def test_complete_web_update_records_backup_preserves_overlays_and_skips_api_migration(self):
        self.run_complete_update(web_only=True)

    def test_complete_api_update_migrates_and_keeps_media_containers(self):
        self.run_complete_update(web_only=False)

    @unittest.skipUnless(sys.platform == 'linux', 'real flock exclusion requires Linux')
    def test_full_deploy_refuses_the_lock_held_by_updater(self):
        import fcntl
        with tempfile.TemporaryDirectory() as directory:
            lock_path = Path(directory) / 'update.lock'
            with lock_path.open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = subprocess.run(['bash', str(Path(__file__).with_name('deploy.sh')),
                                         '--confirm-deploy', 'a' * 40, '--target-ip', '203.0.113.10',
                                         '--smoke-token-file', '/not-read', '--network-evidence', '/not-read',
                                         '--cloudflare-evidence', '/not-read'], capture_output=True, text=True,
                                        env=dict(os.environ, BABAGAN_UPDATE_LOCK_FILE=str(lock_path)))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('another deployment/update is running', result.stderr)

    def test_public_hash_mismatch_rolls_back_and_never_marks_release_successful(self):
        self.run_complete_update(web_only=True, mismatch=True)

    def run_complete_update(self, web_only, mismatch=False):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            state = app / 'var/releases'
            state.mkdir(parents=True)
            env = app / 'infra/.env.production'
            env.parent.mkdir()
            env.write_text('PUBLIC_BASE_URL=https://meet.example.test\nCOOKIE_SECRET=private-value\n')
            base = env.with_name('docker-compose.yml')
            base.write_text('services: {}')
            overlay = state / 'old-override.yml'
            overlay.write_text('services: {}')
            database = app / 'db/meetings.sqlite'
            database.parent.mkdir()
            import sqlite3
            with closing(sqlite3.connect(database)) as db:
                db.execute('create table meetings(status text)')
                db.commit()
            before = [{'Name': f'/babagan-meeting-{service}-1', 'Id': service + '-old',
                       'Image': 'sha256:' + service + '-old',
                       'Config': {'Image': service + ':old', 'Env': ['SECRET=private-value'],
                                  'Labels': {'com.docker.compose.project': 'babagan-meeting',
                                             'com.docker.compose.project.config_files': f'{base},{overlay}'}},
                       'State': {'Health': {'Status': 'healthy'}}} for service in updater.SERVICES]
            activated = False
            calls = []
            asset = b'candidate JavaScript'
            digest = hashlib.sha256(asset).hexdigest()
            def run(args, output=None, env=None):
                nonlocal activated
                calls.append(args)
                if args[:2] == ['docker', 'inspect']:
                    after = json.loads(json.dumps(before))
                    if activated:
                        after[1]['Id'] = 'web-new'
                        after[1]['Image'] = 'sha256:web-new'
                        if not web_only:
                            after[0]['Id'] = 'api-new'
                            after[0]['Image'] = 'sha256:api-new'
                    return json.dumps(after)
                if args[:3] == ['docker', 'volume', 'inspect']:
                    return str(database.parent)
                if 'get-url' in args:
                    return 'https://github.com/example/meeting.git'
                if args[:2] == ['git', 'clone']:
                    Path(args[-1]).mkdir()
                if 'rev-parse' in args:
                    return 'a' * 40
                if args[:1] == ['bash'] and args[1].endswith('rollback.sh'):
                    activated = False
                if args[:1] == ['bash'] and args[1].endswith('backup.sh'):
                    destination = Path(args[3])
                    destination.mkdir()
                    backup = destination / 'meetings.sqlite'
                    shutil.copyfile(database, backup)
                    checksum = hashlib.sha256(backup.read_bytes()).hexdigest()
                    (destination / 'meetings.sqlite.sha256').write_text(checksum + '  meetings.sqlite\n')
                    return 'Backup created: ' + str(backup)
                if args[:3] == ['docker', 'image', 'inspect']:
                    return 'sha256:api-new' if 'meeting-api:' in args[3] else 'sha256:web-new'
                if args[:2] == ['docker', 'exec']:
                    return digest + '  /srv/assets/index-new.js'
                if args[:2] == ['docker', 'compose'] and 'up' in args:
                    activated = True
                return ''
            def fetch(args):
                return b'<script type="module" src="/assets/index-new.js"></script>' if args[-1].endswith('/') else (b'stale public JavaScript' if mismatch else asset)
            options = SimpleNamespace(ref='main', commit=None, web_only=web_only, skip_cloudflare_smoke=False)
            with patch.object(updater, 'command', side_effect=run), patch.object(updater.subprocess, 'check_output', side_effect=fetch):
                if mismatch:
                    with self.assertRaisesRegex(RuntimeError, 'Public JavaScript'):
                        updater.perform_update(options, app, env, state)
                    self.assertFalse(activated)
                    self.assertTrue((state / 'update-pending.json').exists())
                    self.assertFalse((state / 'current-update.json').exists())
                    return
                updater.perform_update(options, app, env, state)
            record = json.loads((state / 'current-update.json').read_text())
            self.assertEqual(record['status'], 'deployed-and-verified')
            self.assertEqual(record['composeFiles'][:2], [str(base), str(overlay)])
            self.assertEqual(record['publicAssetSha256'], digest)
            self.assertTrue(Path(record['databaseBackup']).is_file())
            self.assertFalse((state / 'update-pending.json').exists())
            self.assertEqual(any(args[:3] == ['docker', 'run', '--rm'] for args in calls), not web_only)
            self.assertEqual(env.read_text(), 'PUBLIC_BASE_URL=https://meet.example.test\nCOOKIE_SECRET=private-value\n')
            self.assertNotIn('private-value', json.dumps(record))


if __name__ == '__main__':
    unittest.main()
