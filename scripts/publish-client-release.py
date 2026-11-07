#!/usr/bin/env python3
"""Publish signed Babagan client artifacts; Python 3.10+ and OpenSSL only."""

import argparse
import base64
import binascii
import contextlib
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import uuid


MAX_METADATA = 65536
MAX_ARTIFACT = 400_000_000
ORIGIN = "https://meet.babagan.cloud/downloads/clients/"
METADATA = ("release-manifest.json", "release-proof.json", "windows/stable.json",
            "android/stable.json", "catalog.json")


class ReleaseError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def fields(value, names, label):
    require(type(value) is dict and set(value) == set(names.split()), "Invalid " + label)


def integer(value, maximum=9007199254740991):
    return type(value) is int and 1 <= value <= maximum


def sha(data):
    return hashlib.sha256(data).hexdigest()


def parse_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate JSON key: " + key)
            result[key] = value
        return result
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=unique,
                          parse_constant=lambda _: (_ for _ in ()).throw(ReleaseError("Non-finite JSON number")))
    except (ValueError, UnicodeError, RecursionError) as error:
        raise ReleaseError("Invalid JSON") from error


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def same_json(left, right):
    return json.dumps(left, sort_keys=True, ensure_ascii=False) == json.dumps(right, sort_keys=True, ensure_ascii=False)


def b64(value, maximum):
    require(type(value) is str and 0 < len(value) <= maximum, "Invalid base64 length")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ReleaseError("Invalid base64") from error
    require(base64.b64encode(decoded).decode("ascii") == value, "Non-canonical base64")
    return decoded


def checked_path(path):
    """Reject symlinks, junctions and other reparse points on every ancestor."""
    path = Path(os.path.abspath(path))
    for item in reversed((path, *path.parents)):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        require(not stat.S_ISLNK(info.st_mode) and
                not (getattr(info, "st_file_attributes", 0) & 0x400),
                "Symlink/reparse point refused: " + str(item))
        if item != path:
            require(stat.S_ISDIR(info.st_mode), "Non-directory ancestor: " + str(item))
    return path


def child(root, relative):
    require(type(relative) is str and re.fullmatch(r"[A-Za-z0-9._/-]+", relative) is not None
            and all(part not in ("", ".", "..") for part in relative.split("/")), "Unsafe relative path")
    root = checked_path(root)
    path = checked_path(root.joinpath(*relative.split("/")))
    require(path != root and root in path.parents, "Path escapes root")
    return path


def regular_open(path):
    path = checked_path(path)
    require(stat.S_ISREG(path.lstat().st_mode), "Not a regular file: " + str(path))
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        require(stat.S_ISREG(os.fstat(descriptor).st_mode), "Not a regular file: " + str(path))
        return os.fdopen(descriptor, "rb")
    except BaseException:
        os.close(descriptor)
        raise


def read_metadata(path, limit=MAX_METADATA):
    with regular_open(path) as stream:
        data = stream.read(limit + 1)
    require(len(data) <= limit, "Metadata too large: " + str(path))
    return data


def artifact_metadata(value):
    require(type(value.get("sha256")) is str and re.fullmatch(r"[a-f0-9]{64}", value["sha256"]) is not None
            and integer(value.get("bytes"), MAX_ARTIFACT), "Invalid artifact hash/size")


def verify_file(path, metadata):
    digest, size = hashlib.sha256(), 0
    with regular_open(path) as stream:
        require(os.fstat(stream.fileno()).st_size == metadata["bytes"], "Artifact size mismatch: " + str(path))
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            require(size <= metadata["bytes"], "Artifact grew during verification")
            digest.update(chunk)
    require(size == metadata["bytes"] and digest.hexdigest() == metadata["sha256"],
            "Artifact hash/size mismatch: " + str(path))


def asn1(tag, data):
    length = len(data)
    raw = length.to_bytes((length.bit_length() + 7) // 8, "big")
    return bytes([tag]) + (bytes([length]) if length < 128 else bytes([128 + len(raw)]) + raw) + data


class Verifier:
    def __init__(self, key_path, openssl):
        key = parse_json(read_metadata(key_path))
        fields(key, "schema keyId algorithm spkiBase64 modulusBase64 exponentBase64", "public key")
        require(type(key["schema"]) is int and key["schema"] == 1 and key["algorithm"] == "RS256", "Unsupported public key")
        der, modulus, exponent = b64(key["spkiBase64"], 4096), b64(key["modulusBase64"], 1024), b64(key["exponentBase64"], 16)
        require(len(modulus) == 384 and modulus[0] >= 128 and modulus[-1] & 1 and exponent == b"\x01\x00\x01", "RSA-3072 / exponent 65537 required")
        rsa = asn1(0x30, asn1(2, b"\x00" + modulus) + asn1(2, exponent))
        expected = asn1(0x30, bytes.fromhex("300d06092a864886f70d0101010500") + asn1(3, b"\x00" + rsa))
        require(der == expected and key["keyId"] == "babagan-" + sha(der)[:16], "Public key identity mismatch")
        self.key_id, self.openssl = key["keyId"], openssl
        body = base64.b64encode(der).decode("ascii")
        self.pem = ("-----BEGIN PUBLIC KEY-----\n" + "\n".join(body[i:i+64] for i in range(0, len(body), 64)) + "\n-----END PUBLIC KEY-----\n").encode("ascii")

    def verify(self, data):
        envelope = parse_json(data)
        fields(envelope, "schema keyId payloadBase64 signatureBase64", "signed envelope")
        require(type(envelope["schema"]) is int and envelope["schema"] == 1 and envelope["keyId"] == self.key_id, "Unknown signing key/schema")
        payload = b64(envelope["payloadBase64"], 16384)
        signature = b64(envelope["signatureBase64"], 2048)
        require(len(signature) == 384, "Invalid RSA signature size")
        with tempfile.TemporaryDirectory(prefix="babagan-verify-") as directory:
            directory = Path(directory)
            (directory / "public.pem").write_bytes(self.pem)
            (directory / "signature").write_bytes(signature)
            (directory / "payload").write_bytes(payload)
            result = subprocess.run([self.openssl, "dgst", "-sha256", "-verify", str(directory / "public.pem"),
                                     "-signature", str(directory / "signature"), str(directory / "payload")],
                                    capture_output=True, timeout=30, check=False)
        require(result.returncode == 0, "Client release signature mismatch")
        return parse_json(payload)


def version(value):
    require(type(value) is str and len(value) <= 32 and re.fullmatch(r"\d+\.\d+\.\d+", value, re.ASCII) is not None, "Invalid version")
    return tuple(int(part) for part in value.split("."))


def validate_feed(payload, platform):
    fields(payload, "schema product platform channel sequence version releasedAt minHostProtocol artifact", "feed payload")
    require(type(payload["schema"]) is int and payload["schema"] == 1 and payload["product"] == "babagan-client"
            and payload["platform"] == platform and payload["channel"] == "stable" and integer(payload["sequence"])
            and type(payload["minHostProtocol"]) is int and payload["minHostProtocol"] == 1, "Invalid feed identity")
    version(payload["version"])
    require(type(payload["releasedAt"]) is str and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", payload["releasedAt"]) is not None, "Invalid release date")
    try:
        datetime.datetime.fromisoformat(payload["releasedAt"].replace("Z", "+00:00"))
    except ValueError as error:
        raise ReleaseError("Invalid release date") from error
    artifact = payload["artifact"]
    fields(artifact, "url sha256 bytes", "feed artifact")
    artifact_metadata(artifact)
    filename = "client.zip" if platform == "windows" else "Babagan.apk"
    require(artifact["url"] == ORIGIN + f"{platform}/{payload['version']}/{filename}", "Untrusted artifact URL/path")
    return payload


def prepare(source, verifier):
    metadata = {path: read_metadata(child(source, path)) for path in METADATA}
    manifest = verifier.verify(metadata["release-manifest.json"])
    fields(manifest, "schema product sequence source releases", "release manifest")
    require(type(manifest["schema"]) is int and manifest["schema"] == 1 and manifest["product"] == "babagan-client-release"
            and integer(manifest["sequence"]) and type(manifest["source"]) is str
            and re.fullmatch(r"(?:[a-f0-9]{40}|[a-f0-9]{64})", manifest["source"]) is not None, "Invalid release manifest identity")
    fields(manifest["releases"], "windows android", "manifest platforms")
    artifacts, feeds, catalog = [], {}, {"schema": 1, "releases": {}}
    for platform in ("windows", "android"):
        item = manifest["releases"][platform]
        fields(item, "version artifacts", "platform manifest")
        version(item["version"])
        filenames = ["client.zip", f"BabaganClientSetup-{item['version']}.exe"] if platform == "windows" else ["Babagan.apk"]
        require(type(item["artifacts"]) is list and len(item["artifacts"]) == len(filenames), "Invalid artifact list")
        expected = {f"{platform}/{item['version']}/{name}" for name in filenames}
        found = {}
        for artifact in item["artifacts"]:
            fields(artifact, "path sha256 bytes", "manifest artifact")
            artifact_metadata(artifact)
            require(type(artifact["path"]) is str and artifact["path"] in expected and artifact["path"] not in found, "Unexpected/duplicate artifact path")
            found[artifact["path"]] = artifact
            verify_file(child(source, artifact["path"]), artifact)
            artifacts.append(artifact)
        feed = validate_feed(verifier.verify(metadata[platform + "/stable.json"]), platform)
        require(feed["sequence"] == manifest["sequence"] and feed["version"] == item["version"], "Feed/manifest release mismatch")
        update_path = f"{platform}/{item['version']}/{filenames[0]}"
        require(feed["artifact"] == {"url": ORIGIN + update_path, "sha256": found[update_path]["sha256"], "bytes": found[update_path]["bytes"]}, "Feed/manifest artifact mismatch")
        installer_path = f"{platform}/{item['version']}/{filenames[-1]}"
        catalog["releases"][platform] = {"available": True, "version": item["version"], "url": "/downloads/clients/" + installer_path,
                                        "sha256": found[installer_path]["sha256"], "bytes": found[installer_path]["bytes"]}
        feeds[platform] = feed
    require(same_json(parse_json(metadata["catalog.json"]), catalog), "Catalog differs from signed installer metadata")
    proof = {"source": manifest["source"], "keyId": verifier.key_id, "sequence": manifest["sequence"],
             "versions": {p: feeds[p]["version"] for p in feeds},
             "signedFeedSha256": {p: sha(encoded(parse_json(metadata[p + "/stable.json"]))[:-1]) for p in feeds}}
    require(same_json(parse_json(metadata["release-proof.json"]), proof), "Release proof mismatch")
    return {"metadata": metadata, "manifest": manifest, "artifacts": artifacts, "feeds": feeds}


def fsync_directory(path):
    if os.name == "posix":
        descriptor = os.open(checked_path(path), os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def mkdir(path, mode=0o755):
    path = checked_path(path)
    if not path.exists():
        mkdir(path.parent, mode)
        path.mkdir(mode=mode, exist_ok=True)
        fsync_directory(path.parent)
    require(path.is_dir(), "Not a directory: " + str(path))
    checked_path(path)


def atomic_write(path, data, mode=0o644):
    path = checked_path(path)
    mkdir(path.parent)
    temporary = child(path.parent, "." + path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with os.fdopen(os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0), mode), "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        checked_path(path)
        os.replace(temporary, path)
        fsync_directory(path.parent)
    finally:
        if temporary.exists():
            checked_path(temporary).unlink()


@contextlib.contextmanager
def publication_lock(state):
    mkdir(state, 0o700)
    path = child(state, "publish.lock")
    if path.exists():
        require(stat.S_ISREG(path.lstat().st_mode), "Invalid publication lock")
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    stream = os.fdopen(descriptor, "r+b")
    acquired = False
    try:
        require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), "Invalid publication lock")
        if os.name == "nt":
            import msvcrt
            if os.fstat(stream.fileno()).st_size == 0:
                stream.write(b"0")
                stream.flush()
            stream.seek(0)
            try:
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as error:
                raise ReleaseError("Another client publisher holds the lock") from error
        else:
            import fcntl
            try:
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                raise ReleaseError("Another client publisher holds the lock") from error
        acquired = True
        yield
    finally:
        if acquired and os.name == "nt":
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        stream.close()


def archive_journal(state, suffix):
    mkdir(child(state, "history"), 0o700)
    target = child(state, "history/" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex + "-" + suffix + ".json")
    os.replace(child(state, "pending.json"), target)
    fsync_directory(target.parent)
    fsync_directory(state)


def recover(clients, state):
    pending = child(state, "pending.json")
    if not pending.exists():
        return False
    journal = parse_json(read_metadata(pending, MAX_METADATA * 10))
    fields(journal, "schema status previous", "publication journal")
    require(type(journal["schema"]) is int and journal["schema"] == 1 and journal["status"] in ("pending", "committed"), "Invalid publication journal")
    fields(journal["previous"], " ".join(METADATA), "journal paths")
    # Validate every stored path and backup before the first recovery write.
    backups = {path: None if data is None else b"" if data == "" else b64(data, MAX_METADATA * 2)
               for path, data in journal["previous"].items()}
    require(all(data is None or len(data) <= MAX_METADATA for data in backups.values()), "Oversized journal backup")
    for path in backups:
        child(clients, path)
    if journal["status"] == "committed":
        archive_journal(state, "committed")
        return False
    for path in reversed(METADATA):
        target, data = child(clients, path), backups[path]
        if data is None:
            if target.exists():
                require(target.is_file(), "Invalid recovery target")
                target.unlink()
                fsync_directory(target.parent)
        else:
            atomic_write(target, data)
    archive_journal(state, "rolled-back")
    return True


def check_destination(clients, release, verifier):
    for artifact in release["artifacts"]:
        target = child(clients, artifact["path"])
        if target.exists():
            verify_file(target, artifact)
    for path in METADATA:
        target = child(clients, path)
        if target.exists():
            read_metadata(target)
    for platform, feed in release["feeds"].items():
        current = child(clients, platform + "/stable.json")
        if current.exists():
            old_bytes = read_metadata(current)
            old = validate_feed(verifier.verify(old_bytes), platform)
            require(feed["sequence"] >= old["sequence"] and version(feed["version"]) >= version(old["version"]), "Release rollback refused")
            if feed["sequence"] == old["sequence"]:
                require(old_bytes == release["metadata"][platform + "/stable.json"], "Sequence reuse with changed feed refused")
    current_manifest = child(clients, "release-manifest.json")
    if current_manifest.exists():
        old = verifier.verify(read_metadata(current_manifest))
        require(integer(old.get("sequence")) and release["manifest"]["sequence"] >= old["sequence"], "Manifest sequence rollback refused")
        if release["manifest"]["sequence"] == old["sequence"]:
            require(old == release["manifest"], "Sequence reuse with changed manifest refused")


def copy_immutable(source, target, metadata):
    if target.exists():
        verify_file(target, metadata)
        return
    mkdir(target.parent)
    temporary = child(target.parent, "." + target.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        digest, size = hashlib.sha256(), 0
        with regular_open(source) as incoming, open(temporary, "xb") as output:
            while chunk := incoming.read(1024 * 1024):
                size += len(chunk)
                require(size <= metadata["bytes"], "Source artifact grew during copy")
                digest.update(chunk)
                output.write(chunk)
            require(size == metadata["bytes"] and digest.hexdigest() == metadata["sha256"], "Source artifact changed during copy")
            output.flush()
            os.fsync(output.fileno())
        checked_path(target)
        # Hard-link publication is atomic and cannot overwrite an existing version.
        try:
            os.link(temporary, target)
        except FileExistsError:
            verify_file(target, metadata)
        temporary.unlink()
        fsync_directory(target.parent)
    finally:
        if temporary.exists():
            checked_path(temporary).unlink()


def publish(source, downloads_root, key_path, openssl="openssl", dry_run=False, recover_only=False):
    downloads = checked_path(downloads_root)
    clients = child(downloads, "clients")
    state = checked_path(downloads.parent / ("." + downloads.name + "-client-publisher"))
    require(downloads != downloads.parent, "Downloads root cannot be a filesystem root")
    if recover_only:
        require(not dry_run, "--recover-only and --dry-run cannot be combined")
        with publication_lock(state):
            recovered = recover(clients, state)
        return {"recovered": recovered}
    require(source is not None, "Prepared client directory is required")
    source = checked_path(source)
    require(source != downloads and source not in downloads.parents and downloads not in source.parents,
            "Staging and downloads roots must not overlap")
    require(source != state and source not in state.parents and state not in source.parents,
            "Staging and publisher state must not overlap")
    verifier = Verifier(key_path, openssl)
    release = prepare(source, verifier)
    if dry_run:
        require(not child(state, "pending.json").exists(), "Interrupted publication exists; run --recover-only first")
        check_destination(clients, release, verifier)
        return {"dryRun": True, "sequence": release["manifest"]["sequence"], "artifacts": len(release["artifacts"])}
    with publication_lock(state):
        recover(clients, state)
        check_destination(clients, release, verifier)
        for artifact in release["artifacts"]:
            copy_immutable(child(source, artifact["path"]), child(clients, artifact["path"]), artifact)
        previous = {}
        for path in METADATA:
            target = child(clients, path)
            previous[path] = base64.b64encode(read_metadata(target)).decode("ascii") if target.exists() else None
        journal = {"schema": 1, "status": "pending", "previous": previous}
        atomic_write(child(state, "pending.json"), encoded(journal), 0o600)
        try:
            for path in METADATA:
                atomic_write(child(clients, path), release["metadata"][path])
            journal["status"] = "committed"
            atomic_write(child(state, "pending.json"), encoded(journal), 0o600)
        except BaseException:
            recover(clients, state)
            raise
        archive_journal(state, "committed")
    return {"published": True, "sequence": release["manifest"]["sequence"],
            "versions": {p: f["version"] for p, f in release["feeds"].items()}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prepared_clients", nargs="?", type=Path)
    parser.add_argument("--downloads-root", type=Path, default=Path("/opt/babagan-web-meeting/var/downloads"))
    parser.add_argument("--public-key", type=Path, default=Path(__file__).with_name("client-update-public-key.json"))
    parser.add_argument("--openssl", default="openssl")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--recover-only", action="store_true")
    args = parser.parse_args()
    try:
        result = publish(args.prepared_clients, args.downloads_root, args.public_key, args.openssl, args.dry_run, args.recover_only)
    except (ReleaseError, OSError, subprocess.SubprocessError) as error:
        print("Client publication failed: " + str(error), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
