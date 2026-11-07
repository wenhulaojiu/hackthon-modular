"""原生文本发送工作进程；默认只读检查，不注册收件钩子或自动启动接待。"""
from __future__ import annotations

import argparse
from contextlib import closing, contextmanager, redirect_stdout, redirect_stderr
import ctypes
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import types


class SenderError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def fail(code):
    raise SenderError(code)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def read_json(filename, maximum=256000):
    filename = Path(filename)
    if filename.is_symlink() or not filename.is_file() or filename.stat().st_size > maximum:
        fail("CONFIG_UNVERIFIED")
    try:
        return json.loads(filename.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError):
        fail("CONFIG_UNVERIFIED")


def file_digest(filename):
    filename = Path(filename)
    if filename.is_symlink() or not filename.is_file():
        fail("COMPONENT_UNVERIFIED")
    checksum = hashlib.sha256()
    with filename.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def lock_manifest():
    return read_json(Path(__file__).with_name("native-component-lock.json"))


def verify_artifacts(root):
    lock = lock_manifest()
    component = Path(root) / ".local-wechat/native-sender/component"
    if not component.is_dir():
        fail("COMPONENT_MISSING")
    for relative, expected in lock["sources"].items():
        if file_digest(component / relative) != expected:
            fail("COMPONENT_UNVERIFIED")
    dll = component / lock["dll"]["path"]
    if dll.stat().st_size != lock["dll"]["size"] or file_digest(dll) != lock["dll"]["sha256"]:
        fail("COMPONENT_UNVERIFIED")
    return component, lock


def local_reader_module():
    # 仅导入项目已有的只读导出封装，不启动其视觉发送或HTTP服务。
    parent = Path(__file__).resolve().parent
    sys.path.insert(0, str(parent))
    spec = importlib.util.spec_from_file_location("kexu_native_reader", parent / "temporary-reply-gateway.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def bound_account(root, token):
    bound = local_reader_module().shared.binding(root, token)
    name = bound["dbDir"].parent.name
    # 数据目录的账号尾码只用于与原生只读账号对象交叉核对，不能代替现场账号验证。
    match = re.fullmatch(r"(wxid_[A-Za-z0-9]+)_[0-9a-fA-F]{4,16}", name)
    account = match.group(1) if match else name
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,127}", account):
        fail("ACCOUNT_UNVERIFIED")
    bound["selfWxid"] = account
    return bound


def checked_config(root, token, filename, *, sending=False, payload=None):
    bound = bound_account(root, token)
    expected = bound["private"] / "native-sender/scopes" / bound["scope"] / "config.json"
    if Path(filename).resolve() != expected.resolve():
        fail("CONFIG_PATH_UNVERIFIED")
    config = read_json(expected)
    if config.get("version") != 1 or config.get("workspaceToken") != token:
        fail("WORKSPACE_CHANGED")
    if config.get("selfWxid") != bound["selfWxid"]:
        fail("ACCOUNT_UNVERIFIED")
    if type(config.get("pid")) is not int or config["pid"] <= 0 or not isinstance(config.get("processCreated"), str):
        fail("PROCESS_UNVERIFIED")
    if sending:
        if config.get("enabled") is not True or config.get("running") is not True:
            fail("SENDER_PAUSED")
        if not payload or payload.get("generation") != config.get("settingsGeneration") or type(payload.get("generation")) is not int:
            fail("SETTINGS_CHANGED")
        allowed = config.get("allowedChatIds")
        if not isinstance(allowed, list) or not 1 <= len(allowed) <= 500 or len(set(allowed)) != len(allowed) or payload["chatId"] not in allowed:
            fail("TARGET_NOT_ALLOWED")
    return bound, config


class Silent(io.TextIOBase):
    def write(self, value):
        return len(value)


def verified_module(name, filename, expected):
    raw = Path(filename).read_bytes()
    if digest(raw) != expected:
        fail("COMPONENT_UNVERIFIED")
    module = types.ModuleType(name)
    module.__file__ = str(filename)
    module.__package__ = name.rpartition(".")[0]
    sys.modules[name] = module
    exec(compile(raw.decode("utf-8"), str(filename), "exec"), module.__dict__)
    return module


class NativeRuntime:
    def __init__(self, root):
        if os.name != "nt":
            fail("WINDOWS_REQUIRED")
        self.root = root
        self.component, self.lock = verify_artifacts(root)
        if "wxbot_framework" in sys.modules or "run_selftest" in sys.modules:
            fail("COMPONENT_ALREADY_IMPORTED")
        package = types.ModuleType("wxbot_framework")
        package.__path__ = [str(self.component / "wxbot_framework")]
        sys.modules[package.__name__] = package
        # 不导入SDK包入口，不安装收件、撤回或好友申请钩子。
        with redirect_stdout(Silent()), redirect_stderr(Silent()):
            for name in ("text", "native_profiles", "account"):
                relative = "wxbot_framework/" + name + ".py"
                module = verified_module("wxbot_framework." + name, self.component / relative, self.lock["sources"][relative])
                if name == "account":
                    self.account = module
            self.native = verified_module("run_selftest", self.component / "native/run_selftest.py", self.lock["sources"]["native/run_selftest.py"])
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        self.kernel.OpenProcess.restype = ctypes.c_void_p
        self.kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        self.kernel.ReadProcessMemory.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
        self.kernel.GetProcessTimes.argtypes = [ctypes.c_void_p] + [ctypes.POINTER(ctypes.c_ulonglong)] * 4

    def inspect_pid(self, pid, self_wxid):
        modules = self.native.modules(pid)
        core = modules.get("weixin.dll")
        if not core:
            fail("WECHAT_NOT_READY")
        filename = Path(core[1])
        if filename.stat().st_size != self.lock["core"]["size"] or file_digest(filename) != self.lock["core"]["sha256"]:
            fail("WECHAT_VERSION_UNSUPPORTED")
        if "text_bridge.dll" in modules or "selftest_bridge.dll" in modules:
            fail("NATIVE_BRIDGE_BUSY")
        process = self.kernel.OpenProcess(0x1010, False, pid)
        if not process:
            fail("PROCESS_ACCESS_DENIED")
        try:
            created, ended, kernel, user = (ctypes.c_ulonglong() for _ in range(4))
            if not self.kernel.GetProcessTimes(process, ctypes.byref(created), ctypes.byref(ended), ctypes.byref(kernel), ctypes.byref(user)):
                fail("PROCESS_UNVERIFIED")
            def read_memory(address, size):
                if type(size) is not int or not 0 < size <= 4194304:
                    fail("ACCOUNT_UNVERIFIED")
                buffer = ctypes.create_string_buffer(size)
                count = ctypes.c_size_t()
                if not self.kernel.ReadProcessMemory(process, address, buffer, size, ctypes.byref(count)) or count.value != size:
                    raise OSError("ACCOUNT_UNVERIFIED")
                return buffer.raw
            own = self.account.read_current_account(read_memory, core[0])
            if own != self_wxid:
                fail("LIVE_ACCOUNT_MISMATCH")
            return {"pid": pid, "processCreated": str(created.value), "selfWxid": own}
        finally:
            self.kernel.CloseHandle(process)

    def bind(self, bound):
        matches = []
        for pid in self.native.wechat_candidates():
            try:
                matches.append(self.inspect_pid(pid, bound["selfWxid"]))
            except SenderError as error:
                if error.code not in ("LIVE_ACCOUNT_MISMATCH", "WECHAT_NOT_READY"):
                    raise
        if len(matches) != 1:
            fail("WECHAT_ACCOUNT_NOT_UNIQUE")
        return matches[0]

    def check(self, config):
        info = self.inspect_pid(config["pid"], config["selfWxid"])
        if info["processCreated"] != config["processCreated"]:
            fail("PROCESS_CHANGED")

    def invoke(self, config, chat_id, text):
        verify_artifacts(self.root)
        with redirect_stdout(Silent()), redirect_stderr(Silent()):
            result = self.native.run("--dispatch", pid=config["pid"], bridge_path=self.native.TEXT_DLL, target=chat_id, text=text, mentions=None, keep_loaded=False, preserve_report=False)
        # 未安全卸载不能被当作成功；不接管或强制卸载其他组件。
        return isinstance(result, dict) and result.get("success") is True and result.get("dll_unloaded") is True


def make_reader(bound, chat_id):
    directory = bound["private"] / "temporary-reply-gateway" / bound["scope"]
    directory.mkdir(parents=True, exist_ok=True)
    return local_reader_module().ScopedReader(bound, chat_id)


@contextmanager
def send_lock(filename):
    filename.parent.mkdir(parents=True, exist_ok=True)
    if filename.is_symlink():
        fail("JOURNAL_UNVERIFIED")
    with filename.open("a+b") as handle:
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fail("SEND_BUSY")
        try:
            yield
        finally:
            if os.name == "nt":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def validate_payload(payload, token):
    if not isinstance(payload, dict) or set(payload) != {"workspaceToken", "chatId", "text", "idempotencyKey", "generation"} or payload["workspaceToken"] != token:
        fail("REQUEST_UNVERIFIED")
    if not isinstance(payload["chatId"], str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,127}", payload["chatId"]) or payload["chatId"] == "filehelper":
        fail("TARGET_UNVERIFIED")
    text = payload["text"]
    if not isinstance(text, str) or "\0" in text or not 1 <= len(text.encode("utf-8")) <= 1023:
        fail("TEXT_TOO_LONG")
    key = payload["idempotencyKey"]
    if not isinstance(key, str) or not 1 <= len(key) <= 200 or any(ord(char) < 32 for char in key):
        fail("IDEMPOTENCY_UNVERIFIED")


def matching_ids(records, payload, own, baseline, start, end):
    if not isinstance(records, list):
        fail("READBACK_UNVERIFIED")
    result = set()
    for item in records:
        native = item.get("nativeId")
        if not isinstance(native, str) or not re.fullmatch(r"[0-9]{1,40}", native) or int(native) <= 0:
            continue
        if native not in baseline and item.get("chatId") == payload["chatId"] and item.get("senderUsername") == own and item.get("localType") == "1" and item.get("outbound") is True and type(item.get("timestamp")) in (int, float) and start <= item["timestamp"] < end and item.get("textSha256") == digest(payload["text"].encode("utf-8")):
            result.add(native)
    return result


def perform_send(root, token, filename, payload, *, runtime_factory=NativeRuntime, reader_factory=make_reader, clock=time.time, sleep=time.sleep, readback_seconds=25):
    validate_payload(payload, token)
    bound, config = checked_config(root, token, filename, sending=True, payload=payload)
    key = digest(payload["idempotencyKey"].encode("utf-8"))
    text_hash = digest(payload["text"].encode("utf-8"))
    journal_path = Path(filename).parent / "outbox.sqlite"
    with send_lock(bound["private"] / "native-sender/send.lock"), closing(sqlite3.connect(journal_path, timeout=1)) as journal:
        journal.execute("CREATE TABLE IF NOT EXISTS outbox (request_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, text_hash TEXT NOT NULL, status TEXT NOT NULL, native_id TEXT, code TEXT)")
        old = journal.execute("SELECT chat_id,text_hash,status,native_id,code FROM outbox WHERE request_id=?", (key,)).fetchone()
        def response(status, native=None, code=None):
            return {"status": status, "workspaceToken": token, "chatId": payload["chatId"], "textSha256": text_hash, "readback": status == "sent", **({"messageId": native} if native else {}), **({"code": code} if code else {})}
        if old:
            if old[0] != payload["chatId"] or old[1] != text_hash:
                fail("IDEMPOTENCY_CONFLICT")
            return response(old[2], old[3], old[4])
        runtime = runtime_factory(root)
        runtime.check(config)
        reader = reader_factory(bound, payload["chatId"])
        baseline = reader.read(int(clock()) - 2, int(clock()) + 1, timeout=10)
        baseline_ids = {item.get("nativeId") for item in baseline}
        bound, config = checked_config(root, token, filename, sending=True, payload=payload)
        runtime.check(config)
        start = int(clock())
        # 原生调用前即持久化未知状态；中断、进程重启或重复请求均不再发第二次。
        journal.execute("INSERT INTO outbox VALUES (?,?,?,?,?,?)", (key, payload["chatId"], text_hash, "unknown", None, "SEND_INFLIGHT_OR_INTERRUPTED"))
        journal.commit()
        native = None
        code = None
        try:
            if not runtime.invoke(config, payload["chatId"], payload["text"]):
                fail("NATIVE_COMPLETION_UNVERIFIED")
            checked_config(root, token, filename, sending=True, payload=payload)
            runtime.check(config)
            deadline = clock() + readback_seconds
            while clock() < deadline:
                checked_config(root, token, filename, sending=True, payload=payload)
                end = int(clock()) + 1
                records = reader.read(start, end, timeout=min(10, max(0.1, deadline - clock())))
                matches = matching_ids(records, payload, bound["selfWxid"], baseline_ids, start, end)
                if len(matches) > 1:
                    fail("READBACK_AMBIGUOUS")
                if matches:
                    checked_config(root, token, filename, sending=True, payload=payload)
                    runtime.check(config)
                    native = next(iter(matches))
                    break
                sleep(0.2)
            if native is None:
                fail("READBACK_TIMEOUT")
        except Exception as error:
            code = error.code if isinstance(error, SenderError) else "SEND_OR_READBACK_UNKNOWN"
        status = "sent" if native else "unknown"
        journal.execute("UPDATE outbox SET status=?,native_id=?,code=? WHERE request_id=?", (status, native, code, key))
        journal.commit()
        return response(status, native, code)


MESSAGES = {
    "COMPONENT_MISSING": "请先安装原生后台发送组件。", "COMPONENT_UNVERIFIED": "组件指纹不匹配，请重新检查安装。",
    "WECHAT_ACCOUNT_NOT_UNIQUE": "请登录与当前数据工作区一致的微信，再启用组件。", "LIVE_ACCOUNT_MISMATCH": "当前登录微信与绑定数据账号不一致，已停止发送。",
    "WECHAT_VERSION_UNSUPPORTED": "当前微信版本尚未适配，未启用原生发送。", "NATIVE_BRIDGE_BUSY": "微信中仍有原生桥接占用，请先正常结束原组件或重启微信。",
    "PROCESS_CHANGED": "微信已重启，请重新启用发送组件。", "PROCESS_ACCESS_DENIED": "无法按当前用户权限核对微信进程。",
    "SENDER_PAUSED": "原生发送已暂停。", "TEXT_TOO_LONG": "回复过长，已停止发送，请缩短后人工处理。",
    "WORKSPACE_CHANGED": "微信工作区已切换，请刷新页面。", "WINDOWS_REQUIRED": "原生发送仅支持Windows本机。",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", nargs="?", default="inspect", choices=("inspect", "bind", "send"))
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--workspace-token", required=True)
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    dispatched = args.action == "send"
    try:
        if args.action == "send":
            raw = sys.stdin.buffer.read(16385)
            if len(raw) > 16384:
                fail("REQUEST_UNVERIFIED")
            result = perform_send(root, args.workspace_token, args.config, json.loads(raw.decode("utf-8")))
        else:
            verify_artifacts(root)
            if args.action == "bind":
                bound = bound_account(root, args.workspace_token)
                result = {**NativeRuntime(root).bind(bound), "compatible": True, "installed": True, "ready": True}
            elif not args.config.is_file():
                result = {"installed": True, "compatible": False, "ready": False, "code": "NOT_ENABLED", "message": "组件已安装，请点击启用完成当前账号核对。"}
            else:
                _, config = checked_config(root, args.workspace_token, args.config)
                NativeRuntime(root).check(config)
                result = {"installed": True, "compatible": True, "ready": config.get("enabled") is True}
    except Exception as error:
        code = getattr(error, "code", "NATIVE_SENDER_UNAVAILABLE")
        # 发送调用只有Python持久记录能够证明未发或已发；其他未完成结果交给管理器按unknown处理。
        result = {"status": ("failed" if isinstance(error, SenderError) else "unknown") if dispatched else "unavailable", "ready": False, "compatible": False, "installed": code != "COMPONENT_MISSING", "code": code, "message": MESSAGES.get(code, "原生发送暂不可用，请检查组件与当前微信登录账号。")}
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    raise SystemExit(main())
