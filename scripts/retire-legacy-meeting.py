"""Stop the confirmed retired 121.199.0.146 stack, preserving data and rollback."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import sqlite3
import subprocess

EXPECTED_HOST = 'izbp12bqhlxygnar6ocw63z'
APP = Path('/opt/babagan-meeting')
NAMES = ['babagan-meeting-' + s + '-1' for s in ['api', 'web', 'caddy', 'livekit', 'coturn']]

def run(args):
    result = subprocess.run(args, text=True, capture_output=True, timeout=120)
    if result.returncode: raise RuntimeError(args[0] + ' failed; inspect the retirement record')
    return result.stdout.strip()

def main():
    assert os.geteuid() == 0 and socket.gethostname().lower() == EXPECTED_HOST, 'Wrong target host'
    os.umask(0o077)
    before = json.loads(run(['docker', 'inspect', *NAMES]))
    for item in before:
        assert item['Config']['Labels']['com.docker.compose.project'] == 'babagan-meeting'
        assert item['State']['Running'], 'Inspect partially stopped stack before continuing'
    api = next(x for x in before if x['Name'] == '/babagan-meeting-api-1')
    assert Path(api['Config']['Labels']['com.docker.compose.project.working_dir']).resolve().is_relative_to(APP)
    code = """import {RoomServiceClient} from 'livekit-server-sdk';
const e=process.env;const c=new RoomServiceClient(e.LIVEKIT_INTERNAL_URL.replace(/^ws/,'http'),e.LIVEKIT_API_KEY,e.LIVEKIT_API_SECRET);
const rooms=await c.listRooms();console.log(JSON.stringify({rooms:rooms.length,participants:rooms.reduce((n,r)=>n+r.numParticipants,0)}));"""
    online = json.loads(run(['docker', 'exec', '-w', '/app', NAMES[0], 'node', '--input-type=module', '-e', code]))
    assert online['participants'] == 0, 'Participants are still connected'
    data = next(x for x in api['Mounts'] if x['Destination'] == '/data')
    database = Path(data['Source']) / 'meetings.sqlite'
    assert database.is_file()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    record = Path('/root') / ('babagan-retirement-' + stamp); record.mkdir(mode=0o700)
    safe = [{'name': x['Name'], 'id': x['Id'], 'image': x['Image'], 'restart': x['HostConfig']['RestartPolicy']} for x in before]
    (record / 'before.json').write_text(json.dumps({'containers': safe, 'online': online, 'dataVolume': data['Name']}, indent=2))
    with sqlite3.connect(database) as source, sqlite3.connect(record / 'meetings.sqlite') as target:
        source.backup(target)
        assert target.execute('pragma integrity_check').fetchone()[0] == 'ok'
    files = api['Config']['Labels']['com.docker.compose.project.config_files'].split(',')
    env = APP / 'infra/.env.production'
    if env.is_file(): files.append(str(env))
    for i, name in enumerate(files):
        path = Path(name).resolve(); assert path.is_relative_to(APP) and path.is_file()
        shutil.copyfile(path, record / (str(i) + '-' + path.name))
    restore = ['#!/bin/bash', 'set -euo pipefail', '# Update authentication before using this retired deployment again.']
    for item in before:
        policy = item['HostConfig']['RestartPolicy']; value = policy['Name'] or 'no'
        if value == 'on-failure' and policy.get('MaximumRetryCount'): value += ':' + str(policy['MaximumRetryCount'])
        restore.append(shlex.join(['docker', 'update', '--restart=' + value, item['Name'].lstrip('/')]))
    restore.append(shlex.join(['docker', 'start', *NAMES]))
    (record / 'restore.sh').write_text('\n'.join(restore) + '\n'); (record / 'restore.sh').chmod(0o700)
    others = run(['docker', 'ps', '-q']).splitlines()
    other_ids = set(others) - {x['Id'][:12] for x in before}
    # Prevent a meeting from being admitted between the final check and API stop.
    with sqlite3.connect(database, timeout=10) as admission:
        admission.execute('BEGIN IMMEDIATE')
        assert admission.execute("select count(*) from meetings where status in ('created','active','grace')").fetchone()[0] == 0, 'An open meeting exists'
        run(['docker', 'update', '--restart=no', *NAMES])
        run(['docker', 'stop', '--time', '30', NAMES[0]])
        admission.rollback()
    run(['docker', 'stop', '--time', '30', *NAMES[1:]])
    after = json.loads(run(['docker', 'inspect', *NAMES]))
    assert all(not x['State']['Running'] and x['HostConfig']['RestartPolicy']['Name'] == 'no' for x in after)
    assert other_ids <= set(run(['docker', 'ps', '-q']).splitlines()), 'An unrelated container changed'
    run(['docker', 'volume', 'inspect', data['Name']])
    result = {'target': '121.199.0.146', 'status': 'retired-and-preserved', 'stopped': NAMES,
              'automaticRestart': False, 'databasePreserved': database.is_file(), 'volumePreserved': True,
              'backupSha256': hashlib.sha256((record / 'meetings.sqlite').read_bytes()).hexdigest(),
              'restoreScript': str(record / 'restore.sh'), 'verifiedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    (record / 'result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))

if __name__ == '__main__': main()
