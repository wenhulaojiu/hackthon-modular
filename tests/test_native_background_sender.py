"""原生发送器纯合成测试；不导入helper、不连接微信、不读取真实聊天。"""

import copy
from contextlib import closing
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts" / "local-wechat"


def load_script(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sender = load_script("kexu_native_sender_synthetic", "native-background-sender.py")
shared = load_script("kexu_native_binding_synthetic", "selftest-sender.py")
SELF = "wxid_syntheticself"
TARGET = "wxid_synthetictarget"


class Clock:
    def __init__(self):
        self.value = 1800000000.0

    def __call__(self):
        return self.value

    def sleep(self, seconds):
        self.value += seconds


class FakeRuntime:
    def __init__(self):
        self.live = {"pid": 12345, "processCreated": "18000000000000000", "selfWxid": SELF}
        self.checks = 0
        self.invocations = []
        self.on_invoke = None
        self.completion = True

    def inspect_pid(self, pid, self_wxid):
        if pid != self.live["pid"]:
            sender.fail("PROCESS_UNVERIFIED")
        if self_wxid != self.live["selfWxid"]:
            sender.fail("LIVE_ACCOUNT_MISMATCH")
        return dict(self.live)

    def check(self, config):
        self.checks += 1
        # 复用真实创建时间比较逻辑，进程数据本身完全来自合成对象。
        sender.NativeRuntime.check(self, config)

    def invoke(self, config, chat_id, text):
        self.invocations.append((copy.deepcopy(config), chat_id, text))
        if self.on_invoke:
            self.on_invoke()
        return self.completion


class FakeReader:
    def __init__(self, fixture):
        self.fixture = fixture
        self.calls = 0
        self.baseline = []
        self.records = None
        self.on_baseline = None
        self.on_readback = None

    def read(self, start, end, timeout=10):
        self.calls += 1
        if self.calls == 1:
            if self.on_baseline:
                self.on_baseline()
            return copy.deepcopy(self.baseline)
        if self.on_readback:
            self.on_readback()
        return copy.deepcopy(self.records if self.records is not None else [self.fixture.record()])


class NativeSenderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kexu-native-sender-test-")
        self.root = Path(self.temp.name).resolve()
        self.private = self.root / ".local-wechat"
        self.private.mkdir()
        self.database = self.root / (SELF + "_a1b2") / "db_storage"
        self.database.mkdir(parents=True)
        self.token = "legacy@1"
        self.registry = {"version": 1, "activeId": "legacy", "revision": 1, "accounts": [{"id": "legacy", "dbDir": str(self.database)}]}
        self.write(self.private / "accounts.json", self.registry)
        self.write(self.private / "config.json", {"dbDir": str(self.database)})
        self.config_path = self.private / "native-sender/scopes/legacy/config.json"
        self.config = {"version": 1, "workspaceToken": self.token, "selfWxid": SELF, "pid": 12345, "processCreated": "18000000000000000", "enabled": True, "running": True, "settingsGeneration": 3, "allowedChatIds": [TARGET]}
        self.write_config()
        self.payload = {"workspaceToken": self.token, "chatId": TARGET, "text": "仅合成测试正文", "idempotencyKey": "synthetic-native-request", "generation": 3}
        self.clock = Clock()
        self.runtime = FakeRuntime()
        self.reader = FakeReader(self)
        # 只使用既有绑定逻辑，不载入网关、视觉依赖或第三方原生模块。
        self.binding_patch = patch.object(sender, "local_reader_module", return_value=types.SimpleNamespace(shared=shared))
        self.binding_patch.start()
        self.addCleanup(self.binding_patch.stop)
        self.connections = []
        original_connect = sqlite3.connect
        def tracked_connect(*args, **kwargs):
            connection = original_connect(*args, **kwargs)
            self.connections.append(connection)
            return connection
        # 在Windows中显式收尾合成数据库句柄，不依赖垃圾回收释放文件锁。
        self.connection_patch = patch.object(sender.sqlite3, "connect", side_effect=tracked_connect)
        self.connection_patch.start()
        self.addCleanup(self.connection_patch.stop)

    def tearDown(self):
        # 删除范围严格限于本测试创建的绝对临时目录。
        self.assertTrue(self.root.name.startswith("kexu-native-sender-test-"))
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        for connection in self.connections:
            connection.close()
        self.temp.cleanup()

    def write(self, filename, value):
        filename.parent.mkdir(parents=True, exist_ok=True)
        filename.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def write_config(self):
        self.write(self.config_path, self.config)

    def record(self, **changes):
        return {"nativeId": "99112233", "chatId": TARGET, "senderUsername": SELF, "localType": "1", "outbound": True, "timestamp": self.clock(), "textSha256": hashlib.sha256(self.payload["text"].encode("utf-8")).hexdigest(), **changes}

    def send(self, payload=None, module=sender, **options):
        return module.perform_send(self.root, self.token, self.config_path, payload or self.payload,
                                   runtime_factory=lambda _root: self.runtime,
                                   reader_factory=lambda _bound, _chat: self.reader,
                                   clock=self.clock, sleep=self.clock.sleep, readback_seconds=0.5, **options)

    def assert_code(self, code, callback):
        with self.assertRaises(Exception) as caught:
            callback()
        self.assertEqual(getattr(caught.exception, "code", None), code)

    def journal_row(self):
        with closing(sqlite3.connect(self.config_path.parent / "outbox.sqlite")) as database:
            return database.execute("SELECT status,native_id,code FROM outbox").fetchone()

    def test_exact_native_evidence_confirms_single_send(self):
        result = self.send()
        self.assertEqual(result["status"], "sent")
        self.assertTrue(result["readback"])
        self.assertEqual(result["messageId"], "99112233")
        self.assertEqual(result["chatId"], TARGET)
        self.assertEqual(len(self.runtime.invocations), 1)
        self.assertNotIn("text", result)
        self.assertEqual(self.journal_row(), ("sent", "99112233", None))

    def test_confirmed_request_is_persistent_across_module_reload(self):
        expected = self.send()
        fresh = load_script("kexu_native_sender_synthetic_restart", "native-background-sender.py")
        with patch.object(fresh, "local_reader_module", return_value=types.SimpleNamespace(shared=shared)):
            self.assertEqual(self.send(module=fresh), expected)
        self.assertEqual(len(self.runtime.invocations), 1)
        self.assertEqual(self.reader.calls, 2)

    def test_idempotency_key_cannot_be_reused_for_other_text_or_target(self):
        self.send()
        changed = {**self.payload, "text": "另一条正文"}
        self.assert_code("IDEMPOTENCY_CONFLICT", lambda: self.send(changed))
        self.config["allowedChatIds"].append("wxid_secondtarget")
        self.write_config()
        changed = {**self.payload, "chatId": "wxid_secondtarget"}
        self.assert_code("IDEMPOTENCY_CONFLICT", lambda: self.send(changed))
        self.assertEqual(len(self.runtime.invocations), 1)

    def test_database_binding_cross_checks_account_directory(self):
        bound = sender.bound_account(self.root, self.token)
        self.assertEqual(bound["selfWxid"], SELF)
        self.config["selfWxid"] = "wxid_wrongaccount"
        self.write_config()
        self.assert_code("ACCOUNT_UNVERIFIED", self.send)
        self.assertFalse(self.runtime.invocations)

    def test_active_account_or_revision_change_stops_before_native(self):
        self.registry["revision"] += 1
        self.write(self.private / "accounts.json", self.registry)
        self.assert_code("WORKSPACE_CHANGED", self.send)
        self.assertEqual(self.runtime.checks, 0)
        self.assertFalse(self.runtime.invocations)

    def test_live_account_mismatch_stops_before_native(self):
        self.runtime.live["selfWxid"] = "wxid_otherloggedin"
        self.assert_code("LIVE_ACCOUNT_MISMATCH", self.send)
        self.assertFalse(self.runtime.invocations)

    def test_bind_selects_only_matching_live_account(self):
        runtime = sender.NativeRuntime.__new__(sender.NativeRuntime)
        runtime.native = types.SimpleNamespace(wechat_candidates=lambda: [111, 222])
        def inspect(pid, self_wxid):
            self.assertEqual(self_wxid, SELF)
            if pid == 111:
                sender.fail("LIVE_ACCOUNT_MISMATCH")
            return {"pid": pid, "processCreated": "synthetic-created", "selfWxid": SELF}
        runtime.inspect_pid = inspect
        self.assertEqual(runtime.bind({"selfWxid": SELF})["pid"], 222)

    def test_bind_rejects_multiple_processes_for_same_account(self):
        runtime = sender.NativeRuntime.__new__(sender.NativeRuntime)
        runtime.native = types.SimpleNamespace(wechat_candidates=lambda: [111, 222])
        runtime.inspect_pid = lambda pid, own: {"pid": pid, "processCreated": "synthetic-created", "selfWxid": own}
        self.assert_code("WECHAT_ACCOUNT_NOT_UNIQUE", lambda: runtime.bind({"selfWxid": SELF}))

    def test_generation_must_be_exact_integer(self):
        self.config["settingsGeneration"] = True
        self.write_config()
        self.assert_code("SETTINGS_CHANGED", lambda: self.send({**self.payload, "generation": True}))
        self.assertFalse(self.runtime.invocations)

    def test_reused_pid_with_changed_process_creation_stops_before_native(self):
        self.runtime.live["processCreated"] = "18000000000000001"
        self.assert_code("PROCESS_CHANGED", self.send)
        self.assertFalse(self.runtime.invocations)

    def test_process_restart_after_invoke_remains_unknown_without_resend(self):
        self.runtime.on_invoke = lambda: self.runtime.live.update(processCreated="18000000000000001")
        result = self.send()
        self.assertEqual((result["status"], result["code"]), ("unknown", "PROCESS_CHANGED"))
        self.assertEqual(self.send(), result)
        self.assertEqual(len(self.runtime.invocations), 1)

    def test_unapproved_target_stops_before_native(self):
        self.assert_code("TARGET_NOT_ALLOWED", lambda: self.send({**self.payload, "chatId": "wxid_notallowed"}))
        self.assertFalse(self.runtime.invocations)

    def test_1023_byte_chinese_text_is_sent_without_truncation(self):
        self.payload["text"] = "中" * 341
        self.assertEqual(len(self.payload["text"].encode("utf-8")), 1023)
        self.assertEqual(self.send()["status"], "sent")
        self.assertEqual(self.runtime.invocations[0][2], self.payload["text"])

    def test_1024_byte_text_fails_before_runtime_or_journal(self):
        self.payload["text"] = "中" * 341 + "a"
        self.assert_code("TEXT_TOO_LONG", self.send)
        self.assertEqual(self.runtime.checks, 0)
        self.assertFalse(self.runtime.invocations)
        self.assertFalse((self.config_path.parent / "outbox.sqlite").exists())

    def test_wrong_native_sender_cannot_use_nickname_me_as_proof(self):
        self.reader.records = [self.record(senderUsername="wxid_other", sender="我")]
        result = self.send()
        self.assertEqual((result["status"], result["code"]), ("unknown", "READBACK_TIMEOUT"))
        self.assertFalse(result["readback"])

    def test_each_required_readback_field_is_enforced(self):
        cases = [{"nativeId": "0"}, {"nativeId": "synthetic"}, {"senderUsername": None}, {"localType": "3"}, {"localType": 1}, {"outbound": False}, {"chatId": "wxid_other"}, {"textSha256": "f" * 64}, {"timestamp": self.clock() - 1}]
        for changes in cases:
            with self.subTest(changes=changes):
                self.assertEqual(sender.matching_ids([self.record(**changes)], self.payload, SELF, set(), int(self.clock()), int(self.clock()) + 1), set())

    def test_preexisting_native_id_is_not_a_new_send(self):
        self.reader.baseline = [self.record()]
        result = self.send()
        self.assertEqual((result["status"], result["code"]), ("unknown", "READBACK_TIMEOUT"))

    def test_multiple_matching_new_ids_are_unknown_and_not_retried(self):
        self.reader.records = [self.record(), self.record(nativeId="99112234")]
        result = self.send()
        self.assertEqual((result["status"], result["code"]), ("unknown", "READBACK_AMBIGUOUS"))
        self.assertEqual(self.send(), result)
        self.assertEqual(len(self.runtime.invocations), 1)

    def test_native_false_completion_is_unknown_and_not_retried(self):
        self.runtime.completion = False
        result = self.send()
        self.assertEqual((result["status"], result["code"]), ("unknown", "NATIVE_COMPLETION_UNVERIFIED"))
        self.assertEqual(self.send(), result)
        self.assertEqual(len(self.runtime.invocations), 1)

    def test_native_exception_is_unknown_and_not_retried(self):
        def interrupt():
            raise OSError("合成原生调用中断")
        self.runtime.on_invoke = interrupt
        result = self.send()
        self.assertEqual((result["status"], result["code"]), ("unknown", "SEND_OR_READBACK_UNKNOWN"))
        self.assertEqual(self.send(), result)
        self.assertEqual(len(self.runtime.invocations), 1)

    def test_process_interrupt_leaves_committed_unknown_before_invoke(self):
        def crash():
            # 模拟工作进程在原生调用期间被中断，SQLite记录必须已提交。
            self.assertEqual(self.journal_row(), ("unknown", None, "SEND_INFLIGHT_OR_INTERRUPTED"))
            raise KeyboardInterrupt()
        self.runtime.on_invoke = crash
        with self.assertRaises(KeyboardInterrupt):
            self.send()
        result = self.send()
        self.assertEqual((result["status"], result["code"]), ("unknown", "SEND_INFLIGHT_OR_INTERRUPTED"))
        self.assertEqual(len(self.runtime.invocations), 1)

    def test_pause_while_reading_baseline_prevents_native_call(self):
        def pause():
            self.config["running"] = False
            self.write_config()
        self.reader.on_baseline = pause
        self.assert_code("SENDER_PAUSED", self.send)
        self.assertFalse(self.runtime.invocations)
        self.assertIsNone(self.journal_row())

    def test_generation_change_while_reading_baseline_prevents_native_call(self):
        def change():
            self.config["settingsGeneration"] += 1
            self.write_config()
        self.reader.on_baseline = change
        self.assert_code("SETTINGS_CHANGED", self.send)
        self.assertFalse(self.runtime.invocations)

    def test_pause_after_invoke_cannot_confirm_or_resend_after_resume(self):
        def pause():
            self.config["enabled"] = False
            self.write_config()
        self.runtime.on_invoke = pause
        result = self.send()
        self.assertEqual((result["status"], result["code"]), ("unknown", "SENDER_PAUSED"))
        self.config["enabled"] = True
        self.write_config()
        self.assertEqual(self.send(), result)
        self.assertEqual(len(self.runtime.invocations), 1)

    def test_generation_change_during_readback_cannot_confirm_or_resend(self):
        def change():
            self.config["settingsGeneration"] += 1
            self.write_config()
        self.reader.on_readback = change
        result = self.send()
        self.assertEqual((result["status"], result["code"]), ("unknown", "SETTINGS_CHANGED"))
        updated = {**self.payload, "generation": self.config["settingsGeneration"]}
        self.assertEqual(self.send(updated), result)
        self.assertEqual(len(self.runtime.invocations), 1)

    def test_native_invoke_requires_success_and_safe_unload(self):
        runtime = sender.NativeRuntime.__new__(sender.NativeRuntime)
        runtime.root = self.root
        replies = iter([{"success": True, "dll_unloaded": False}, {"success": False, "dll_unloaded": True}, {"success": True, "dll_unloaded": True}])
        calls = []
        def native_run(mode, **options):
            calls.append((mode, options))
            return next(replies)
        runtime.native = types.SimpleNamespace(run=native_run, TEXT_DLL=Path("synthetic-text.dll"))
        with patch.object(sender, "verify_artifacts", return_value=(self.root, {})) as verified:
            self.assertFalse(runtime.invoke(self.config, TARGET, self.payload["text"]))
            self.assertFalse(runtime.invoke(self.config, TARGET, self.payload["text"]))
            self.assertTrue(runtime.invoke(self.config, TARGET, self.payload["text"]))
            self.assertEqual(verified.call_count, 3)
        for mode, options in calls:
            self.assertEqual(mode, "--dispatch")
            self.assertIsNone(options["mentions"])
            self.assertFalse(options["keep_loaded"])
            self.assertFalse(options["preserve_report"])

    def test_journal_connection_is_closed_after_send(self):
        self.send()
        self.assertEqual(len(self.connections), 1)
        with self.assertRaises(sqlite3.ProgrammingError):
            self.connections[0].execute("SELECT 1")


if __name__ == "__main__":
    unittest.main()
