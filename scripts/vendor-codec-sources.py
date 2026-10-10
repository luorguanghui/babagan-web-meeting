#!/usr/bin/env python3
"""Package verified corresponding sources alongside local codec artifacts."""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import json
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent.parent
RELEASE_SHA256 = 'ec718371836fdfe00b455c8a34c826cfbcf9b72e35cc75b0bc5c739900ad3f01'


def package(archive, source):
    if hashlib.sha256(archive.read_bytes()).hexdigest() != RELEASE_SHA256:
        raise ValueError('libav release archive hash mismatch')
    lock = json.loads((ROOT / 'media/codecs.lock.json').read_text())
    head = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if head != lock['openh264']['commit']:
        raise ValueError('OpenH264 source commit mismatch')
    for codec in ['libav-6.10.9', 'openh264-2.6.0']:
        output = ROOT / 'artifacts/screen-codecs' / codec
        sources = output / 'sources'
        sources.mkdir(parents=True, exist_ok=True)
        if codec.startswith('libav'):
            with zipfile.ZipFile(archive) as release:
                prefix = 'libav.js-6.10.9.0/sources/'
                for member in release.infolist():
                    if not member.filename.startswith(prefix) or member.is_dir():
                        continue
                    relative = PurePosixPath(member.filename[len(prefix):])
                    if relative.is_absolute() or '..' in relative.parts:
                        raise ValueError('Unsafe release source path')
                    target = sources.joinpath(*relative.parts).resolve()
                    if not target.is_relative_to(sources.resolve()):
                        raise ValueError('Source path escaped package directory')
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(release.read(member))
            shutil.copyfile(ROOT / 'scripts/prepare-libav-codecs.mjs', sources / 'project-binding-patch.mjs')
        else:
            # Binary test clips are not build inputs or library source. Include
            # all codec/build sources and upstream notices without those clips.
            subprocess.run(['git', '-C', str(source), 'archive', '--format=tar.gz', '-o', str(sources / 'openh264-2.6.0.tar.gz'),
                            head, 'codec', 'build', 'Makefile', 'meson.build', 'LICENSE', 'README.md'], check=True)
            shutil.copyfile(ROOT / 'media/openh264/encoder.cpp', sources / 'project-encoder.cpp')
            shutil.copyfile(ROOT / 'scripts/build-screen-codecs.py', sources / 'build-screen-codecs.py')
            shutil.copyfile(ROOT / 'media/codecs.lock.json', sources / 'codecs.lock.json')
        manifest_path = output / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['sources'] = {str(file.relative_to(output)).replace('\\', '/'): {
            'bytes': file.stat().st_size, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()
        } for file in sorted(sources.rglob('*')) if file.is_file()}
        manifest['releaseReady'] = True
        manifest['releaseSourcesArchiveSha256'] = RELEASE_SHA256 if codec.startswith('libav') else None
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        print(f'Packaged {codec} corresponding sources', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--openh264-source', required=True, type=Path)
    args = parser.parse_args()
    package(args.archive.resolve(), args.openh264_source.resolve())
