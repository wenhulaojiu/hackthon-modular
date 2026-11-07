"""纯合成测试：不加载 UIA、不启动微信、不读取真实数据库。"""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "local-wechat" / "selftest-sender.py"
spec = importlib.util.spec_from_file_location("kexu_selftest_sender", SCRIPT)
sender = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sender)


class SelftestSenderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="kexu-selftest-synthetic-")
        self.root = Path(self.temporary.name).resolve()
        self.private = self.root / ".local-wechat"
        self.database = self.root / "synthetic-account" / "db_storage"
        self.private.mkdir()
        self.database.mkdir(parents=True)
        self.config = {"dbDir": str(self.database), "exporterRoot": str(self.root), "pythonPath": sys.executable}
        self.save("config.json", self.config)
        self.save("accounts.json", {"version": 1, "activeId": "legacy", "revision": 1, "accounts": [{"id": "legacy", "dbDir": str(self.database)}]})
        self.token = "legacy@1"
        self.prepared = sender.prepare(self.root, self.token)
        self.sends = 0
        self.reads = 0
        self.tick = 0

    def tearDown(self):
        # 临时目录由本测试创建，清理前再次核对名称，避免删除其他目录。
        self.assertTrue(self.root.name.startswith("kexu-selftest-synthetic-"))
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.temporary.cleanup()

    def save(self, name, value):
        (self.private / name).write_text(json.dumps(value), encoding="utf-8")

    def message(self, native_id="55", **changes):
        return {"nativeId": native_id, "chatId": "filehelper", "outbound": True, "textSha256": self.prepared["textSha256"], "timestamp": 123, **changes}

    def run_request(self, snapshots=None, verify_error=None, send_error=None):
        owner = self
        snapshots = snapshots if snapshots is not None else [[], [self.message()]]

        class Target:
            def __init__(self, _profile):
                pass

            def verify(self):
                if verify_error:
                    raise verify_error

            def send_once(self, text, check_binding):
                check_binding()
                owner.assertEqual(text, owner.prepared["marker"])
                owner.sends += 1
                if send_error:
                    raise send_error

        class Reader:
            def __init__(self, _bound):
                pass

            def read(self, _start, _end, **_kwargs):
                owner.reads += 1
                return snapshots[min(owner.reads - 1, len(snapshots) - 1)]

        def sleep(seconds):
            self.tick += max(seconds, 0.1)

        return sender.execute(self.root, self.token, self.prepared["id"], {}, timeout=1, reader_factory=Reader, target_factory=Target, monotonic=lambda: self.tick, sleep=sleep)

    def test_prepare_has_generated_marker_and_rejects_custom_chat(self):
        self.assertRegex(self.prepared["marker"], r"^客序自测 \d{8}T\d{6}Z-[a-f0-9]{8}$")
        self.assertEqual(self.prepared["status"], "prepared")
        self.assertEqual(self.prepared["chatId"], "filehelper")
        self.assertNotEqual(sender.prepare(self.root, self.token)["marker"], self.prepared["marker"])
        with self.assertRaises(sender.SelftestError) as raised:
            sender.prepare(self.root, self.token, "wxid_customer")
        self.assertEqual(raised.exception.code, "FILEHELPER_ONLY")
        self.assertNotIn("pywinauto", sys.modules)

    def test_native_id_hash_direction_and_chat_all_match_then_sent_once(self):
        baseline = self.message("11")
        result = self.run_request([[baseline], [baseline, self.message("22", outbound=False), self.message("33", chatId="wxid_customer"), self.message("44", textSha256="bad"), self.message()]])
        self.assertEqual(result["status"], "sent")
        self.assertEqual(result["nativeMessageId"], "55")
        self.assertEqual(self.sends, 1)
        repeated = self.run_request()
        self.assertEqual(repeated["status"], "sent")
        self.assertTrue(repeated["duplicate"])
        self.assertEqual(self.sends, 1)
        self.assertEqual(self.reads, 2)

    def test_timeout_is_unknown_and_never_retries(self):
        result = self.run_request([[], []])
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["code"], "READBACK_TIMEOUT")
        self.assertFalse(result["automaticRetry"])
        self.run_request()
        self.assertEqual(self.sends, 1)

    def test_ambiguous_native_ids_are_unknown(self):
        result = self.run_request([[], [self.message("55"), self.message("56")]])
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["code"], "READBACK_AMBIGUOUS")
        self.run_request()
        self.assertEqual(self.sends, 1)

    def test_uia_failure_is_closed_without_reading_or_sending(self):
        result = self.run_request(verify_error=sender.SelftestError("UIA_UNVERIFIED", "合成不可验证控件"))
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["code"], "UIA_UNVERIFIED")
        self.assertEqual(self.sends, 0)
        self.assertEqual(self.reads, 0)

    def test_send_exception_is_unknown_and_journal_was_inflight_first(self):
        original = sender.binding(self.root, self.token)
        journal_file = self.private / "selftest-sender" / "legacy" / "journal.json"

        class BrokenTarget:
            def __init__(self, _profile):
                pass

            def verify(self):
                pass

            def send_once(inner, _text, _check):
                state = json.loads(journal_file.read_text(encoding="utf-8"))
                self.assertEqual(state["requests"][self.prepared["id"]]["status"], "inflight")
                self.sends += 1
                raise TimeoutError("合成 UI 超时")

        class Reader:
            def __init__(self, _bound):
                pass

            def read(self, *_args, **_kwargs):
                return []

        result = sender.execute(self.root, self.token, self.prepared["id"], {}, reader_factory=Reader, target_factory=BrokenTarget)
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(sender.binding(self.root, self.token)["scope"], original["scope"])
        self.run_request()
        self.assertEqual(self.sends, 1)

    def test_interrupted_inflight_becomes_unknown_without_ui(self):
        bound = sender.binding(self.root, self.token)
        with sender.journal(bound) as (state, persist):
            state["requests"][self.prepared["id"]]["status"] = "inflight"
            persist()
        result = self.run_request()
        self.assertEqual(result["code"], "INTERRUPTED_NO_RETRY")
        self.assertTrue(result["duplicate"])
        self.assertEqual(self.sends, 0)
        self.assertEqual(self.reads, 0)

    def test_stale_token_binding_drift_and_tampered_text_fail_before_ui(self):
        with self.assertRaises(sender.SelftestError):
            sender.execute(self.root, "legacy@2", self.prepared["id"], {})
        self.save("config.json", {**self.config, "dbDir": str(self.root / "wrong" / "db_storage")})
        with self.assertRaises(sender.SelftestError):
            self.run_request()
        self.save("config.json", self.config)
        with sender.journal(sender.binding(self.root, self.token)) as (state, persist):
            state["requests"][self.prepared["id"]]["text"] = "任意营销正文应被拒绝"
            persist()
        with self.assertRaises(sender.SelftestError):
            self.run_request()
        self.assertEqual(self.sends, 0)

    def test_dependencies_cli_is_read_only_and_custom_text_argument_is_rejected(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "dependencies"], capture_output=True, text=True, encoding="utf-8", check=False)
        self.assertEqual(result.returncode, 0)
        result = json.loads(result.stdout)
        self.assertFalse(result["canSend"])
        self.assertFalse(result["gatewayRegistered"])
        bad = subprocess.run([sys.executable, str(SCRIPT), "prepare", "--text", "不允许正文"], capture_output=True, check=False)
        self.assertNotEqual(bad.returncode, 0)

    def empty_history_result(self, **changes):
        diagnostic = {"status": "needs_selection", "reason": "未找到名称完全一致且在本机有消息表的会话：filehelper；请使用 --list-chats 搜索，再用 --chat 传入准确会话 ID", "query": "filehelper", "candidates": [], **changes}
        return subprocess.CompletedProcess([], 2, stdout=b"", stderr=json.dumps(diagnostic, ensure_ascii=False).encode("utf-8"))

    def test_empty_history_requires_exact_structure_and_verified_exporter(self):
        result = self.empty_history_result()
        self.assertTrue(sender.exact_empty_helper_history(result, True))
        self.assertFalse(sender.exact_empty_helper_history(result, False))
        for change in ({"query": "wxid_customer"}, {"candidates": [{"username": "filehelper"}]}, {"reason": "其他读取失败"}, {"extra": True}):
            self.assertFalse(sender.exact_empty_helper_history(self.empty_history_result(**change), True))
        self.assertFalse(sender.exact_empty_helper_history(subprocess.CompletedProcess([], 1, stdout=b"", stderr=result.stderr), True))
        self.assertFalse(sender.exact_empty_helper_history(subprocess.CompletedProcess([], 2, stdout=b"{}", stderr=result.stderr), True))

    def test_pinned_reader_allows_empty_only_for_baseline(self):
        script = self.root / "scripts" / "export_wechat.py"
        script.parent.mkdir()
        script.write_text("# 纯合成占位文件，不执行。\n", encoding="utf-8")
        bound = sender.binding(self.root, self.token)
        with self.assertRaises(sender.SelftestError):
            sender.ExporterReader(bound)
        with patch.object(sender, "EXPORTER_SHA256", sender.sha(script.read_text(encoding="utf-8"))):
            reader = sender.ExporterReader(bound)
        with patch.object(sender.subprocess, "run", return_value=self.empty_history_result()) as mocked:
            self.assertEqual(reader.read(1, 2, allow_empty_history=True), [])
            with self.assertRaises(sender.SelftestError) as raised:
                reader.read(1, 2)
            self.assertEqual(raised.exception.code, "READBACK_UNAVAILABLE")
            self.assertEqual(mocked.call_count, 2)

    def test_empty_baseline_followed_by_unavailable_readback_is_unknown_never_sent(self):
        owner = self

        class Target:
            def __init__(self, _profile):
                pass

            def verify(self):
                pass

            def send_once(self, _text, check_binding):
                check_binding()
                owner.sends += 1

        class Reader:
            def __init__(self, _bound):
                pass

            def read(self, *_args, allow_empty_history=False, **_kwargs):
                if allow_empty_history:
                    return []
                raise sender.SelftestError("READBACK_UNAVAILABLE", "合成发送后仍无本地记录")

        result = sender.execute(self.root, self.token, self.prepared["id"], {}, reader_factory=Reader, target_factory=Target)
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["code"], "READBACK_UNAVAILABLE")
        self.assertNotIn("nativeMessageId", result)
        self.run_request()
        self.assertEqual(self.sends, 1)


if __name__ == "__main__":
    unittest.main()
