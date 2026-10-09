#!/usr/bin/env python3
"""Compile pinned OpenH264 to per-frame WASM, without host-architecture assembly.

Set --source to an exact clean OpenH264 checkout and --emsdk to activated 4.0.23.
Works on Windows and Linux without make, Docker, or a system compiler.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
LOCK = json.loads((ROOT / "media/codecs.lock.json").read_text())


def run(arguments, **kwargs):
    return subprocess.run([str(x) for x in arguments], check=True, **kwargs)


def build(source, emsdk, output, jobs):
    os.environ['EM_CONFIG'] = str(emsdk / '.emscripten')
    commit = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if commit != LOCK["openh264"]["commit"]:
        raise ValueError("OpenH264 commit does not match codecs.lock.json")
    if subprocess.check_output(["git", "-C", str(source), "status", "--porcelain"], text=True).strip():
        raise ValueError("OpenH264 checkout must be clean; apply patches explicitly through this build")
    emcc = emsdk / "upstream/emscripten/em++.py"
    sdk_commit = subprocess.check_output(['git', '-C', str(emsdk), 'rev-parse', 'HEAD'], text=True).strip()
    sdk_release = (emsdk / 'upstream/.emsdk_version').read_text().strip()
    if sdk_commit != LOCK['emsdk']['commit'] or not sdk_release.startswith(f"releases-{LOCK['emsdk']['release']}-"):
        raise ValueError('Installed emsdk commit/release does not match codecs.lock.json')
    run(['git', '-C', emsdk, 'diff', '--quiet', 'HEAD'])
    version = subprocess.check_output([sys.executable, str(emcc), "--version"], text=True)
    if f" {LOCK['emsdk']['version']} " not in version:
        raise ValueError("Emscripten version does not match codecs.lock.json")
    observed_toolchain = {'version': LOCK['emsdk']['version'], 'versionOutput': version.strip(),
                          'emsdkCommit': sdk_commit, 'sdkRelease': sdk_release,
                          'emccSha256': hashlib.sha256((emcc.parent / 'emcc.py').read_bytes()).hexdigest()}
    sources = []
    for unit in ["common", "encoder", "processing"]:
        targets = (source / f"codec/{unit}/targets.mk").read_text()
        sources.extend(source / f"codec/{unit}/{name}" for name in re.findall(r"\$\(\w+_SRCDIR\)/([A-Za-z0-9_/.+-]+\.cpp)", targets))
    sources.append(ROOT / "media/openh264/encoder.cpp")
    includes = ["api/wels", "common/inc", "encoder/core/inc", "encoder/plus/inc", "processing/interface",
                "processing/src/common", "processing/src/adaptivequantization", "processing/src/downsample",
                "processing/src/scrolldetection", "processing/src/vaacalc"]
    flags = ["-O3", "-flto", "-msimd128", "-std=c++17", "-DNDEBUG", "-fno-rtti"]
    flags.extend(f"-I{source / 'codec' / path}" for path in includes)
    output.mkdir(parents=True, exist_ok=True)
    exports = ["create", "create_video", "input", "encode", "output", "size", "key", "set_bitrate", "destroy"]
    for mode in ["single", "threads"]:
        object_dir = output / f".objects-{mode}"
        object_dir.mkdir(exist_ok=True)
        mode_flags = flags + (["-pthread"] if mode == "threads" else [])
        objects = [object_dir / f"{index}-{file.stem}.o" for index, file in enumerate(sources)]

        def compile_unit(pair):
            file, object_file = pair
            run([sys.executable, emcc, *mode_flags, "-c", file, "-o", object_file])

        with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as executor:
            list(executor.map(compile_unit, zip(sources, objects)))
        options = ["-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sENVIRONMENT=web,worker,node", "-sALLOW_MEMORY_GROWTH=1",
                   "-sINITIAL_MEMORY=67108864", "-sMAXIMUM_MEMORY=268435456", "-sSTACK_SIZE=1048576",
                   "-sEXPORTED_FUNCTIONS=" + json.dumps([f"_screen_{name}" for name in exports]),
                   '-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]', "-sFILESYSTEM=0"]
        if mode == "threads":
            # Four encode workers plus OpenH264's task-pool coordinator.
            options += ["-sPTHREAD_POOL_SIZE=5", "-sPTHREAD_POOL_SIZE_STRICT=2"]
        run([sys.executable, emcc, *mode_flags, *objects, *options, "-o", output / f"encoder-{mode}.mjs"])
        if not object_dir.resolve().is_relative_to(output.resolve()):
            raise ValueError('Refusing to delete object directory outside explicit output directory')
        shutil.rmtree(object_dir)
        print(f"Built OpenH264 {mode}", flush=True)
    shutil.copyfile(source / "LICENSE", output / "LICENSE")
    manifest = {"source": LOCK, "flags": [flag for flag in flags if not flag.startswith('-I')],
                "includePaths": [f"codec/{path}" for path in includes],
                "wrapperSha256": hashlib.sha256((ROOT / 'media/openh264/encoder.cpp').read_bytes()).hexdigest(),
                "toolchain": observed_toolchain, "releaseReady": False, "artifacts": {}}
    for file in sorted(output.iterdir()):
        if file.is_file() and file.name != "manifest.json":
            manifest["artifacts"][file.name] = {"bytes": file.stat().st_size, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--emsdk", required=True, type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/screen-codecs/openh264-2.6.0")
    parser.add_argument("--jobs", type=int, default=2)
    args = parser.parse_args()
    build(args.source.resolve(), args.emsdk.resolve(), args.output.resolve(), max(1, min(4, args.jobs)))
