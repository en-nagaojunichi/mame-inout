"""外部保管の世代管理と、削除済み情報を戻さない境界を検査する。"""

import base64
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
import shutil
import subprocess
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from operations_lib import OperationError, canonical, digest, secure_path, validate_ledger, validate_prefix, private_key_home
import operations

spec = importlib.util.spec_from_file_location("store", Path(__file__).resolve().parents[1] / "scripts/operations-store.py")
store = importlib.util.module_from_spec(spec)
spec.loader.exec_module(store)


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.installation = str(uuid.uuid4())
        self.first = {"sequence": 1, "operationId": str(uuid.uuid4()), "personId": str(uuid.uuid4()), "requestedAt": "2026-11-08T00:00:00.000Z"}
        self.ledger = {"format": 1, "deploymentId": self.installation, "generation": 1, "instructions": [self.first]}

    def test_prefix_accepts_new_instruction_without_dropping_previous(self):
        second = dict(self.first, sequence=2, operationId=str(uuid.uuid4()), personId=str(uuid.uuid4()))
        newer = dict(self.ledger, generation=2, instructions=[self.first, second])
        validate_prefix(newer, {"generation": 1, "plainSha256": digest(canonical(self.ledger))})

    def test_rolled_back_database_cannot_replace_external_latest(self):
        with self.assertRaises(OperationError):
            validate_prefix(self.ledger, {"generation": 2, "plainSha256": "a" * 64})

    def test_forked_database_is_rejected_even_if_generation_equal(self):
        with self.assertRaises(OperationError):
            validate_prefix(self.ledger, {"generation": 1, "plainSha256": "a" * 64})

    def test_missing_and_duplicated_sequences_rejected(self):
        cases = [dict(self.ledger, generation=2), dict(self.ledger, instructions=[dict(self.first, sequence=2)]),
                 dict(self.ledger, generation=2, instructions=[self.first, dict(self.first, sequence=2)])]
        for value in cases:
            with self.subTest(value=value), self.assertRaises(OperationError):
                validate_ledger(value)

    def test_unknown_fields_are_not_silently_retained(self):
        with self.assertRaises(OperationError):
            validate_ledger(dict(self.ledger, name="含めない氏名"))


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o700)
        self.deployment = str(uuid.uuid4())

    def tearDown(self):
        self.temporary.cleanup()

    def call(self, action, **payload):
        return store.operate(self.root, dict(payload, action=action, deploymentId=self.deployment, nonce="fresh-nonce"))

    def publish(self, generation, previous=None, text=b"encrypted-test-only"):
        return self.call("ledger-put", expectedLatest=previous, ciphertext=base64.b64encode(text).decode(),
                         metadata={"generation": generation, "plainSha256": str(generation) * 64, "cipherSha256": digest(text), "keyFingerprint": "A" * 40})

    def test_write_read_and_live_nonce(self):
        self.publish(0)
        result = self.call("ledger-get")
        self.assertEqual(result["nonce"], "fresh-nonce")
        self.assertEqual(result["latest"]["generation"], 0)
        self.assertEqual(base64.b64decode(result["ciphertext"]), b"encrypted-test-only")

    def test_compare_and_swap_rejects_race(self):
        self.publish(0)
        with self.assertRaises(ValueError):
            self.publish(1, None)
        self.assertEqual(self.call("ledger-get")["latest"]["generation"], 0)

    def test_old_generation_and_same_generation_fork_rejected(self):
        self.publish(2)
        with self.assertRaises(ValueError):
            self.publish(1, "2" * 64)
        request = dict(action="ledger-put", deploymentId=self.deployment, nonce="test", expectedLatest="2" * 64,
                       metadata={"generation": 2, "plainSha256": "a" * 64, "cipherSha256": digest(b"other"), "keyFingerprint": "A" * 40}, ciphertext=base64.b64encode(b"other").decode())
        with self.assertRaises(ValueError):
            store.operate(self.root, request)

    def test_retry_same_plaintext_keeps_existing_ciphertext(self):
        original = self.publish(0)
        retried = self.publish(0, "0" * 64, b"different-random-encryption")
        self.assertEqual(original["latest"], retried["latest"])

    def test_latest_pointer_rollback_stops_reads(self):
        older = self.publish(0)["latest"]
        self.publish(1, "0" * 64)
        store.atomic(self.root / self.deployment / "latest.json", store.encode(older))
        with self.assertRaises(ValueError):
            self.call("ledger-get")

    def test_crash_after_each_ledger_write_can_resume_without_returning_stale_latest(self):
        for phase in ("ciphertext", "generation", "latest"):
            with self.subTest(phase=phase):
                self.deployment = str(uuid.uuid4())
                self.publish(0)
                original = store.atomic
                failed = [False]
                def interrupted(path, data):
                    original(path, data)
                    matched = (phase == "ciphertext" and path.suffix == ".gpg" or phase == "generation" and path.name == "generation-1.json" or phase == "latest" and path.name == "latest.json")
                    if matched and not failed[0]:
                        failed[0] = True
                        raise OSError("simulated crash after durable write")
                with patch.object(store, "atomic", interrupted), self.assertRaises(OSError):
                    self.publish(1, "0" * 64)
                current = self.call("ledger-status")
                self.assertTrue(failed[0])
                if current["latest"]["generation"] == 0:
                    with self.assertRaises(ValueError):
                        self.call("ledger-get")
                    self.publish(1, "0" * 64)
                self.assertEqual(self.call("ledger-get")["latest"]["generation"], 1)

    def test_backup_pruning_preserves_deletion_ledger(self):
        self.publish(0)
        self.call("backup-put", backupId="backup-old", ciphertext=base64.b64encode(b"ciphertext").decode(), sha256=digest(b"ciphertext"))
        metadata_path = self.root / self.deployment / "backup-old.json"
        metadata = json.loads(metadata_path.read_bytes())
        metadata["createdAt"] = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat()
        store.atomic(metadata_path, store.encode(metadata))
        self.assertEqual(self.call("backup-prune", retentionDays=30)["deleted"], 1)
        self.assertFalse((metadata_path.with_suffix(".gpg")).exists())
        self.assertEqual(self.call("ledger-get")["latest"]["generation"], 0)

    def test_interrupted_backup_without_commit_metadata_is_not_returned_and_expires(self):
        original = store.atomic
        def interrupted(path, data):
            original(path, data)
            if path.name == "backup-orphan.gpg":
                raise OSError("simulated interruption")
        with patch.object(store, "atomic", interrupted), self.assertRaises(OSError):
            self.call("backup-put", backupId="backup-orphan", ciphertext=base64.b64encode(b"orphan").decode(), sha256=digest(b"orphan"))
        with self.assertRaises(ValueError):
            self.call("backup-get", backupId="backup-orphan")
        path = self.root / self.deployment / "backup-orphan.gpg"
        timestamp = (datetime.now(timezone.utc) - timedelta(days=31)).timestamp()
        os.utime(path, (timestamp, timestamp))
        self.assertEqual(self.call("backup-prune", retentionDays=30)["deleted"], 1)
        self.assertFalse(path.exists())

    def test_path_traversal_and_corrupt_blob_rejected(self):
        with self.assertRaises(ValueError):
            self.call("backup-get", backupId="../other")
        self.publish(0)
        latest = self.call("ledger-get")["latest"]
        store.atomic(self.root / self.deployment / latest["file"], b"changed")
        with self.assertRaises(ValueError):
            self.call("ledger-get")

    def test_hard_links_and_unsafe_permissions_rejected(self):
        self.publish(0)
        latest_file = self.root / self.deployment / "latest.json"
        os.link(latest_file, latest_file.with_name("copy"))
        with self.assertRaises(ValueError):
            self.call("ledger-get")
        os.chmod(self.root, 0o755)
        with self.assertRaises(ValueError):
            self.call("check")


class ResumeTests(unittest.TestCase):
    def test_documented_cli_without_B_does_not_modify_the_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "scripts"
            directory.mkdir()
            source = Path(__file__).resolve().parents[1] / "scripts"
            for name in ("operations.py", "operations_lib.py"):
                shutil.copyfile(source / name, directory / name)
            before = {path.relative_to(directory).as_posix(): path.read_bytes() for path in directory.rglob("*") if path.is_file()}
            environment = dict(os.environ)
            environment.pop("PYTHONDONTWRITEBYTECODE", None)
            environment.pop("PYTHONPYCACHEPREFIX", None)
            result = subprocess.run([sys.executable, str(directory / "operations.py"), "--help"],
                                    env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
            self.assertEqual(result.returncode, 0)
            after = {path.relative_to(directory).as_posix(): path.read_bytes() for path in directory.rglob("*") if path.is_file()}
            self.assertEqual(after, before)

    def test_unknown_database_is_not_granted_backup_permissions_or_stopped(self):
        with patch.object(operations, "schema_version", return_value=0), patch.object(operations, "roles") as roles, patch.object(operations, "compose") as compose:
            with self.assertRaises(OperationError):
                operations.backup({})
            roles.assert_not_called()
            compose.assert_not_called()

    def test_unbound_external_host_requires_configure_resume(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.json"
            value = {"format": 1, "project": "mame-inout-fixture", "release": "/release", "state": temporary,
                     "origin": "https://fixture.example.test", "port": 18086, "externalHost": "fixture", "externalRoot": "/store", "externalHostId": "", "ledgerPublicKey": "/key1", "backupPublicKey": "/key2"}
            path.write_bytes(canonical(value))
            os.chmod(path, 0o600)
            with self.assertRaisesRegex(OperationError, "configure"):
                operations.load(path)

    def test_private_key_agent_is_stopped_before_temporary_files_are_removed(self):
        with patch("operations_lib.subprocess.run") as command:
            with private_key_home() as home:
                self.assertTrue(Path(home).exists())
            self.assertFalse(Path(home).exists())
            self.assertEqual(command.call_args.args[0], ["gpgconf", "--homedir", home, "--kill", "gpg-agent"])

    def test_rotation_pending_skips_backup_with_old_secret(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            (state / "rotation-app.json").write_text(json.dumps({"old": base64.b64encode(b"a" * 48).decode(), "new": base64.b64encode(b"b" * 48).decode()}))
            os.chmod(state / "rotation-app.json", 0o600)
            with patch.object(operations, "backup") as backup, patch.object(operations, "compose"), patch.object(operations, "sql"), \
                 patch.object(operations, "client"), patch.object(operations, "atomic"), patch.object(operations, "container", return_value={"Id": "test"}), \
                 patch.object(operations, "run", side_effect=OperationError("old rejected")):
                operations.rotate({"state": temporary}, "app")
                backup.assert_not_called()

    def test_journal_refuses_changed_project_or_incomplete_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = {"state": temporary, "release": "/release-one", "project": "mame-inout-one"}
            operations.journal(config, "update")
            with self.assertRaises(OperationError):
                operations.journal(dict(config, release="/release-two"), "update")

    def test_symlink_secret_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            original = Path(temporary) / "original"
            original.write_bytes(b"secret-value-not-printed")
            os.chmod(original, 0o600)
            link = Path(temporary) / "link"
            link.symlink_to(original)
            with self.assertRaises(OperationError):
                secure_path(link)


if __name__ == "__main__":
    unittest.main()
