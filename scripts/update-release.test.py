import importlib.util
import json
from pathlib import Path
import tempfile
import shutil
import hashlib
import os
import sys
import subprocess
import sqlite3
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

    def test_api_rollback_is_blocked_for_each_open_status_without_losing_original_failure(self):
        for statuses in [('created',), ('active', 'active', 'active'), ('grace',)]:
            with self.subTest(statuses=statuses):
                self.run_active_room_rollback(web_only=False, statuses=statuses)

    def test_web_only_rollback_preserves_open_rooms_and_database(self):
        self.run_active_room_rollback(web_only=True, statuses=('active', 'created', 'grace'))

    def test_api_rollback_guard_allows_empty_or_terminal_only_database(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / 'meetings.sqlite'
            with closing(sqlite3.connect(database)) as db:
                db.execute('create table meetings(status text)')
                db.commit()
                updater.require_safe_rollback(['api', 'web'], database, lambda: None)
                db.executemany('insert into meetings values(?)', [('ended',), ('expired',)])
                db.commit()
                updater.require_safe_rollback(['api', 'web'], database, lambda: None)

    def test_rollback_guard_checks_configuration_before_database_for_both_update_modes(self):
        for selected in (['web'], ['api', 'web']):
            with self.subTest(selected=selected), patch.object(updater, 'require_no_meeting') as meeting_check:
                def changed():
                    raise RuntimeError('configuration changed')
                with self.assertRaisesRegex(RuntimeError, 'configuration changed'):
                    updater.require_safe_rollback(selected, Path('unused.sqlite'), changed)
                meeting_check.assert_not_called()

    def run_active_room_rollback(self, web_only, statuses):
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory)
            database = release / 'meetings.sqlite'
            with closing(sqlite3.connect(database)) as db:
                db.execute('create table meetings(status text)')
                db.commit()
            pending = release / 'pending.json'
            pending.write_text('{}')
            selected = ['web'] if web_only else ['api', 'web']
            original = RuntimeError('authenticated verification failed')
            calls = []
            snapshot = None
            def verify():
                nonlocal snapshot
                # Model real user rooms admitted after candidate activation.
                with closing(sqlite3.connect(database)) as db:
                    db.executemany('insert into meetings values(?)', [(status,) for status in statuses])
                    db.commit()
                snapshot = database.read_bytes()
                raise original
            with patch.object(updater, 'command', side_effect=lambda args, **kwargs: calls.append(args)), \
                    patch.object(updater, 'configuration_snapshot', return_value={}) as configuration, \
                    patch.object(updater, 'verify_containers') as restored:
                with self.assertRaises(RuntimeError) as raised:
                    updater.activate(['docker', 'compose'], selected, release / 'rollback.sh', verify, release,
                                     verify_rollback=lambda: restored(),
                                     rollback_guard=lambda: updater.require_safe_rollback(
                                         selected, database, lambda: configuration()))
            self.assertIs(raised.exception, original)
            configuration.assert_called_once()
            rollback_calls = [args for args in calls if args[0] == 'bash']
            self.assertEqual(len(rollback_calls), int(web_only))
            self.assertEqual(restored.call_count, int(web_only))
            self.assertEqual(database.read_bytes(), snapshot)
            self.assertTrue(pending.exists())
            with closing(sqlite3.connect(database)) as db:
                self.assertEqual(db.execute('select status from meetings').fetchall(), [(status,) for status in statuses])
            failure = json.loads((release / 'failure.json').read_text())
            self.assertEqual(failure['activationOrVerificationError'], str(original))
            self.assertEqual(failure['rollbackAttempted'], web_only)
            self.assertEqual(failure['applicationImagesRestored'], web_only)
            if not web_only:
                self.assertTrue(failure['rollbackBlocked'])
                self.assertIn('open meeting exists', failure['rollbackError'])
                self.assertIsNotNone(raised.exception.__cause__)

    @unittest.skipUnless(os.name == 'posix', 'full updater fixture requires POSIX mode-600 files')
    def test_complete_api_update_preserves_candidate_when_room_opens_during_verification(self):
        self.run_complete_update(web_only=False, scenario='meeting-during-verification')

    @unittest.skipUnless(os.name == 'posix', 'full updater fixture requires POSIX mode-600 files')
    def test_complete_web_update_rolls_back_when_room_opens_during_verification(self):
        self.run_complete_update(web_only=True, scenario='meeting-during-verification')

    def test_complete_web_update_records_backup_preserves_overlays_and_skips_api_migration(self):
        self.run_complete_update(web_only=True)

    def test_complete_api_update_migrates_and_keeps_media_containers(self):
        self.run_complete_update(web_only=False)

    @unittest.skipUnless(os.name == 'posix', 'full updater fixture requires POSIX mode-600 files')
    def test_api_environment_drift_refuses_before_build_backup_or_migration(self):
        self.run_complete_update(web_only=False, scenario='environment-drift')

    @unittest.skipUnless(os.name == 'posix', 'full updater fixture requires POSIX mode-600 files')
    def test_web_update_ignores_api_environment_drift(self):
        self.run_complete_update(web_only=True, scenario='environment-drift')

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

    def test_same_version_skips_backup_build_and_restart(self):
        self.run_complete_update(web_only=False, scenario='same')

    def test_unknown_legacy_provenance_refuses_to_guess_from_checkout(self):
        self.run_complete_update(web_only=False, scenario='unknown')

    def test_default_target_cannot_downgrade_running_feature_branch(self):
        self.run_complete_update(web_only=False, scenario='downgrade')

    def test_compose_change_during_build_refuses_activation(self):
        self.run_complete_update(web_only=False, scenario='config-change')

    def test_failed_restore_health_is_not_reported_as_restored(self):
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory)
            with patch.object(updater, 'command', return_value=''):
                with self.assertRaisesRegex(RuntimeError, 'both failed'):
                    updater.activate(['docker', 'compose'], ['web'], release / 'rollback.sh',
                                     lambda: (_ for _ in ()).throw(RuntimeError('public check failed')),
                                     release, verify_rollback=lambda: (_ for _ in ()).throw(RuntimeError('old web unhealthy')))
            self.assertFalse(json.loads((release / 'failure.json').read_text())['applicationImagesRestored'])

    def test_record_write_failure_keeps_previous_valid_record(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'record.json'
            updater.save(target, {'old': True})
            with patch.object(updater.os, 'replace', side_effect=OSError('disk failure')):
                with self.assertRaises(OSError):
                    updater.save(target, {'new': True})
            self.assertEqual(json.loads(target.read_text()), {'old': True})
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_failure_evidence_error_does_not_mask_primary_error(self):
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory)
            with patch.object(updater, 'command', return_value=''), patch.object(updater, 'save', side_effect=OSError('disk failure')):
                with self.assertRaisesRegex(RuntimeError, 'public check failed'):
                    updater.activate(['docker', 'compose'], ['web'], release / 'rollback.sh',
                                     lambda: (_ for _ in ()).throw(RuntimeError('public check failed')), release)

    def test_preflight_fails_early_for_missing_dependencies(self):
        with patch.object(updater.shutil, 'which', return_value=None), patch.object(updater, 'command') as run:
            with self.assertRaisesRegex(RuntimeError, 'required'):
                updater.preflight(Path('/tmp'))
            run.assert_not_called()

    def test_migration_failure_retains_pending_and_records_failed_stage(self):
        self.run_complete_update(web_only=False, scenario='migration-failure')

    def test_configuration_change_during_migration_stops_activation(self):
        self.run_complete_update(web_only=False, scenario='migration-change')

    def test_mixed_web_only_history_retains_api_version(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            before = [{'Name': '/babagan-meeting-' + service + '-1', 'Image': service + '-image'} for service in ('api', 'web')]
            updater.save(state / 'current-update.json', {
                'status': 'deployed-and-verified', 'commit': 'b' * 40, 'services': ['web'],
                'containers': [{'name': c['Name'], 'imageId': c['Image']} for c in before]})
            historical = state / 'update-20260101/release.json'
            historical.parent.mkdir()
            updater.save(historical, {'status': 'deployed-and-verified', 'commit': 'a' * 40,
                'services': ['api', 'web'], 'containers': [{'name': c['Name'], 'imageId': c['Image']} for c in before]})
            self.assertEqual(updater.running_commits(state, before, ['api', 'web']), {'api': 'a' * 40, 'web': 'b' * 40})
            (state / 'current-update.json').unlink()
            before[0]['Image'] = 'unrecorded-hotfix'
            with self.assertRaisesRegex(RuntimeError, 'provenance'):
                updater.running_commits(state, before, ['api'])

    def test_legacy_record_requires_matching_images_and_never_executes_shell(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            marker = state / 'must-not-exist'
            record = state / 'current-release.env'
            record.write_text('RELEASE_SHA=' + 'a' * 40 + '\nAPI_IMAGE_ID=api-image\nWEB_IMAGE_ID=web-image\nIGNORED=$(touch ' + str(marker) + ')\n')
            record.chmod(0o600)
            before = [{'Name': '/babagan-meeting-' + service + '-1', 'Image': service + '-image'} for service in ('api', 'web')]
            self.assertEqual(updater.running_commits(state, before, ['api']), {'api': 'a' * 40, 'web': 'a' * 40})
            self.assertFalse(marker.exists())
            before[0]['Image'] = 'hotfix'
            with self.assertRaisesRegex(RuntimeError, 'provenance'):
                updater.running_commits(state, before, ['api'])

    def test_real_git_ancestry_accepts_forward_rejects_old_or_divergent(self):
        with tempfile.TemporaryDirectory() as directory:
            origin = Path(directory) / 'origin'
            source = Path(directory) / 'source'
            subprocess.run(['git', 'init', '-q', str(origin)], check=True)
            git = lambda *args: subprocess.check_output(['git', '-C', str(origin), *args], text=True).strip()
            git('config', 'user.email', 'test@example.test')
            git('config', 'user.name', 'Test')
            git('commit', '--allow-empty', '-qm', 'base')
            base = git('rev-parse', 'HEAD')
            git('commit', '--allow-empty', '-qm', 'new')
            newer = git('rev-parse', 'HEAD')
            git('checkout', '-q', '--detach', base)
            git('commit', '--allow-empty', '-qm', 'other branch')
            divergent = git('rev-parse', 'HEAD')
            subprocess.run(['git', 'clone', '-q', str(origin), str(source)], check=True, capture_output=True)
            updater.require_forward_update(source, {'web': base}, newer, ['web'])
            for current, candidate in [(newer, base), (newer, divergent)]:
                with self.assertRaisesRegex(RuntimeError, 'downgrade'):
                    updater.require_forward_update(source, {'web': current}, candidate, ['web'])

    def test_rollback_verifies_old_images_and_preserves_nonselected_containers(self):
        before = [{'Name': '/babagan-meeting-' + service + '-1', 'Id': service, 'Image': service + '-old',
                   'State': {'Health': {'Status': 'healthy'}}} for service in ('web', 'api', 'coturn')]
        after = json.loads(json.dumps(before))
        after[0]['Id'] = 'recovered-web'
        updater.verify_containers(before, after, {'web': 'web-old'})
        after[0]['Image'] = 'wrong-image'
        with self.assertRaisesRegex(RuntimeError, 'candidate image'):
            updater.verify_containers(before, after, {'web': 'web-old'})
        after[0]['Image'] = 'web-old'
        after[2]['Id'] = 'replaced-coturn'
        with self.assertRaisesRegex(RuntimeError, 'unexpectedly replaced'):
            updater.verify_containers(before, after, {'web': 'web-old'})

    def test_rollback_is_refused_when_configuration_changed_after_activation(self):
        self.run_complete_update(web_only=True, scenario='post-activation-change')

    def test_backup_is_taken_after_build_before_migration(self):
        self.run_complete_update(web_only=False, scenario='backup-order')

    def test_service_replaced_during_smoke_is_not_recorded_as_success(self):
        self.run_complete_update(web_only=True, scenario='smoke-change')

    def test_preflight_reports_docker_resource_and_privilege_blockers(self):
        with patch.object(updater.shutil, 'which', return_value='/fake/tool'), patch.object(updater, 'command', return_value=''), patch.object(updater.os, 'geteuid', return_value=1):
            with self.assertRaisesRegex(RuntimeError, 'sudo'):
                updater.preflight(Path('/tmp'))
        with patch.object(updater.shutil, 'which', return_value='/fake/tool'), patch.object(updater, 'command', return_value=''), patch.object(updater.os, 'geteuid', return_value=0), patch.object(updater.shutil, 'disk_usage', return_value=SimpleNamespace(free=1)):
            with self.assertRaisesRegex(RuntimeError, '10 GiB'):
                updater.preflight(Path('/tmp'))
        with patch.object(updater.shutil, 'which', return_value='/fake/tool'), patch.object(updater, 'command', return_value=''), patch.object(updater.os, 'geteuid', return_value=0), patch.object(updater.shutil, 'disk_usage', return_value=SimpleNamespace(free=100 * 1024 ** 3)), patch.object(Path, 'read_text', return_value='MemAvailable: 100 kB'):
            with self.assertRaisesRegex(RuntimeError, 'memory'):
                updater.preflight(Path('/tmp'))

    def test_health_wait_is_bounded_and_missing_health_is_not_success(self):
        unhealthy = [{'State': {}}]
        with patch.object(updater.time, 'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError, '120 seconds'):
                updater.wait_healthy(lambda: unhealthy)
            self.assertEqual(sleep.call_count, 59)

    def run_complete_update(self, web_only, mismatch=False, scenario=None):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            state = app / 'var/releases'
            state.mkdir(parents=True)
            env = app / 'infra/.env.production'
            env.parent.mkdir()
            env.write_text('PUBLIC_BASE_URL=https://meet.example.test\nCOOKIE_SECRET=private-value\n')
            env.chmod(0o600)
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
            if scenario == 'environment-drift':
                # A prior API-only overlay is absent from the web Compose chain.
                before[0]['Config']['Env'].append('CLOUDFLARE_SFU_GATEWAY_TOKEN=' + 's' * 64)
            old_commit = 'b' * 40
            record = {'status': 'deployed-and-verified', 'commit': old_commit,
                      'services': ['api', 'web'], 'containers': updater.container_metadata(before)}
            if scenario == 'same':
                record['commit'] = 'a' * 40
            if scenario != 'unknown':
                updater.save(state / 'current-update.json', record)
            activated = False
            smoke_changed = False
            calls = []
            asset = b'candidate JavaScript'
            digest = hashlib.sha256(asset).hexdigest()
            def run(args, output=None, env=None):
                nonlocal activated, smoke_changed
                calls.append(args)
                if args[:2] == ['docker', 'compose'] and args[-3:] == ['config', '--format', 'json']:
                    return json.dumps({'services': {'api': {'environment': {'SECRET': 'private-value'}}}})
                if args[:3] == ['docker', 'image', 'inspect'] and args[-1] == '{{json .Config.Env}}':
                    self.assertEqual(args[3], 'sha256:api-old')
                    return '[]'
                if args[:2] == ['docker', 'inspect']:
                    after = json.loads(json.dumps(before))
                    if activated:
                        after[1]['Id'] = 'web-new'
                        after[1]['Image'] = 'sha256:web-new'
                        if not web_only:
                            after[0]['Id'] = 'api-new'
                            after[0]['Image'] = 'sha256:api-new'
                    if smoke_changed:
                        after[4]['Id'] = 'externally-replaced-coturn'
                    return json.dumps(after)
                if args[:3] == ['docker', 'volume', 'inspect']:
                    return str(database.parent)
                if 'get-url' in args:
                    return 'https://github.com/example/meeting.git'
                if args[:2] == ['git', 'clone']:
                    Path(args[-1]).mkdir()
                if 'rev-parse' in args:
                    return 'a' * 40
                if 'merge-base' in args:
                    return 'a' * 40 if scenario == 'downgrade' else old_commit
                if args[:2] == ['docker', 'build'] and scenario == 'config-change':
                    overlay.write_text('services: {api: {image: changed}}')
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
                if args[:1] == ['bash'] and args[1].endswith('deployment-smoke.sh') and scenario == 'smoke-change':
                    smoke_changed = True
                if args[:1] == ['bash'] and args[1].endswith('deployment-smoke.sh') and scenario == 'meeting-during-verification':
                    with closing(sqlite3.connect(database)) as db:
                        db.executemany('insert into meetings values(?)', [('created',), ('active',), ('grace',)])
                        db.commit()
                    raise RuntimeError('authenticated verification failed')
                if args[:3] == ['docker', 'run', '--rm'] and scenario == 'migration-failure':
                    raise RuntimeError('migration failed')
                if args[:3] == ['docker', 'run', '--rm'] and scenario == 'migration-change':
                    overlay.write_text('services: {api: {image: changed}}')
                if args[:2] == ['docker', 'exec']:
                    return digest + '  /srv/assets/index-new.js'
                if args[:2] == ['docker', 'compose'] and 'up' in args:
                    activated = True
                    if scenario == 'post-activation-change':
                        overlay.write_text('services: {api: {image: changed}}')
                return ''
            def fetch(args):
                return b'<script type="module" src="/assets/index-new.js"></script>' if args[-1].endswith('/') else (b'stale public JavaScript' if mismatch else asset)
            options = SimpleNamespace(ref='main', commit=None, web_only=web_only)
            with patch.object(updater, 'command', side_effect=run), patch.object(updater.subprocess, 'check_output', side_effect=fetch):
                if scenario == 'environment-drift' and not web_only:
                    with self.assertRaisesRegex(RuntimeError, 'CLOUDFLARE_SFU_GATEWAY_TOKEN') as raised:
                        updater.perform_update(options, app, env, state)
                    self.assertNotIn('s' * 64, str(raised.exception))
                    self.assertFalse(any(args[:2] == ['docker', 'build'] or args[:3] == ['docker', 'run', '--rm']
                                         or args[:1] == ['bash'] or args[:2] == ['git', 'clone'] for args in calls))
                    self.assertFalse(activated)
                    self.assertFalse((state / 'update-pending.json').exists())
                    return
                if scenario == 'meeting-during-verification':
                    with self.assertRaisesRegex(RuntimeError, '^authenticated verification failed$'):
                        updater.perform_update(options, app, env, state)
                    self.assertEqual(activated, not web_only)
                    rollback_calls = [args for args in calls if args[:1] == ['bash'] and args[1].endswith('rollback.sh')]
                    self.assertEqual(len(rollback_calls), int(web_only))
                    pending = json.loads((state / 'update-pending.json').read_text())
                    release = Path(pending['releaseDirectory'])
                    failure = json.loads((release / 'failure.json').read_text())
                    self.assertEqual(failure['error'], 'authenticated verification failed')
                    self.assertEqual(failure['activationOrVerificationError'], failure['error'])
                    self.assertEqual(failure['rollbackAttempted'], web_only)
                    self.assertEqual(failure['applicationImagesRestored'], web_only)
                    self.assertFalse(failure['databaseAutomaticallyRestored'])
                    if not web_only:
                        self.assertTrue(failure['rollbackBlocked'])
                        self.assertIn('open meeting exists', failure['rollbackError'])
                    with closing(sqlite3.connect(database)) as db:
                        self.assertEqual(db.execute('select status from meetings').fetchall(), [('created',), ('active',), ('grace',)])
                    with closing(sqlite3.connect(pending['databaseBackup'])) as db:
                        self.assertEqual(db.execute('select count(*) from meetings').fetchone()[0], 0)
                    self.assertEqual(json.loads((state / 'current-update.json').read_text())['commit'], old_commit)
                    self.assertTrue((release / 'override.yml').is_file())
                    return
                if scenario == 'smoke-change':
                    with self.assertRaisesRegex(RuntimeError, 'both failed'):
                        updater.perform_update(options, app, env, state)
                    self.assertEqual(json.loads((state / 'current-update.json').read_text())['commit'], old_commit)
                    self.assertTrue((state / 'update-pending.json').exists())
                    return
                if scenario == 'post-activation-change':
                    with self.assertRaisesRegex(RuntimeError, 'configuration changed'):
                        updater.perform_update(options, app, env, state)
                    self.assertTrue(activated)
                    self.assertFalse(any(args[:1] == ['bash'] and args[1].endswith('rollback.sh') for args in calls))
                    return
                if scenario in ('migration-failure', 'migration-change'):
                    with self.assertRaisesRegex(RuntimeError, 'migration failed|configuration'):
                        updater.perform_update(options, app, env, state)
                    self.assertFalse(activated)
                    self.assertTrue((state / 'update-pending.json').exists())
                    release = Path(json.loads((state / 'update-pending.json').read_text())['releaseDirectory'])
                    failure = json.loads((release / 'failure.json').read_text())
                    self.assertIn(failure['stage'], ('migration', 'activation-preflight'))
                    self.assertFalse(failure['databaseAutomaticallyRestored'])
                    return
                if scenario in ('unknown', 'downgrade', 'config-change'):
                    expected = {'unknown': 'provenance', 'downgrade': 'downgrade', 'config-change': 'configuration'}[scenario]
                    with self.assertRaisesRegex(RuntimeError, expected):
                        updater.perform_update(options, app, env, state)
                    self.assertFalse(activated)
                    self.assertFalse((state / 'update-pending.json').exists())
                    return
                if scenario == 'same':
                    updater.perform_update(options, app, env, state)
                    self.assertFalse(any(args[:2] == ['docker', 'build'] for args in calls))
                    self.assertFalse(any(args[:1] == ['bash'] and args[1].endswith('backup.sh') for args in calls))
                    self.assertFalse(activated)
                    return
                if mismatch:
                    with self.assertRaisesRegex(RuntimeError, 'Public JavaScript'):
                        updater.perform_update(options, app, env, state)
                    self.assertFalse(activated)
                    self.assertTrue((state / 'update-pending.json').exists())
                    self.assertEqual(json.loads((state / 'current-update.json').read_text())['commit'], old_commit)
                    return
                updater.perform_update(options, app, env, state)
            if scenario == 'backup-order':
                backup_index = next(i for i, args in enumerate(calls) if args[:1] == ['bash'] and args[1].endswith('backup.sh'))
                last_build = max(i for i, args in enumerate(calls) if args[:2] == ['docker', 'build'])
                migration_index = next(i for i, args in enumerate(calls) if args[:3] == ['docker', 'run', '--rm'])
                self.assertLess(last_build, backup_index)
                self.assertLess(backup_index, migration_index)
            record = json.loads((state / 'current-update.json').read_text())
            self.assertEqual(record['status'], 'deployed-and-verified')
            self.assertEqual(record['composeFiles'][:2], [str(base), str(overlay)])
            self.assertEqual(record['publicAssetSha256'], digest)
            self.assertTrue(Path(record['databaseBackup']).is_file())
            self.assertFalse((state / 'update-pending.json').exists())
            self.assertEqual(any(args[:3] == ['docker', 'run', '--rm'] for args in calls), not web_only)
            self.assertEqual(env.read_text(), 'PUBLIC_BASE_URL=https://meet.example.test\nCOOKIE_SECRET=private-value\n')
            self.assertNotIn('private-value', json.dumps(record))
            if web_only:
                self.assertFalse(any(args[-3:] == ['config', '--format', 'json'] or args[-1:] == ['{{json .Config.Env}}'] for args in calls))


class ApiEnvironmentGuardTests(unittest.TestCase):
    def check(self, environment, image, actual, selected=('api', 'web')):
        compose = ['docker', 'compose', '--env-file', '/protected/canonical.env', '-f', '/installed/web-chain.yml']
        api = {'Name': '/babagan-meeting-api-1', 'Image': 'sha256:immutable-api',
               'Config': {'Env': actual, 'Labels': {'com.docker.compose.project.config_files': '/old/api-only-overlay.yml'}}}
        def run(args):
            if args == compose + ['config', '--format', 'json']:
                return json.dumps({'services': {'api': {'environment': environment}}})
            if args == ['docker', 'image', 'inspect', api['Image'], '--format', '{{json .Config.Env}}']:
                return json.dumps(image)
            self.fail('Unexpected metadata command')
        with patch.object(updater, 'command', side_effect=run) as invoked:
            updater.require_api_environment(selected, compose, [api])
        return invoked

    def test_missing_api_only_overlay_token_is_rejected_without_exposing_its_value(self):
        secret = 's' * 64
        with self.assertRaises(RuntimeError) as raised:
            self.check({'PUBLIC_BASE_URL': 'https://meet.example.test'}, ['NODE_ENV=production'],
                       ['NODE_ENV=production', 'PUBLIC_BASE_URL=https://meet.example.test', 'CLOUDFLARE_SFU_GATEWAY_TOKEN=' + secret])
        self.assertIn('CLOUDFLARE_SFU_GATEWAY_TOKEN', str(raised.exception))
        self.assertNotIn(secret, str(raised.exception))
        self.assertNotIn('https://meet.example.test', str(raised.exception))

    def test_image_defaults_are_inherited_and_explicit_compose_values_override_them(self):
        self.check({'NODE_ENV': 'production', 'SECRET': 'part=one=two'},
                   ['PATH=/usr/local/bin:/usr/bin', 'NODE_ENV=development', 'SECRET=image-value'],
                   ['PATH=/usr/local/bin:/usr/bin', 'NODE_ENV=production', 'SECRET=part=one=two'])

    def test_explicit_null_unsets_the_image_default_and_bare_container_entry_is_not_a_value(self):
        self.check({'REMOVED': None, 'EMPTY': ''}, ['REMOVED=old-secret', 'EMPTY=image-default', 'INHERITED=keep'],
                   ['REMOVED', 'EMPTY=', 'INHERITED=keep'])
        with self.assertRaisesRegex(RuntimeError, 'REMOVED'):
            self.check({'REMOVED': None}, ['REMOVED=old-secret'], ['REMOVED=old-secret'])
        with self.assertRaisesRegex(RuntimeError, 'REMOVED'):
            self.check({'REMOVED': None}, ['REMOVED=old-secret'], [])

    def test_empty_value_and_absent_variable_are_different(self):
        with self.assertRaisesRegex(RuntimeError, 'EMPTY'):
            self.check({'EMPTY': ''}, [], ['EMPTY'])

    def test_all_changed_added_and_missing_variable_names_are_reported_without_values(self):
        with self.assertRaises(RuntimeError) as raised:
            self.check({'ADDED': 'candidate-secret', 'CHANGED': 'new-secret'}, [],
                       ['MISSING=old-secret', 'CHANGED=previous-secret'])
        self.assertIn('ADDED, CHANGED, MISSING', str(raised.exception))
        for value in ('candidate-secret', 'new-secret', 'old-secret', 'previous-secret'):
            self.assertNotIn(value, str(raised.exception))

    def test_web_only_does_not_read_or_compare_api_metadata(self):
        self.check({}, [], ['CLOUDFLARE_SFU_GATEWAY_TOKEN=private-value'], selected=['web']).assert_not_called()

    def test_invalid_metadata_fails_closed_without_echoing_secrets(self):
        with self.assertRaisesRegex(RuntimeError, '^Invalid rendered API environment metadata$'):
            self.check({'TOKEN': {'secret': 'private-value'}}, [], [])
        with self.assertRaisesRegex(RuntimeError, '^Invalid API environment metadata$'):
            self.check({}, {'secret': 'private-value'}, [])

    def test_duplicate_keys_fail_closed_without_exposing_values(self):
        with self.assertRaisesRegex(RuntimeError, '^Duplicate API environment variable: TOKEN$'):
            self.check({}, ['TOKEN=image-secret', 'TOKEN=second-secret'], [])
        with self.assertRaisesRegex(RuntimeError, '^Duplicate API environment variable: TOKEN$'):
            self.check({}, [], ['TOKEN=private-value', 'TOKEN'])


class CloudflareSfuComposeMigrationTests(unittest.TestCase):
    def test_api_override_exposes_sfu_credentials_and_unsets_retired_turn_keys(self):
        override = json.loads(updater.candidate_override({'api': 'candidate-api', 'web': 'candidate-web'}))
        environment = override['services']['api']['environment']
        self.assertEqual(environment['P2P_TURN_PROVIDER'], 'coturn')
        self.assertEqual(environment['CLOUDFLARE_SFU_APP_SECRET'], '${CLOUDFLARE_SFU_APP_SECRET:-}')
        self.assertEqual(environment['CLOUDFLARE_SFU_GATEWAY_URL'], '${CLOUDFLARE_SFU_GATEWAY_URL:-}')
        self.assertNotIn('CLOUDFLARE_SFU_API_PROXY_URL', environment)
        self.assertIsNone(environment['CLOUDFLARE_TURN_API_TOKEN'])
        self.assertIsNone(environment['CLOUDFLARE_TURN_HTTPS_PROXY'])
        self.assertEqual(override['services']['web'], {'image': 'candidate-web'})

    def test_web_only_override_does_not_reconfigure_api(self):
        override = json.loads(updater.candidate_override({'web': 'candidate-web'}))
        self.assertEqual(override, {'services': {'web': {'image': 'candidate-web'}}})

if __name__ == '__main__':
    unittest.main()
