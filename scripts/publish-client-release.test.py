#!/usr/bin/env python3
"""Isolated publication tests using a newly generated RSA fixture key, never the release key."""

import base64
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("publisher", Path(__file__).with_name("publish-client-release.py"))
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)
OPENSSL = os.environ.get("OPENSSL") or shutil.which("openssl")
if not OPENSSL and Path("C:/Program Files/Git/usr/bin/openssl.exe").is_file():
    OPENSSL = "C:/Program Files/Git/usr/bin/openssl.exe"


@unittest.skipUnless(OPENSSL, "OpenSSL required for real RSA signature tests")
class PublisherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys = tempfile.TemporaryDirectory(prefix="babagan-test-keys-")
        cls.private = Path(cls.keys.name) / "fixture-private.pem"
        subprocess.run([OPENSSL, "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:3072", "-out", str(cls.private)], check=True, capture_output=True)
        der = subprocess.run([OPENSSL, "pkey", "-in", str(cls.private), "-pubout", "-outform", "DER"], check=True, capture_output=True).stdout
        modulus = subprocess.run([OPENSSL, "rsa", "-in", str(cls.private), "-noout", "-modulus"], check=True, capture_output=True).stdout.decode().strip().split("=", 1)[1]
        cls.key = {"schema": 1, "keyId": "babagan-" + publisher.sha(der)[:16], "algorithm": "RS256",
                   "spkiBase64": base64.b64encode(der).decode(), "modulusBase64": base64.b64encode(bytes.fromhex(modulus)).decode(), "exponentBase64": "AQAB"}
        cls.key_path = Path(cls.keys.name) / "fixture-public.json"
        cls.key_path.write_bytes(publisher.encoded(cls.key))

    @classmethod
    def tearDownClass(cls):
        cls.keys.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="babagan-publish-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.downloads = self.root / "downloads"
        self.state = self.root / ".downloads-client-publisher"

    def sign(self, value):
        payload = publisher.encoded(value)[:-1]
        signature = subprocess.run([OPENSSL, "dgst", "-sha256", "-sign", str(self.private)], input=payload, check=True, capture_output=True).stdout
        return {"schema": 1, "keyId": self.key["keyId"], "payloadBase64": base64.b64encode(payload).decode(), "signatureBase64": base64.b64encode(signature).decode()}

    def stage(self, sequence=1, version="1.0.0", content=b"first", name=None, mutate_manifest=None, mutate_feed=None):
        source = self.root / (name or f"stage-{sequence}")
        source.mkdir()
        manifest = {"schema": 1, "product": "babagan-client-release", "sequence": sequence, "source": "a" * 40, "releases": {}}
        catalog, envelopes = {"schema": 1, "releases": {}}, {}
        for platform in ("windows", "android"):
            filenames = ["client.zip", f"BabaganClientSetup-{version}.exe"] if platform == "windows" else ["Babagan.apk"]
            artifacts = []
            for filename in filenames:
                path = f"{platform}/{version}/{filename}"
                data = platform.encode() + filename.encode() + content
                target = source / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                artifacts.append({"path": path, "sha256": publisher.sha(data), "bytes": len(data)})
            manifest["releases"][platform] = {"version": version, "artifacts": artifacts}
            feed = {"schema": 1, "product": "babagan-client", "platform": platform, "channel": "stable", "sequence": sequence,
                    "version": version, "releasedAt": "2026-11-07T00:00:00.000Z", "minHostProtocol": 1,
                    "artifact": {"url": publisher.ORIGIN + artifacts[0]["path"], "sha256": artifacts[0]["sha256"], "bytes": artifacts[0]["bytes"]}}
            if mutate_feed:
                mutate_feed(feed)
            envelope = self.sign(feed)
            (source / platform / "stable.json").write_bytes(publisher.encoded(envelope))
            envelopes[platform] = envelope
            catalog["releases"][platform] = {"available": True, "version": version, "url": "/downloads/clients/" + artifacts[-1]["path"],
                                            "sha256": artifacts[-1]["sha256"], "bytes": artifacts[-1]["bytes"]}
        if mutate_manifest:
            mutate_manifest(manifest)
        (source / "release-manifest.json").write_bytes(publisher.encoded(self.sign(manifest)))
        (source / "catalog.json").write_bytes(publisher.encoded(catalog))
        proof = {"source": "a" * 40, "keyId": self.key["keyId"], "sequence": sequence, "versions": {"windows": version, "android": version},
                 "signedFeedSha256": {p: publisher.sha(publisher.encoded(e)[:-1]) for p, e in envelopes.items()}}
        (source / "release-proof.json").write_bytes(publisher.encoded(proof))
        return source

    def publish(self, source, **kwargs):
        return publisher.publish(source, self.downloads, self.key_path, OPENSSL, **kwargs)

    def metadata(self):
        return {p: (self.downloads / "clients" / p).read_bytes() for p in publisher.METADATA}

    def test_publish_idempotent_preserves_legacy_and_runtime(self):
        self.downloads.mkdir()
        (self.downloads / "legacy.exe").write_bytes(b"legacy")
        (self.downloads / "runtime").mkdir()
        (self.downloads / "runtime" / "runtime.zip").write_bytes(b"runtime")
        source = self.stage()
        self.assertTrue(self.publish(source)["published"])
        self.assertEqual(self.metadata(), {p: (source / p).read_bytes() for p in publisher.METADATA})
        self.assertTrue(self.publish(source)["published"])
        self.assertEqual((self.downloads / "legacy.exe").read_bytes(), b"legacy")
        self.assertEqual((self.downloads / "runtime" / "runtime.zip").read_bytes(), b"runtime")
        self.assertFalse((self.state / "pending.json").exists())
        self.assertEqual(len(list((self.state / "history").glob("*.json"))), 2)

    def test_dry_run_creates_no_destination_or_state(self):
        self.assertTrue(self.publish(self.stage(), dry_run=True)["dryRun"])
        self.assertFalse(self.downloads.exists())
        self.assertFalse(self.state.exists())

    def test_signature_tampering_rejected_before_publication(self):
        source = self.stage()
        path = source / "windows/stable.json"
        envelope = publisher.parse_json(path.read_bytes())
        payload = publisher.parse_json(base64.b64decode(envelope["payloadBase64"]))
        payload["sequence"] = 20
        envelope["payloadBase64"] = base64.b64encode(publisher.encoded(payload)).decode()
        path.write_bytes(publisher.encoded(envelope))
        with self.assertRaisesRegex(publisher.ReleaseError, "signature mismatch"):
            self.publish(source)
        self.assertFalse(self.downloads.exists())
        self.assertFalse(self.state.exists())

    def test_unsigned_catalog_cannot_redirect_installer(self):
        source = self.stage()
        path = source / "catalog.json"
        catalog = publisher.parse_json(path.read_bytes())
        catalog["releases"]["windows"]["url"] = "https://evil.example/setup.exe"
        path.write_bytes(publisher.encoded(catalog))
        with self.assertRaisesRegex(publisher.ReleaseError, "Catalog differs"):
            self.publish(source)
        self.assertFalse(self.downloads.exists())

    def test_corrupt_artifact_rejected_before_publication(self):
        source = self.stage()
        (source / "windows/1.0.0/BabaganClientSetup-1.0.0.exe").write_bytes(b"malicious")
        with self.assertRaisesRegex(publisher.ReleaseError, "size mismatch"):
            self.publish(source)
        self.assertFalse(self.downloads.exists())

    def test_signed_unsafe_artifact_path_rejected(self):
        source = self.stage(mutate_manifest=lambda value: value["releases"]["windows"]["artifacts"][1].update(path="../escape.exe"))
        with self.assertRaisesRegex(publisher.ReleaseError, "artifact path"):
            self.publish(source)
        self.assertFalse(self.downloads.exists())

    def test_signed_untrusted_feed_url_rejected(self):
        source = self.stage(mutate_feed=lambda value: value["artifact"].update(url="https://evil.example/update"))
        with self.assertRaisesRegex(publisher.ReleaseError, "Untrusted artifact"):
            self.publish(source)

    def test_duplicate_json_keys_rejected(self):
        source = self.stage()
        path = source / "catalog.json"
        path.write_bytes(path.read_bytes().replace(b'{"schema":1', b'{"schema":1,"schema":1', 1))
        with self.assertRaisesRegex(publisher.ReleaseError, "Duplicate JSON key"):
            self.publish(source)

    def test_same_version_different_bytes_refused(self):
        self.publish(self.stage())
        before = self.metadata()
        with self.assertRaisesRegex(publisher.ReleaseError, "mismatch"):
            self.publish(self.stage(2, content=b"other"))
        self.assertEqual(self.metadata(), before)

    def test_sequence_or_version_rollback_refused(self):
        self.publish(self.stage(5, "2.0.0"))
        for sequence, version in ((4, "3.0.0"), (6, "1.0.0")):
            with self.subTest(sequence=sequence, version=version):
                with self.assertRaisesRegex(publisher.ReleaseError, "rollback refused"):
                    self.publish(self.stage(sequence, version))

    def test_changed_feed_cannot_reuse_sequence(self):
        self.publish(self.stage(1))
        source = self.stage(1, name="changed", mutate_feed=lambda value: value.update(releasedAt="2026-11-08T00:00:00Z"))
        with self.assertRaisesRegex(publisher.ReleaseError, "Sequence reuse"):
            self.publish(source)

    def test_feed_write_failure_rolls_back_all_metadata(self):
        self.publish(self.stage())
        before = self.metadata()
        next_release = self.stage(2, "2.0.0")
        original = publisher.atomic_write
        failed = False
        def fail_once(path, data, mode=0o644):
            nonlocal failed
            if Path(path) == self.downloads / "clients/android/stable.json" and not failed:
                failed = True
                raise OSError("Injected metadata write failure")
            return original(path, data, mode)
        with patch.object(publisher, "atomic_write", fail_once):
            with self.assertRaisesRegex(OSError, "Injected"):
                self.publish(next_release)
        self.assertTrue(failed)
        self.assertEqual(self.metadata(), before)
        self.assertTrue((self.downloads / "clients/windows/2.0.0/client.zip").is_file())
        self.assertFalse((self.state / "pending.json").exists())

    def test_failed_first_publish_restores_empty_legacy_metadata(self):
        clients = self.downloads / "clients"
        clients.mkdir(parents=True)
        (clients / "catalog.json").write_bytes(b"")
        (clients / "release-proof.json").write_bytes(b"")
        source = self.stage()
        original = publisher.atomic_write
        failed = False
        def fail_once(path, data, mode=0o644):
            nonlocal failed
            if Path(path) == clients / "android/stable.json" and not failed:
                failed = True
                raise OSError("Injected first publication failure")
            return original(path, data, mode)
        with patch.object(publisher, "atomic_write", fail_once):
            with self.assertRaisesRegex(OSError, "Injected"):
                self.publish(source)
        self.assertEqual((clients / "catalog.json").read_bytes(), b"")
        self.assertEqual((clients / "release-proof.json").read_bytes(), b"")
        self.assertFalse((clients / "windows/stable.json").exists())
        self.assertFalse((clients / "android/stable.json").exists())
        self.assertFalse((clients / "release-manifest.json").exists())
        self.assertFalse((self.state / "pending.json").exists())

    def test_process_interruption_leaves_recoverable_journal(self):
        self.publish(self.stage())
        before = self.metadata()
        source = self.stage(2, "2.0.0")
        code = """
import importlib.util, os, pathlib, sys
spec = importlib.util.spec_from_file_location('publisher', sys.argv[1])
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
original = p.atomic_write
def crash(path, data, mode=0o644):
    original(path, data, mode)
    if str(path).replace('\\\\', '/').endswith('/clients/windows/stable.json'):
        os._exit(73)
p.atomic_write = crash
p.publish(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4]), sys.argv[5])
"""
        result = subprocess.run([sys.executable, "-c", code, str(Path(publisher.__file__)), str(source), str(self.downloads), str(self.key_path), OPENSSL], capture_output=True)
        self.assertEqual(result.returncode, 73, result.stderr.decode(errors="replace"))
        self.assertTrue((self.state / "pending.json").exists())
        self.assertNotEqual(self.metadata(), before)
        with self.assertRaisesRegex(publisher.ReleaseError, "Interrupted publication"):
            self.publish(source, dry_run=True)
        self.assertTrue(self.publish(None, recover_only=True)["recovered"])
        self.assertEqual(self.metadata(), before)
        self.assertTrue(self.publish(source)["published"])

    def test_source_change_during_copy_never_switches_feeds(self):
        source = self.stage()
        original = publisher.copy_immutable
        def changed(incoming, target, metadata):
            incoming.write_bytes(b"replaced after validation")
            return original(incoming, target, metadata)
        with patch.object(publisher, "copy_immutable", changed):
            with self.assertRaisesRegex(publisher.ReleaseError, "changed|grew"):
                self.publish(source)
        self.assertFalse((self.downloads / "clients/windows/stable.json").exists())

    def test_publication_lock_refuses_competing_publisher(self):
        source = self.stage()
        with publisher.publication_lock(self.state):
            with self.assertRaisesRegex(publisher.ReleaseError, "holds the lock"):
                self.publish(source)
        self.assertFalse(self.downloads.exists())

    def test_source_inside_download_root_refused(self):
        source = self.stage()
        self.downloads.mkdir()
        nested = self.downloads / "staging"
        shutil.copytree(source, nested)
        with self.assertRaisesRegex(publisher.ReleaseError, "must not overlap"):
            self.publish(nested)

    def test_source_in_publisher_state_refused(self):
        source = self.stage()
        shutil.copytree(source, self.state)
        with self.assertRaisesRegex(publisher.ReleaseError, "publisher state must not overlap"):
            self.publish(self.state)
        self.assertFalse(self.downloads.exists())

    def test_symlink_or_junction_destination_refused(self):
        source = self.stage()
        self.downloads.mkdir()
        outside = self.root / "outside"
        outside.mkdir()
        link = self.downloads / "clients"
        if os.name == "nt":
            result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(outside)], capture_output=True)
            if result.returncode:
                self.skipTest("Cannot create a junction in this environment")
        else:
            link.symlink_to(outside, target_is_directory=True)
        self.addCleanup(lambda: link.rmdir() if os.name == "nt" and link.exists() else link.unlink(missing_ok=True))
        with self.assertRaisesRegex(publisher.ReleaseError, "Symlink/reparse"):
            self.publish(source)
        self.assertEqual(list(outside.iterdir()), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
