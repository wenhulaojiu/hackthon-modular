"""文件传输助手发送自测原型；默认仅说明依赖，不启动或控制微信。

依赖：Windows、Python 3.11+、pywinauto（UIA 后端）、pywin32，以及现有只读导出器环境。
不注册发送网关，不声明 canSend，不支持客户会话或任意正文。
workspaceToken 仅证明本地数据工作区，不能证明微信界面当前登录账号。
微信 4.1 没有预置已验收的 UIA 配置；无法取得稳定 filehelper 容器身份时必须拒绝发送。
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import uuid


EXPORTER_SHA256 = "e98528025a274623702128d822909c01a79ceee5d864084edb1882f6e666554e"
CHAT_ID = "filehelper"
TERMINAL = {"sent", "unknown", "failed"}


class SelftestError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fail(code, message):
    raise SelftestError(code, message)


def sha(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def read_json(filename, limit=256_000):
    filename = Path(filename)
    if filename.is_symlink() or not filename.is_file() or filename.stat().st_size > limit:
        fail("PRIVATE_FILE_INVALID", "本地私有配置无法安全读取。")
    with filename.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def inside(parent, child):
    parent, child = Path(parent).resolve(), Path(child).resolve()
    return parent != child and parent in child.parents


def binding(root, expected):
    root = Path(root).resolve()
    private = root / ".local-wechat"
    if not inside(root, private):
        fail("PRIVATE_DIRECTORY_INVALID", "本地配置目录越过工作区。")
    registry = read_json(private / "accounts.json")
    scope, separator, revision = expected.partition("@")
    if not re.fullmatch(r"legacy|acct-[a-f0-9]{20}", scope) or not separator or not re.fullmatch(r"[1-9][0-9]*", revision):
        fail("WORKSPACE_CHANGED", "工作区标识无效，请重新核对账号。")
    if registry.get("version") != 1 or registry.get("pending") or registry.get("activeId") != scope or registry.get("revision") != int(revision):
        fail("WORKSPACE_CHANGED", "本地工作区已切换；未启动发送。")
    accounts = [item for item in registry.get("accounts", []) if item.get("id") == scope]
    config = read_json(private / "config.json")
    if len(accounts) != 1 or not accounts[0].get("dbDir") or not config.get("dbDir"):
        fail("ACCOUNT_UNBOUND", "请先明确绑定微信数据目录。")
    database = Path(config["dbDir"]).resolve()
    if database != Path(accounts[0]["dbDir"]).resolve() or database.name.lower() != "db_storage" or not database.is_dir():
        fail("BINDING_CHANGED", "数据读取目录与工作区绑定不一致。")
    return {"root": root, "private": private, "scope": scope, "token": expected, "config": config, "dbDir": database}


@contextmanager
def journal(bound):
    directory = bound["private"] / "selftest-sender" / bound["scope"]
    directory.mkdir(parents=True, exist_ok=True)
    if not inside(bound["private"], directory):
        fail("PRIVATE_DIRECTORY_INVALID", "自测日志目录越过本地配置目录。")
    lockfile = directory / "journal.lock"
    if lockfile.is_symlink():
        fail("JOURNAL_INVALID", "自测锁文件无法安全读取。")
    lock = lockfile.open("a+b")
    locked = False
    try:
        if lock.tell() == 0:
            lock.write(b"\0")
            lock.flush()
            os.fsync(lock.fileno())
        lock.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except OSError:
            fail("SELFTEST_BUSY", "另一个自测进程正在运行，未重复执行。")
        filename = directory / "journal.json"
        state = read_json(filename, 2_000_000) if filename.exists() else {"version": 1, "requests": {}}
        if state.get("version") != 1 or not isinstance(state.get("requests"), dict) or len(state["requests"]) > 1000:
            fail("JOURNAL_INVALID", "自测日志格式异常，未覆盖原日志。")

        def persist():
            temporary = directory / (".journal-" + uuid.uuid4().hex + ".tmp")
            try:
                with temporary.open("x", encoding="utf-8", newline="\n") as handle:
                    json.dump(state, handle, ensure_ascii=False, separators=(",", ":"))
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                if filename.is_symlink():
                    fail("JOURNAL_INVALID", "自测日志不能是符号链接。")
                os.replace(temporary, filename)
            finally:
                temporary.unlink(missing_ok=True)
        yield state, persist
    finally:
        if locked:
            lock.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


def marker(request_id, created):
    parsed = datetime.fromisoformat(created)
    return "客序自测 " + parsed.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.UUID(request_id).hex[:8]


def valid_request(record, request_id, bound):
    try:
        valid = record["id"] == str(uuid.UUID(request_id)) and record["scope"] == bound["scope"] and record["chatId"] == CHAT_ID and record["text"] == marker(request_id, record["createdAt"]) and record["textSha256"] == sha(record["text"]) and record["status"] in {"prepared", "inflight", *TERMINAL}
    except (KeyError, ValueError, TypeError):
        valid = False
    if not valid:
        fail("JOURNAL_INVALID", "自测请求身份或固定正文校验失败，未启动发送。")


def public_result(record, duplicate=False):
    return {key: record[key] for key in ("id", "chatId", "status", "textSha256", "code", "nativeMessageId") if key in record} | {"duplicate": duplicate, "automaticRetry": False, "accountProof": "workspace-only; operator must confirm the UI account"}


def prepare(root, token, chat_id=CHAT_ID):
    if chat_id != CHAT_ID:
        fail("FILEHELPER_ONLY", "此原型只允许文件传输助手。")
    bound = binding(root, token)
    with journal(bound) as (state, persist):
        if len(state["requests"]) >= 1000:
            fail("JOURNAL_FULL", "自测日志已满，请先人工备份。")
        request_id = str(uuid.uuid4())
        created = datetime.now(timezone.utc).isoformat(timespec="seconds")
        text = marker(request_id, created)
        record = {"id": request_id, "scope": bound["scope"], "workspaceToken": token, "chatId": CHAT_ID, "createdAt": created, "text": text, "textSha256": sha(text), "status": "prepared"}
        state["requests"][request_id] = record
        persist()
        return public_result(record) | {"marker": text, "workspaceToken": token, "message": "只生成了唯一短测试标记，尚未控制微信或发送。"}


def native_messages(data, start, end):
    metadata = data.get("metadata", {})
    messages = data.get("messages")
    if metadata.get("chat_username") != CHAT_ID or metadata.get("chat_type") != "private" or not isinstance(messages, list) or len(messages) > 1500 or metadata.get("message_count") != len(messages):
        fail("READBACK_UNVERIFIED", "读取结果不是可核验的文件传输助手记录。")
    if any(metadata.get(key) is not False for key in ("source_modified", "keys_saved", "plaintext_database_saved")):
        fail("READBACK_UNVERIFIED", "只读保护标记不完整。")
    if datetime.fromisoformat(metadata.get("range_start_inclusive", "")).timestamp() != start or datetime.fromisoformat(metadata.get("range_end_exclusive", "")).timestamp() != end:
        fail("READBACK_UNVERIFIED", "读取时间范围与自测不一致。")
    output = []
    for item in messages:
        timestamp = item.get("timestamp")
        text = item.get("content")
        if item.get("chat_username") != CHAT_ID or not isinstance(timestamp, (float, int)) or not start <= timestamp < end or not isinstance(text, str) or len(text) > 8000:
            fail("READBACK_UNVERIFIED", "回读消息的会话、时间或格式无效。")
        native_id = str(item.get("server_id", ""))
        if re.fullmatch(r"[0-9]{1,40}", native_id) and int(native_id) > 0:
            output.append({"chatId": CHAT_ID, "nativeId": native_id, "outbound": item.get("sender") == "我", "textSha256": sha(text), "timestamp": timestamp})
    return output


class ExporterReader:
    def __init__(self, bound):
        self.bound = bound
        self.script = Path(bound["config"]["exporterRoot"]) / "scripts" / "export_wechat.py"
        script_bytes = self.script.read_bytes()
        if len(script_bytes) > 2_000_000 or hashlib.sha256(script_bytes.replace(b"\r\n", b"\n")).hexdigest() != EXPORTER_SHA256:
            fail("EXPORTER_UNVERIFIED", "只读导出器未匹配已核验版本。")

    def read(self, start, end, timeout=20):
        binding(self.bound["root"], self.bound["token"])
        parent = self.bound["private"] / "selftest-sender" / self.bound["scope"]
        with tempfile.TemporaryDirectory(prefix="readback-", dir=parent) as temporary:
            folder = Path(temporary).resolve()
            if not inside(parent, folder):
                fail("PRIVATE_DIRECTORY_INVALID", "自测读取临时目录越界。")
            iso = lambda value: datetime.fromtimestamp(value, timezone(timedelta(hours=8))).isoformat(timespec="seconds")
            command = [self.bound["config"]["pythonPath"], "-B", str(self.script), "--chat", CHAT_ID, "--start", iso(start), "--end", iso(end), "--output-root", str(folder), "--db-dir", str(self.bound["dbDir"])]
            result = subprocess.run(command, cwd=self.bound["config"]["exporterRoot"], capture_output=True, timeout=max(0.1, min(20, timeout)), check=False, env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
            if result.returncode or len(result.stdout) > 256_000:
                fail("READBACK_UNAVAILABLE", "文件传输助手只读回读未完成。")
            summary = json.loads(result.stdout.decode("utf-8"))
            if summary.get("status") != "complete" or summary.get("chat_username") != CHAT_ID:
                fail("READBACK_UNVERIFIED", "导出器没有确认唯一的文件传输助手会话。")

            def verified_file(key, maximum):
                filename = Path(summary[key]).resolve()
                if not inside(folder, filename) or not filename.is_file() or filename.stat().st_size > maximum:
                    fail("READBACK_UNVERIFIED", "回读文件位置或大小无效。")
                return filename.read_bytes()

            raw = verified_file("json_file", 1_500_000)
            plain = verified_file("text_file", 1_500_000)
            validation = json.loads(verified_file("validation_file", 65536).decode("utf-8"))
            if validation.get("status") != "passed" or validation.get("json_sha256") != hashlib.sha256(raw).hexdigest() or validation.get("text_sha256") != hashlib.sha256(plain).hexdigest() or validation.get("json_bytes") != len(raw) or validation.get("text_bytes") != len(plain):
                fail("READBACK_UNVERIFIED", "回读文件完整性校验失败。")
            data = json.loads(raw.decode("utf-8"))
            if validation.get("message_count") != len(data.get("messages", [])) or summary.get("messages") != len(data.get("messages", [])):
                fail("READBACK_UNVERIFIED", "回读消息数量不一致。")
            return native_messages(data, start, end)


class WindowsUIATarget:
    """只认实际暴露 filehelper AutomationId 的会话容器；没有该证据时明确拒绝。"""

    def __init__(self, profile):
        if os.name != "nt":
            fail("UIA_UNSUPPORTED", "此自测原型只支持 Windows UIA。")
        if profile.get("version") != 1 or profile.get("conversationAutomationId") != CHAT_ID or profile.get("containerControlType") not in {"Pane", "Group"} or not re.fullmatch(r"4\.1\.\d+\.\d+", str(profile.get("wechatVersion", ""))) or not all(isinstance(profile.get(key), str) and 0 < len(profile[key]) <= 160 for key in ("windowClass", "editorAutomationId", "sendButtonAutomationId")):
            fail("UIA_UNVERIFIED", "缺少经过本机验收的微信版本与稳定 filehelper 容器配置。")
        # 仅在显式 execute 路径延迟载入；导入本脚本和 prepare 不会接触 Windows UI。
        from pywinauto import Desktop
        import win32api
        import win32con
        import win32process
        self.profile, self.desktop = profile, Desktop(backend="uia")
        self.api, self.constants, self.process = win32api, win32con, win32process
        self.proof = None

    @staticmethod
    def one(items):
        if len(items) != 1 or not items[0].is_visible() or not items[0].is_enabled():
            fail("UIA_UNVERIFIED", "微信控件缺失、不可用或不唯一，未调用发送。")
        return items[0]

    def inspect(self, expected_draft=""):
        p = self.profile
        candidates = []
        for window in self.desktop.windows(class_name=p["windowClass"]):
            handle = self.api.OpenProcess(self.constants.PROCESS_QUERY_INFORMATION | self.constants.PROCESS_VM_READ, False, window.process_id())
            try:
                executable = self.process.GetModuleFileNameEx(handle, 0)
                if Path(executable).name.lower() != "weixin.exe":
                    continue
                version = self.api.GetFileVersionInfo(executable, "\\")
                actual = ".".join(str(value) for value in (version["FileVersionMS"] >> 16, version["FileVersionMS"] & 65535, version["FileVersionLS"] >> 16, version["FileVersionLS"] & 65535))
                if actual == p["wechatVersion"]:
                    candidates.append(window)
            finally:
                handle.Close()
        window = self.one(candidates)
        if window.is_minimized():
            fail("UIA_UNVERIFIED", "请人工打开并核对文件传输助手；原型不会自动还原或导航微信。")
        container = self.one(window.descendants(auto_id=CHAT_ID, control_type=p["containerControlType"]))
        self.one(container.descendants(title="文件传输助手", control_type="Text"))
        editor = self.one(container.descendants(auto_id=p["editorAutomationId"], control_type="Edit"))
        button = self.one(container.descendants(auto_id=p["sendButtonAutomationId"], control_type="Button"))
        value, invoke = editor.iface_value, button.iface_invoke
        if value.CurrentIsReadOnly or value.CurrentValue != expected_draft:
            fail("UIA_UNVERIFIED", "输入区不是预期空白或自测草稿，未覆盖现有内容。")
        proof = (window.process_id(), window.handle, tuple(container.element_info.runtime_id), tuple(editor.element_info.runtime_id), tuple(button.element_info.runtime_id))
        if self.proof is not None and proof != self.proof:
            fail("UIA_TARGET_CHANGED", "微信目标控件已变化，未调用发送。")
        self.proof = proof
        return value, invoke

    def verify(self):
        self.inspect()

    def send_once(self, text, check_binding):
        value, _ = self.inspect()
        check_binding()
        value.SetValue(text)
        _, invoke = self.inspect(expected_draft=text)
        check_binding()
        # 唯一会改变微信发送状态的位置；不使用坐标、键盘回车或重试兜底。
        invoke.Invoke()


def execute(root, token, request_id, profile, timeout=45, reader_factory=ExporterReader, target_factory=WindowsUIATarget, monotonic=time.monotonic, sleep=time.sleep):
    if not 1 <= timeout <= 60:
        fail("INVALID_TIMEOUT", "回读等待时间必须在 1 至 60 秒内。")
    bound = binding(root, token)
    with journal(bound) as (state, persist):
        record = state["requests"].get(request_id)
        if not record:
            fail("REQUEST_NOT_FOUND", "未找到已准备的自测请求。")
        valid_request(record, request_id, bound)
        if record["status"] != "prepared":
            # 中途退出留下的 inflight 也绝不再次调用 UI；人工核对后才能另建请求。
            if record["status"] == "inflight":
                record.update(status="unknown", code="INTERRUPTED_NO_RETRY")
                persist()
            return public_result(record, duplicate=True)
        if record["workspaceToken"] != token:
            fail("WORKSPACE_CHANGED", "该自测请求属于先前工作区代际，请重新准备。")
        try:
            target = target_factory(profile)
            target.verify()
            reader = reader_factory(bound)
            start, end = int(time.time()) - 30, int(time.time()) + 180
            baseline = {item["nativeId"] for item in reader.read(start, end)}
            binding(root, token)
        except Exception as error:
            record.update(status="failed", code=error.code if isinstance(error, SelftestError) else "PRECHECK_FAILED")
            persist()
            return public_result(record)
        # 在第一次编辑 UI 前落盘；任何异常、超时或进程退出都会阻止相同请求重发。
        record.update(status="inflight", sendStartedAt=datetime.now(timezone.utc).isoformat())
        persist()
        try:
            target.send_once(record["text"], lambda: binding(root, token))
            deadline = monotonic() + timeout
            while monotonic() < deadline:
                binding(root, token)
                matches = [item for item in reader.read(start, end, timeout=deadline - monotonic()) if item.get("chatId") == CHAT_ID and item.get("outbound") is True and item.get("textSha256") == record["textSha256"] and item.get("nativeId") not in baseline and re.fullmatch(r"[0-9]{1,40}", str(item.get("nativeId", ""))) and int(item["nativeId"]) > 0]
                unique = {item["nativeId"] for item in matches}
                if len(unique) > 1:
                    fail("READBACK_AMBIGUOUS", "回读出现多个匹配原生消息，结果未知。")
                if len(unique) == 1:
                    record.update(status="sent", code="READBACK_CONFIRMED", nativeMessageId=next(iter(unique)))
                    persist()
                    return public_result(record)
                sleep(min(0.5, max(0, deadline - monotonic())))
            fail("READBACK_TIMEOUT", "未在限定时间内确认原生消息，结果未知。")
        except Exception as error:
            record.update(status="unknown", code=error.code if isinstance(error, SelftestError) else "SEND_OR_READBACK_UNKNOWN")
            persist()
            return public_result(record)


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["dependencies", "prepare", "execute", "status"], nargs="?", default="dependencies")
    parser.add_argument("--root", type=Path)
    parser.add_argument("--workspace-token")
    parser.add_argument("--chat-id", choices=[CHAT_ID], default=CHAT_ID)
    parser.add_argument("--request-id")
    parser.add_argument("--uia-profile", type=Path)
    parser.add_argument("--operator-confirmed-ui-account", action="store_true", help="操作者已人工确认界面账号及文件传输助手；工作区 token 不能证明界面登录账号")
    parser.add_argument("--timeout", type=int, default=45)
    args = parser.parse_args()
    try:
        if args.action == "dependencies":
            result = {"prototype": True, "filehelperOnly": True, "arbitraryText": False, "gatewayRegistered": False, "canSend": False, "dependencies": ["Windows Python 3.11+", "pywinauto (UIA)", "pywin32", "已核验只读导出器及其 Crypto/zstandard 环境"], "message": "未连接微信。微信4.1没有预置已验收UIA配置，缺少稳定filehelper身份时拒绝发送；token只证明数据工作区。"}
        else:
            if not args.root or not args.workspace_token:
                fail("ARGUMENT_REQUIRED", "请提供本地项目目录与明确的工作区 token。")
            if args.action == "prepare":
                result = prepare(args.root, args.workspace_token, args.chat_id)
            elif args.action == "status":
                bound = binding(args.root, args.workspace_token)
                with journal(bound) as (state, _):
                    result = {"requests": [public_result(record) for record in state["requests"].values()], "message": "状态查询不连接微信；inflight表示可能中断，禁止重发。"}
            else:
                if not args.operator_confirmed_ui_account or not args.request_id or not args.uia_profile:
                    fail("EXPLICIT_CONFIRMATION_REQUIRED", "真实自测须人工确认界面账号、请求编号及已验收UIA配置。")
                result = execute(args.root, args.workspace_token, args.request_id, read_json(args.uia_profile), args.timeout)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("status") not in {"failed", "unknown"} else 2
    except SelftestError as error:
        print(json.dumps({"status": "failed", "code": error.code, "error": str(error), "automaticRetry": False}, ensure_ascii=False))
        return 2
    except Exception:
        print(json.dumps({"status": "failed", "code": "LOCAL_SELFTEST_UNAVAILABLE", "error": "本地自测无法完成；未自动重试，请检查私有配置。", "automaticRetry": False}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    sys.exit(main())
