"""仅本次人工授权单会话的五分钟测试网关；不是通用微信发送器。"""

import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import secrets
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid

from selftest_visual_target import LocalWindowsVision, dark_pixels, exact_marker_text, green_ratio, image_hash, private_profile_path, verify_main_windows, write_private_profile


spec = importlib.util.spec_from_file_location("kexu_selftest_shared", Path(__file__).with_name("selftest-sender.py"))
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)


class GatewayError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fail(code, message):
    raise GatewayError(code, message)


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec="milliseconds")


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.timestamp()
    except (TypeError, ValueError):
        fail("AUTHORIZATION_INVALID", "临时授权时间格式无效。")


def valid_chat_id(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_@.+-]{1,160}", value) and not value.startswith("-") and not value.endswith("@chatroom") and value != "filehelper"


def ocr_scale(profile):
    value = profile.get("ocrScale", 1)
    if type(value) is not int or value not in (1, 2, 3):
        fail("TARGET_PROFILE_INVALID", "OCR缩放只允许整数1、2或3。")
    return value


def accept_unprefixed_test_messages(profile):
    value = profile.get("acceptUnprefixedTestMessages", False)
    if type(value) is not bool:
        fail("AUTHORIZATION_INVALID", "无前缀自用号测试开关必须为布尔值。")
    return value


def recognize_text(vision, image, profile):
    scale = ocr_scale(profile)
    if scale != 1:
        width, height = image.size
        # 仅在内存放大当前标题或输入区局部，使用LANCZOS重采样，不保存或上传截图。
        image = image.resize((width * scale, height * scale), resample=1)
    return vision.ocr(image)


def validate_geometry(profile, width, height):
    ocr_scale(profile)
    accept_unprefixed_test_messages(profile)
    for key in ("headerRect", "iconRect", "selectedRowRect", "inputRect", "sendRect"):
        rect = profile.get(key)
        if not isinstance(rect, list) or len(rect) != 4 or any(type(value) is not int for value in rect) or not 0 <= rect[0] < rect[2] <= width or not 0 <= rect[1] < rect[3] <= height:
            fail("TARGET_PROFILE_INVALID", "当前窗口的局部校准矩形无效。")
    if profile["headerRect"][1] > height // 4 or profile["headerRect"][3] - profile["headerRect"][1] > 100 or profile["inputRect"][1] < height // 2:
        fail("TARGET_PROFILE_INVALID", "标题或输入区不在已限定的窗口区域。")
    for key in ("iconRect", "selectedRowRect"):
        rect = profile[key]
        if rect[2] - rect[0] > 128 or rect[3] - rect[1] > 128:
            fail("TARGET_PROFILE_INVALID", "头像和选中标记必须是小块区域，不能包含聊天预览。")
    for key, rect in (("inputPoint", profile["inputRect"]), ("sendPoint", profile["sendRect"])):
        point = profile.get(key)
        if not isinstance(point, list) or len(point) != 2 or any(type(value) is not int for value in point) or not rect[0] <= point[0] < rect[2] or not rect[1] <= point[1] < rect[3]:
            fail("TARGET_PROFILE_INVALID", "点击位置不在本次人工核对的区域。")
    scan = profile.get("listScanRange")
    if scan is not None:
        icon, selected = profile["iconRect"], profile["selectedRowRect"]
        if not isinstance(scan, list) or len(scan) != 2 or any(type(value) is not int for value in scan) or not 0 <= scan[0] < scan[1] <= height or not scan[0] <= min(icon[1], selected[1]) or not max(icon[3], selected[3]) <= scan[1] or icon[2] - icon[0] > 96 or selected[2] - selected[0] > 16 or not (icon[2] <= selected[0] or selected[2] <= icon[0]):
            fail("TARGET_PROFILE_INVALID", "列表扫描只能覆盖包含校准目标的两个独立窄列和指定纵向范围。")


def list_offset(profile):
    icon, selected = profile["iconRect"], profile["selectedRowRect"]
    return {"x": selected[0] - icon[0], "y": selected[1] - icon[1], "iconSize": [icon[2] - icon[0], icon[3] - icon[1]], "selectedSize": [selected[2] - selected[0], selected[3] - selected[1]]}


def matching_list_shifts(vision, identity, profile):
    top, bottom = profile["listScanRange"]
    icon, selected = profile["iconRect"], profile["selectedRowRect"]
    # 仅在内存截取头像列及选中标记列，绝不扩展为联系人姓名、预览或聊天正文截图。
    icon_strip = vision.crop(identity, [icon[0], top, icon[2], bottom])
    selected_strip = vision.crop(identity, [selected[0], top, selected[2], bottom])
    low = max(top - icon[1], top - selected[1])
    high = min(bottom - icon[3], bottom - selected[3])
    matches = []
    for shift in range(low, high + 1):
        icon_crop = icon_strip.crop((0, icon[1] + shift - top, icon[2] - icon[0], icon[3] + shift - top))
        if image_hash(icon_crop) != profile["iconSha256"]:
            continue
        selection_crop = selected_strip.crop((0, selected[1] + shift - top, selected[2] - selected[0], selected[3] + shift - top))
        if image_hash(selection_crop) == profile["selectedRowSha256"]:
            matches.append(shift)
    return matches


def validate_bound_metadata(expected, actual):
    if actual != expected:
        fail("TARGET_WINDOW_CHANGED", "已校准微信窗口的进程、位置、尺寸或DPI发生变化。")


def bound_window_availability(config):
    # 仅查询已校准HWND的元数据，不要求它当前占用前台，也不截图或操作窗口。
    vision = LocalWindowsVision()
    gui, process, api, constants = vision.gui, vision.process, vision.api, vision.constants
    expected = config["identity"]
    hwnd = expected["hwnd"]
    if not gui.IsWindow(hwnd) or not gui.IsWindowVisible(hwnd):
        fail("TARGET_WINDOW_CHANGED", "已校准微信窗口不存在或不可见。")
    _, pid = process.GetWindowThreadProcessId(hwnd)
    handle = api.OpenProcess(constants.PROCESS_QUERY_INFORMATION | constants.PROCESS_VM_READ, False, pid)
    try:
        executable = process.GetModuleFileNameEx(handle, 0)
        if Path(executable).name.lower() != "weixin.exe":
            fail("TARGET_WINDOW_CHANGED", "已校准窗口不再属于微信进程。")
        creation = str(process.GetProcessTimes(handle)["CreationTime"])
        version = api.GetFileVersionInfo(executable, "\\")
        version = ".".join(str(value) for value in (version["FileVersionMS"] >> 16, version["FileVersionMS"] & 65535, version["FileVersionLS"] >> 16, version["FileVersionLS"] & 65535))
    finally:
        handle.Close()
    window_class = gui.GetClassName(hwnd)
    windows = []

    def collect(candidate, _):
        if gui.IsWindowVisible(candidate) and process.GetWindowThreadProcessId(candidate)[1] == pid and gui.GetClassName(candidate) == window_class:
            windows.append({"hwnd": candidate, "pid": pid, "windowClass": window_class, "title": gui.GetWindowText(candidate), "visible": True})

    gui.EnumWindows(collect, None)
    try:
        verify_main_windows({"hwnd": hwnd, "pid": pid, "windowClass": window_class, "title": gui.GetWindowText(hwnd)}, windows)
    except Exception:
        fail("TARGET_WINDOW_CHANGED", "已校准微信主窗口标题或唯一性发生变化。")
    left, top, right, bottom = gui.GetClientRect(hwnd)
    actual = {"hwnd": hwnd, "pid": pid, "processCreated": creation, "windowClass": window_class, "wechatVersion": version, "clientSize": [right - left, bottom - top], "clientOrigin": list(gui.ClientToScreen(hwnd, (left, top))), "dpi": vision.user32.GetDpiForWindow(hwnd)}
    validate_bound_metadata(expected, actual)
    return {"foregroundReady": gui.GetForegroundWindow() == hwnd}


def validate_config(config):
    ids = config.get("allowedChatIds")
    if config.get("version") != 1 or config.get("type") != "scoped-test-http" or not isinstance(ids, list) or len(ids) != 1 or not valid_chat_id(ids[0]) or config.get("maxSends") != 3 or not isinstance(config.get("targetLabel"), str) or not 1 <= len(config["targetLabel"]) <= 80:
        fail("AUTHORIZATION_INVALID", "仅支持私有配置中一个明确会话及最多三次尝试。")
    if not re.fullmatch(r"(?:legacy|acct-[a-f0-9]{20})@[1-9][0-9]*", str(config.get("workspaceToken", ""))) or not isinstance(config.get("bearerToken"), str) or not 32 <= len(config["bearerToken"]) <= 200 or not re.fullmatch(r"[A-Za-z0-9_-]+", config["bearerToken"]):
        fail("AUTHORIZATION_INVALID", "工作区或服务端凭证格式无效。")
    if not re.fullmatch(r"【自测[a-f0-9]{4,12}】", str(config.get("testPrefix", ""))):
        fail("AUTHORIZATION_INVALID", "缺少本次独立随机测试问句前缀。")
    try:
        uuid.UUID(config["authorizationId"])
    except (KeyError, ValueError, TypeError):
        fail("AUTHORIZATION_INVALID", "缺少独立临时授权编号。")
    duration = timestamp(config.get("expiresAt")) - timestamp(config.get("createdAt"))
    if not 0 < duration <= 300 or config.get("operatorConfirmedUniqueTarget") is not True:
        fail("AUTHORIZATION_INVALID", "授权必须经人工确认且不能超过五分钟。")
    validate_geometry(config, *config.get("identity", {}).get("clientSize", [0, 0]))
    if config.get("listScanRange") is not None and config.get("listSignatureOffset") != list_offset(config):
        fail("AUTHORIZATION_INVALID", "头像与选中标记的相对位置未通过校准。")
    if config.get("listScanRange") is not None and config.get("selectedMarkerGreenVerified") is not True:
        fail("AUTHORIZATION_INVALID", "列表扫描缺少已核验的选中绿色标记。")
    for key in ("iconSha256", "selectedRowSha256", "emptyInputSha256"):
        if not re.fullmatch(r"[a-f0-9]{64}", str(config.get(key, ""))):
            fail("AUTHORIZATION_INVALID", "缺少本次会话的视觉签名。")


def calibrate(root, token, recipe, vision_factory=LocalWindowsVision, now=time.time):
    shared.binding(root, token)
    if recipe.get("version") != 1 or recipe.get("type") != "scoped-test-http" or not valid_chat_id(recipe.get("chatId")) or not isinstance(recipe.get("targetLabel"), str) or not 1 <= len(recipe["targetLabel"]) <= 80:
        fail("TARGET_PROFILE_INVALID", "请先人工唯一解析会话ID并写入私有校准配置。")
    vision = vision_factory()
    identity = vision.identity()
    validate_geometry(recipe, *identity["clientSize"])
    if not exact_marker_text(recognize_text(vision, vision.crop(identity, recipe["headerRect"]), recipe), recipe["targetLabel"]):
        fail("TARGET_TITLE_MISMATCH", "当前会话标题与人工绑定目标不一致。")
    editor = vision.crop(identity, recipe["inputRect"])
    if dark_pixels(editor) > 60:
        fail("INPUT_NOT_EMPTY", "输入区不为空，请人工核对，不覆盖现有草稿。")
    at = now()
    config = {**recipe, "version": 1, "type": "scoped-test-http", "workspaceToken": token, "allowedChatIds": [recipe["chatId"]], "maxSends": 3, "authorizationId": str(uuid.uuid4()), "createdAt": iso(at), "expiresAt": iso(at + 300), "bearerToken": secrets.token_urlsafe(32), "identity": identity, "iconSha256": image_hash(vision.crop(identity, recipe["iconRect"])), "selectedRowSha256": image_hash(vision.crop(identity, recipe["selectedRowRect"])), "emptyInputSha256": image_hash(editor), "emptyInputDarkPixels": dark_pixels(editor), "operatorConfirmedUniqueTarget": True}
    config.pop("chatId", None)
    config["ocrScale"] = ocr_scale(recipe)
    config["acceptUnprefixedTestMessages"] = accept_unprefixed_test_messages(recipe)
    if recipe.get("listScanRange") is not None:
        if green_ratio(vision.crop(identity, recipe["selectedRowRect"])) < 0.08:
            fail("TARGET_SELECTION_UNVERIFIED", "校准选中标记没有绿色块，不能把普通背景当作选中证明。")
        config["selectedMarkerGreenVerified"] = True
        config["listSignatureOffset"] = list_offset(config)
        if matching_list_shifts(vision, identity, config) != [0]:
            fail("TARGET_SIGNATURE_AMBIGUOUS", "校准目标在指定窄列范围内不唯一，未保存临时授权。")
    if vision.identity() != identity:
        fail("TARGET_WINDOW_CHANGED", "校准期间微信窗口发生变化。")
    shared.binding(root, token)
    validate_config(config)
    return config


class ScopedTarget:
    def __init__(self, config, vision_factory=LocalWindowsVision, sleep=time.sleep):
        self.config, self.vision, self.sleep = config, vision_factory(), sleep

    def verify(self, expected=None, ignore_input=False):
        p, vision = self.config, self.vision
        if vision.identity() != p["identity"]:
            fail("TARGET_WINDOW_CHANGED", "微信前台窗口、位置、DPI或进程已变化。")
        if not exact_marker_text(recognize_text(vision, vision.crop(p["identity"], p["headerRect"]), p), p["targetLabel"]):
            fail("TARGET_TITLE_MISMATCH", "当前标题不再是人工绑定会话。")
        if p.get("listScanRange") is not None:
            matches = matching_list_shifts(vision, p["identity"], p)
            if len(matches) != 1:
                fail("TARGET_SIGNATURE_AMBIGUOUS" if matches else "TARGET_SIGNATURE_CHANGED", "列表中没有唯一同时匹配头像与选中标记的目标，已停止本次授权。")
        else:
            for rectangle, signature in (("iconRect", "iconSha256"), ("selectedRowRect", "selectedRowSha256")):
                if image_hash(vision.crop(p["identity"], p[rectangle])) != p[signature]:
                    fail("TARGET_SIGNATURE_CHANGED", "头像或选中标记变化，已停止本次授权。")
        if not ignore_input:
            image = vision.crop(p["identity"], p["inputRect"])
            if expected is None:
                if image_hash(image) != p["emptyInputSha256"] and dark_pixels(image) > p["emptyInputDarkPixels"] + 30:
                    fail("INPUT_NOT_EMPTY", "输入区已有草稿，不覆盖内容。")
            elif not exact_marker_text(recognize_text(vision, image, p), expected):
                fail("BODY_OCR_MISMATCH", "输入正文未逐字通过本机OCR，保留草稿，不发送。")
        if vision.identity() != p["identity"]:
            fail("TARGET_WINDOW_CHANGED", "核验期间微信前台发生变化。")

    def paste_once(self, text):
        import win32clipboard
        api, constants = self.vision.api, self.vision.constants
        if self.vision.identity() != self.config["identity"]:
            fail("TARGET_WINDOW_CHANGED", "粘贴前微信已失去前台身份。")
        if any(api.GetAsyncKeyState(key) & 0x8000 for key in (0x10, 0x11, 0x12, 0x5B, 0x5C)):
            fail("MODIFIER_PRESSED", "用户正在按修饰键，未输入。")
        # 临时测试会占用剪贴板，不读取、保存或恢复原内容。
        win32clipboard.OpenClipboard()
        try:
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardData(constants.CF_UNICODETEXT, text)
        finally:
            win32clipboard.CloseClipboard()
        if self.vision.identity() != self.config["identity"]:
            fail("TARGET_WINDOW_CHANGED", "粘贴前微信窗口变化。")
        api.keybd_event(constants.VK_CONTROL, 0, 0, 0)
        try:
            api.keybd_event(ord("V"), 0, 0, 0)
            api.keybd_event(ord("V"), 0, constants.KEYEVENTF_KEYUP, 0)
        finally:
            api.keybd_event(constants.VK_CONTROL, 0, constants.KEYEVENTF_KEYUP, 0)

    def send_once(self, text, check_live):
        self.verify()
        check_live()
        self.vision.click(self.config["identity"], self.config["inputPoint"])
        self.verify(ignore_input=True)
        check_live()
        self.paste_once(text)
        self.sleep(0.2)
        self.verify(expected=text)
        check_live()
        self.verify(expected=text)
        check_live()
        self.vision.click(self.config["identity"], self.config["sendPoint"])


class ScopedReader:
    def __init__(self, bound, chat_id):
        self.bound, self.chat_id = bound, chat_id
        self.script = Path(bound["config"]["exporterRoot"]) / "scripts" / "export_wechat.py"
        raw = self.script.read_bytes()
        if len(raw) > 2_000_000 or hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest() != shared.EXPORTER_SHA256:
            fail("EXPORTER_UNVERIFIED", "只读组件未匹配已核验版本。")

    def read(self, start, end, timeout=15):
        shared.binding(self.bound["root"], self.bound["token"])
        parent = self.bound["private"] / "temporary-reply-gateway" / self.bound["scope"]
        with tempfile.TemporaryDirectory(prefix="readback-", dir=parent) as temporary:
            folder = Path(temporary).resolve()
            if not shared.inside(parent, folder):
                fail("READBACK_UNVERIFIED", "回读临时目录越界。")
            local_iso = lambda value: datetime.fromtimestamp(value, timezone(timedelta(hours=8))).isoformat(timespec="seconds")
            command = [self.bound["config"]["pythonPath"], "-B", str(self.script), "--chat", self.chat_id, "--start", local_iso(start), "--end", local_iso(end), "--output-root", str(folder), "--db-dir", str(self.bound["dbDir"])]
            result = subprocess.run(command, cwd=self.bound["config"]["exporterRoot"], capture_output=True, timeout=max(0.1, min(15, timeout)), check=False, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0, env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
            if result.returncode or len(result.stdout) > 256_000:
                fail("READBACK_UNAVAILABLE", "指定会话的本机回读未完成。")
            summary = json.loads(result.stdout.decode("utf-8"))
            if summary.get("status") != "complete" or summary.get("chat_username") != self.chat_id:
                fail("READBACK_UNVERIFIED", "导出结果不是唯一授权会话。")

            def read_file(key, maximum):
                filename = Path(summary[key]).resolve()
                if not shared.inside(folder, filename) or not filename.is_file() or filename.stat().st_size > maximum:
                    fail("READBACK_UNVERIFIED", "回读文件位置或大小异常。")
                return filename.read_bytes()

            raw, plain = read_file("json_file", 1_500_000), read_file("text_file", 1_500_000)
            validation = json.loads(read_file("validation_file", 65536).decode("utf-8"))
            if validation.get("status") != "passed" or validation.get("json_sha256") != hashlib.sha256(raw).hexdigest() or validation.get("text_sha256") != hashlib.sha256(plain).hexdigest() or validation.get("json_bytes") != len(raw) or validation.get("text_bytes") != len(plain):
                fail("READBACK_UNVERIFIED", "回读文件完整性未通过。")
            data = json.loads(raw.decode("utf-8"))
            metadata, messages = data.get("metadata", {}), data.get("messages")
            if not isinstance(messages, list) or len(messages) > 1500 or metadata.get("chat_username") != self.chat_id or metadata.get("chat_type") != "private" or any(value != len(messages) for value in (metadata.get("message_count"), validation.get("message_count"), summary.get("messages"))):
                fail("READBACK_UNVERIFIED", "回读会话类型或消息数量异常。")
            if any(metadata.get(key) is not False for key in ("source_modified", "keys_saved", "plaintext_database_saved")) or timestamp(metadata.get("range_start_inclusive")) != start or timestamp(metadata.get("range_end_exclusive")) != end:
                fail("READBACK_UNVERIFIED", "回读范围或只读保护标记异常。")
            output = []
            for message in messages:
                if message.get("chat_username") != self.chat_id or type(message.get("timestamp")) not in (float, int) or not start <= message["timestamp"] < end or not isinstance(message.get("content"), str) or len(message["content"]) > 8000:
                    fail("READBACK_UNVERIFIED", "回读消息格式或会话身份异常。")
                native = str(message.get("server_id", ""))
                if re.fullmatch(r"[0-9]{1,40}", native) and int(native) > 0:
                    output.append({"chatId": self.chat_id, "nativeId": native, "outbound": message.get("sender") == "我", "textSha256": shared.sha(message["content"])})
            return output


@contextmanager
def send_lock(filename):
    if filename.is_symlink():
        fail("JOURNAL_INVALID", "发送锁文件异常。")
    handle = filename.open("a+b")
    locked = False
    try:
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
            os.fsync(handle.fileno())
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except OSError:
            fail("SEND_BUSY", "另一个发送进程正在执行，本次未输入。")
        yield
    finally:
        if locked:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_UN)
        handle.close()


class Gateway:
    def __init__(self, root, config, target_factory=ScopedTarget, reader_factory=ScopedReader, now=time.time, monotonic=time.monotonic, sleep=time.sleep, metadata_probe=bound_window_availability):
        validate_config(config)
        self.root, self.config = Path(root).resolve(), config
        self.now, self.monotonic, self.sleep = now, monotonic, sleep
        self.target_factory, self.reader_factory = target_factory, reader_factory
        self.metadata_probe = metadata_probe
        self.mutex, self.busy = threading.Lock(), False
        self.bound = shared.binding(root, config["workspaceToken"])
        self.directory = self.bound["private"] / "temporary-reply-gateway" / self.bound["scope"]
        self.directory.mkdir(parents=True, exist_ok=True)
        if not shared.inside(self.bound["private"], self.directory):
            fail("JOURNAL_INVALID", "临时网关日志目录越界。")
        self.database = self.directory / "journal.sqlite"
        if self.database.is_symlink():
            fail("JOURNAL_INVALID", "临时网关日志不能是符号链接。")
        with self.connect() as con:
            con.executescript("CREATE TABLE IF NOT EXISTS authorizations(id TEXT PRIMARY KEY,revoked TEXT); CREATE TABLE IF NOT EXISTS attempts(scope TEXT,id TEXT,authorization TEXT,chat_id TEXT,body_sha TEXT,status TEXT,native_id TEXT,code TEXT,PRIMARY KEY(scope,id));")
            con.execute("INSERT OR IGNORE INTO authorizations(id,revoked) VALUES(?,NULL)", (config["authorizationId"],))

    def connect(self):
        return self._connection()

    @contextmanager
    def _connection(self):
        con = sqlite3.connect(self.database, timeout=1)
        try:
            con.row_factory = sqlite3.Row
            con.execute("PRAGMA synchronous=FULL")
            with con:
                yield con
        finally:
            con.close()

    def revoke(self, code):
        with self.connect() as con:
            con.execute("UPDATE authorizations SET revoked=COALESCE(revoked,?) WHERE id=?", (code, self.config["authorizationId"]))

    def check_live(self):
        with self.connect() as con:
            row = con.execute("SELECT revoked FROM authorizations WHERE id=?", (self.config["authorizationId"],)).fetchone()
        if row and row["revoked"]:
            fail(row["revoked"], "本次临时授权已停止，不能自动恢复。")
        if not timestamp(self.config["createdAt"]) <= self.now() < timestamp(self.config["expiresAt"]):
            self.revoke("AUTHORIZATION_EXPIRED")
            fail("AUTHORIZATION_EXPIRED", "五分钟临时授权已过期。")
        try:
            shared.binding(self.root, self.config["workspaceToken"])
        except Exception:
            self.revoke("WORKSPACE_CHANGED")
            fail("WORKSPACE_CHANGED", "账号工作区已变化，本次授权已停止。")

    def remaining(self):
        with self.connect() as con:
            return max(0, 3 - con.execute("SELECT COUNT(*) FROM attempts WHERE authorization=?", (self.config["authorizationId"],)).fetchone()[0])

    def status(self):
        ready, foreground_ready, code = False, False, "SEND_BUSY" if self.busy else None
        if not self.busy:
            try:
                self.check_live()
                if self.remaining() < 1:
                    fail("SEND_LIMIT_REACHED", "三次尝试额度已用尽。")
                foreground_ready = self.metadata_probe(self.config)["foregroundReady"]
                if foreground_ready:
                    self.target_factory(self.config).verify()
                    ready = True
                else:
                    # 配置可用与发送可操作性分开；后台状态不截图，也不触发任何GUI动作。
                    ready, code = True, "NEEDS_FOREGROUND"
            except Exception as error:
                code = getattr(error, "code", "TARGET_UNVERIFIED")
                if code == "VISUAL_NOT_FOREGROUND":
                    try:
                        # 防止元数据读取后切换应用的竞态；重新核验绑定窗口，仍不抢焦点。
                        self.check_live()
                        foreground_ready = self.metadata_probe(self.config)["foregroundReady"]
                        ready, code = not foreground_ready, "NEEDS_FOREGROUND"
                    except Exception as metadata_error:
                        code = getattr(metadata_error, "code", "TARGET_WINDOW_CHANGED")
                # 只读状态允许列表排序动画暂时没有双SHA匹配；本次仍不就绪。
                # 不清除已有撤销，发送路径的任何失败也仍永久撤销本次授权。
                if code not in {"TARGET_SIGNATURE_CHANGED", "NEEDS_FOREGROUND"}:
                    self.revoke(code)
        return {"protocol": "kexu-reply-v1", "ready": ready, "foregroundReady": foreground_ready, "requiresForeground": True, "workspaceToken": self.config["workspaceToken"], "allowedChatIds": self.config["allowedChatIds"], "testPrefix": self.config["testPrefix"], "acceptUnprefixedTestMessages": accept_unprefixed_test_messages(self.config), "expiresAt": self.config["expiresAt"], "remainingSends": self.remaining(), "maxSends": 3, "code": code, "capabilities": {"stableChatIds": False, "scopedStableChatIds": True, "scopeRestricted": True, "readback": True, "idempotentSend": True}}

    def receipt(self, row, duplicate=False):
        status = row["status"] if row["status"] != "inflight" else "unknown"
        return {"status": status, "chatId": row["chat_id"], "textSha256": row["body_sha"], "messageId": row["native_id"], "workspaceToken": self.config["workspaceToken"], "readback": status == "sent", "code": row["code"] or ("INFLIGHT_NO_RETRY" if status == "unknown" else None), "duplicate": duplicate, "automaticRetry": False}

    def existing(self, key, chat_id, body_sha):
        with self.connect() as con:
            row = con.execute("SELECT * FROM attempts WHERE scope=? AND id=?", (self.bound["scope"], key)).fetchone()
        if row:
            if row["chat_id"] != chat_id or row["body_sha"] != body_sha:
                fail("IDEMPOTENCY_CONFLICT", "同一请求编号不能更换会话或正文。")
            return self.receipt(row, True)

    def finish(self, key, status, code, native_id=None):
        with self.connect() as con:
            con.execute("UPDATE attempts SET status=?,code=?,native_id=? WHERE scope=? AND id=?", (status, code, native_id, self.bound["scope"], key))
            row = con.execute("SELECT * FROM attempts WHERE scope=? AND id=?", (self.bound["scope"], key)).fetchone()
        return self.receipt(row)

    def send(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"chatId", "text", "idempotencyKey", "workspaceToken"} or payload["chatId"] != self.config["allowedChatIds"][0] or payload["workspaceToken"] != self.config["workspaceToken"]:
            fail("SCOPE_REJECTED", "只允许本次明确授权的唯一会话及工作区。")
        text, key = payload["text"], payload["idempotencyKey"]
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= 300 or len(text) > 300 or any(ord(char) < 32 and char not in "\n\t" for char in text) or not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", key):
            fail("REQUEST_INVALID", "只允许三百字以内的短测试回复及明确幂等编号。")
        body_sha = shared.sha(text)
        previous = self.existing(key, payload["chatId"], body_sha)
        if previous:
            return previous
        if not self.mutex.acquire(blocking=False):
            fail("SEND_BUSY", "已有一次临时发送正在执行。")
        self.busy = True
        reserved = False
        try:
            with send_lock(self.directory / "send.lock"):
                previous = self.existing(key, payload["chatId"], body_sha)
                if previous:
                    return previous
                self.check_live()
                if self.remaining() < 1:
                    fail("SEND_LIMIT_REACHED", "三次发送尝试额度已用尽。")
                target = self.target_factory(self.config)
                target.verify()
                reader = self.reader_factory(self.bound, payload["chatId"])
                start, end = max(int(self.now()) - 30, math.ceil(timestamp(self.config["createdAt"]))), int(self.now()) + 120
                baseline = {message["nativeId"] for message in reader.read(start, end)}
                self.check_live()
                with self.connect() as con:
                    con.execute("BEGIN IMMEDIATE")
                    if con.execute("SELECT COUNT(*) FROM attempts WHERE authorization=?", (self.config["authorizationId"],)).fetchone()[0] >= 3:
                        fail("SEND_LIMIT_REACHED", "三次发送尝试额度已用尽。")
                    con.execute("INSERT INTO attempts(scope,id,authorization,chat_id,body_sha,status) VALUES(?,?,?,?,?,'inflight')", (self.bound["scope"], key, self.config["authorizationId"], payload["chatId"], body_sha))
                reserved = True
                target.send_once(text, self.check_live)
                deadline = self.monotonic() + min(25, timestamp(self.config["expiresAt"]) - self.now())
                while self.monotonic() < deadline:
                    self.check_live()
                    messages = reader.read(start, end, timeout=deadline - self.monotonic())
                    matches = {message["nativeId"] for message in messages if message.get("chatId") == payload["chatId"] and message.get("outbound") is True and message.get("textSha256") == body_sha and message.get("nativeId") not in baseline and re.fullmatch(r"[0-9]{1,40}", str(message.get("nativeId", ""))) and int(message["nativeId"]) > 0}
                    if len(matches) > 1:
                        fail("READBACK_AMBIGUOUS", "回读出现多个匹配原生消息，结果未知。")
                    if len(matches) == 1:
                        return self.finish(key, "sent", "READBACK_CONFIRMED", next(iter(matches)))
                    self.sleep(min(0.5, max(0, deadline - self.monotonic())))
                fail("READBACK_TIMEOUT", "发送后没有确认唯一原生消息，结果未知。")
        except Exception as error:
            code = getattr(error, "code", "SEND_OR_READBACK_UNKNOWN")
            self.revoke(code)
            if reserved:
                return self.finish(key, "unknown", code)
            raise GatewayError(code, "临时发送前检查失败，本次未执行发送。") from None
        finally:
            self.busy = False
            self.mutex.release()


def handler_for(gateway):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def respond(self, status, value):
            raw = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)

        def authorized(self):
            return self.client_address[0] == "127.0.0.1" and re.fullmatch(r"(?:127\.0\.0\.1|localhost):[1-9][0-9]{0,4}", self.headers.get("Host", "")) and self.headers.get("Origin") is None and hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + gateway.config["bearerToken"])

        def do_GET(self):
            if not self.authorized():
                self.respond(403, {"error": "本机临时网关需要服务端凭证。"})
            elif self.path == "/kexu/v1/status":
                self.respond(200, gateway.status())
            else:
                self.respond(404, {"error": "未知临时网关接口。"})

        def do_POST(self):
            if not self.authorized():
                self.respond(403, {"error": "本机临时网关需要服务端凭证。"})
                return
            if self.path != "/kexu/v1/send":
                self.respond(404, {"error": "未知临时网关接口。"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 16000 or self.headers.get("Transfer-Encoding") or not self.headers.get("Content-Type", "").lower().startswith("application/json"):
                    fail("REQUEST_INVALID", "请求必须为小型UTF-8 JSON。")
                self.connection.settimeout(10)
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                self.respond(200, gateway.send(payload))
            except GatewayError as error:
                self.respond(409, {"status": "failed", "code": error.code, "error": str(error), "automaticRetry": False})
            except Exception:
                self.respond(400, {"status": "failed", "code": "REQUEST_INVALID", "error": "临时网关未接受该请求。", "automaticRetry": False})
    return Handler


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["calibrate", "inspect", "serve"])
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--workspace-token")
    parser.add_argument("--recipe", type=Path)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--port", type=int, default=8768)
    parser.add_argument("--operator-confirmed-ui-account", action="store_true")
    parser.add_argument("--operator-confirmed-unique-target", action="store_true")
    parser.add_argument("--operator-confirmed-empty-input", action="store_true")
    args = parser.parse_args()
    try:
        config_path = private_profile_path(args.root, args.config)
        if args.action == "calibrate":
            if not args.workspace_token or not args.recipe or not args.operator_confirmed_ui_account or not args.operator_confirmed_unique_target or not args.operator_confirmed_empty_input:
                fail("CONFIRMATION_REQUIRED", "须先人工核对当前账号、唯一会话ID/标题/头像/选中标记及空输入区。")
            config = calibrate(args.root, args.workspace_token, shared.read_json(private_profile_path(args.root, args.recipe)))
            write_private_profile(config_path, config)
            print(json.dumps({"status": "calibrated", "expiresAt": config["expiresAt"], "maxSends": 3, "clipboardNotice": "发送时会覆盖剪贴板，不读取或恢复原内容。", "message": "仅本机局部只读校准，未输入、发送或注册通用网关。"}, ensure_ascii=False))
            return 0
        gateway = Gateway(args.root, shared.read_json(config_path))
        if args.action == "inspect":
            print(json.dumps(gateway.status(), ensure_ascii=False))
            return 0
        if not 1024 <= args.port <= 65535:
            fail("PORT_INVALID", "临时网关端口必须在1024至65535之间。")
        server = ThreadingHTTPServer(("127.0.0.1", args.port), handler_for(gateway))
        print(json.dumps({"status": "listening", "port": args.port, "expiresAt": gateway.config["expiresAt"], "maxSends": 3}, ensure_ascii=False), flush=True)
        try:
            server.serve_forever(poll_interval=0.2)
        finally:
            server.server_close()
        return 0
    except Exception as error:
        print(json.dumps({"status": "failed", "code": getattr(error, "code", "TEMPORARY_GATEWAY_UNAVAILABLE"), "error": "临时单会话网关未就绪；未自动重试。"}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    sys.exit(main())
