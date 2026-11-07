"""仅用于人工确认后的文件传输助手视觉自测，不提供客户发送能力。

执行会把固定自测标记写入CF_UNICODETEXT并占用剪贴板；不读取、保存或恢复原内容。
只粘贴一次，本机OCR输入区仅忽略空白后逐字核对；不匹配即保留草稿且不点击发送。
"""

import asyncio
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path
import re
import time


class VisualError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fail(code, message):
    raise VisualError(code, message)


def image_hash(image):
    image = image.convert("RGB")
    return hashlib.sha256(str(image.size).encode("ascii") + image.tobytes()).hexdigest()


def green_ratio(image):
    pixels = list(image.convert("RGB").getdata())
    return sum(g >= 90 and g - r >= 25 and g - b >= 10 for r, g, b in pixels) / max(1, len(pixels))


def dark_pixels(image):
    return sum(max(pixel) < 150 for pixel in image.convert("RGB").getdata())


def exact_marker_text(actual, expected):
    # 仅忽略OCR分词或换行产生的空白；绝不修改大小写、标点或相似字。
    return re.sub(r"\s+", "", actual) == re.sub(r"\s+", "", expected)


def verify_main_windows(foreground, windows):
    if foreground.get("title") != "微信":
        fail("VISUAL_NOT_FOREGROUND", "前台不是标题为微信的主窗口，原型不会切换焦点。")
    matching = [window["hwnd"] for window in windows if window.get("visible") is True and window.get("pid") == foreground["pid"] and window.get("windowClass") == foreground["windowClass"] and window.get("title") == "微信"]
    if matching != [foreground["hwnd"]]:
        fail("VISUAL_WINDOW_AMBIGUOUS", "同进程存在多个微信主窗口，未校准或发送。")


def validate_recipe(recipe, width, height):
    if recipe.get("version") != 1 or recipe.get("mode") != "visual-filehelper-only":
        fail("VISUAL_PROFILE_INVALID", "视觉配置必须明确限定文件传输助手。")
    for key in ("headerRect", "iconRect", "inputRect", "sendRect"):
        rect = recipe.get(key)
        if not isinstance(rect, list) or len(rect) != 4 or any(type(value) is not int for value in rect):
            fail("VISUAL_PROFILE_INVALID", "缺少人工核对的客户区局部矩形。")
        left, top, right, bottom = rect
        if not 0 <= left < right <= width or not 0 <= top < bottom <= height:
            fail("VISUAL_PROFILE_INVALID", "局部矩形越过当前微信客户区。")
    header, icon, editor = recipe["headerRect"], recipe["iconRect"], recipe["inputRect"]
    if header[1] > height // 4 or header[3] - header[1] > 100 or icon[2] - icon[0] > 128 or icon[3] - icon[1] > 128 or editor[1] < height // 2:
        fail("VISUAL_PROFILE_INVALID", "标题、图标或输入区校准范围不符合自测限制。")
    for key, rectangle in (("inputPoint", recipe["inputRect"]), ("sendPoint", recipe["sendRect"])):
        point = recipe.get(key)
        if not isinstance(point, list) or len(point) != 2 or any(type(value) is not int for value in point) or not rectangle[0] <= point[0] < rectangle[2] or not rectangle[1] <= point[1] < rectangle[3]:
            fail("VISUAL_PROFILE_INVALID", "点击点必须位于本次人工核对的局部矩形内。")


class LocalWindowsVision:
    def __init__(self):
        if os.name != "nt":
            fail("VISUAL_UNSUPPORTED", "本机视觉自测只支持 Windows。")
        from PIL import ImageGrab
        import win32api
        import win32con
        import win32gui
        import win32process
        self.grab = ImageGrab.grab
        self.api, self.constants, self.gui, self.process = win32api, win32con, win32gui, win32process
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        self.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        self.user32.GetThreadDpiAwarenessContext.restype = ctypes.c_void_p
        self.user32.GetAwarenessFromDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        if self.user32.GetAwarenessFromDpiAwarenessContext(self.user32.GetThreadDpiAwarenessContext()) != 2:
            fail("VISUAL_DPI_UNVERIFIED", "无法取得物理像素坐标，不使用可能过期的缩放坐标。")
        self.user32.GetDpiForWindow.argtypes = [ctypes.c_void_p]

    def identity(self):
        hwnd = self.gui.GetForegroundWindow()
        if not hwnd or self.gui.IsIconic(hwnd) or not self.gui.IsWindowVisible(hwnd):
            fail("VISUAL_NOT_FOREGROUND", "微信必须由用户保持在前台，原型不会抢焦点。")
        _, pid = self.process.GetWindowThreadProcessId(hwnd)
        handle = self.api.OpenProcess(self.constants.PROCESS_QUERY_INFORMATION | self.constants.PROCESS_VM_READ, False, pid)
        try:
            executable = self.process.GetModuleFileNameEx(handle, 0)
            if Path(executable).name.lower() != "weixin.exe":
                fail("VISUAL_NOT_FOREGROUND", "当前前台不是微信主进程。")
            creation = str(self.process.GetProcessTimes(handle)["CreationTime"])
            version = self.api.GetFileVersionInfo(executable, "\\")
            version = ".".join(str(value) for value in (version["FileVersionMS"] >> 16, version["FileVersionMS"] & 65535, version["FileVersionLS"] >> 16, version["FileVersionLS"] & 65535))
        finally:
            handle.Close()
        windows = []
        window_class = self.gui.GetClassName(hwnd)
        foreground = {"hwnd": hwnd, "pid": pid, "windowClass": window_class, "title": self.gui.GetWindowText(hwnd)}

        def collect(candidate, _):
            if self.gui.IsWindowVisible(candidate) and self.process.GetWindowThreadProcessId(candidate)[1] == pid and self.gui.GetClassName(candidate) == window_class:
                windows.append({"hwnd": candidate, "pid": pid, "windowClass": window_class, "title": self.gui.GetWindowText(candidate), "visible": True})

        self.gui.EnumWindows(collect, None)
        # 设置等辅助窗口不计为第二个主窗口；前台必须仍为唯一标题“微信”的主窗口。
        verify_main_windows(foreground, windows)
        left, top, right, bottom = self.gui.GetClientRect(hwnd)
        origin = list(self.gui.ClientToScreen(hwnd, (left, top)))
        return {"hwnd": hwnd, "pid": pid, "processCreated": creation, "windowClass": window_class, "wechatVersion": version, "clientSize": [right - left, bottom - top], "clientOrigin": origin, "dpi": self.user32.GetDpiForWindow(hwnd)}

    def crop(self, identity, rectangle):
        if self.identity() != identity:
            fail("VISUAL_WINDOW_CHANGED", "前台账号窗口、位置、尺寸或DPI已变化。")
        x, y = identity["clientOrigin"]
        left, top, right, bottom = rectangle
        image = self.grab(bbox=(x + left, y + top, x + right, y + bottom), all_screens=True)
        if image.size != (right - left, bottom - top):
            fail("VISUAL_CAPTURE_UNVERIFIED", "局部截图尺寸无法核验。")
        return image

    async def _ocr(self, image):
        from winrt.windows.graphics.imaging import BitmapDecoder, BitmapPixelFormat, BitmapAlphaMode
        from winrt.windows.media.ocr import OcrEngine
        from winrt.windows.storage.streams import DataWriter, InMemoryRandomAccessStream
        chinese = [language for language in OcrEngine.available_recognizer_languages if language.language_tag.lower().startswith("zh-hans")]
        engine = OcrEngine.try_create_from_language(chinese[0]) if chinese else None
        if engine is None:
            fail("LOCAL_OCR_UNAVAILABLE", "本机没有可用OCR语言包，请先安装系统中文OCR。")
        self.ocr_language = chinese[0].language_tag
        data = io.BytesIO()
        image.convert("RGB").save(data, format="PNG")
        stream = InMemoryRandomAccessStream()
        writer = DataWriter(stream)
        writer.write_bytes(data.getvalue())
        await writer.store_async()
        await writer.flush_async()
        writer.detach_stream()
        stream.seek(0)
        decoder = await BitmapDecoder.create_async(stream)
        bitmap = await decoder.get_software_bitmap_async(BitmapPixelFormat.BGRA8, BitmapAlphaMode.IGNORE)
        result = await engine.recognize_async(bitmap)
        # OCR仅处理当前会话标题和本次固定自测标记输入区，不读取其他聊天。
        return result.text

    def ocr(self, image):
        return asyncio.run(self._ocr(image))

    def click(self, identity, point):
        if self.identity() != identity:
            fail("VISUAL_WINDOW_CHANGED", "点击前微信已失去前台身份。")
        x, y = identity["clientOrigin"]
        self.api.SetCursorPos((x + point[0], y + point[1]))
        if self.identity() != identity:
            fail("VISUAL_WINDOW_CHANGED", "指针定位后微信目标发生变化。")
        self.api.mouse_event(self.constants.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        self.api.mouse_event(self.constants.MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)

    def type_marker(self, identity, text):
        if self.identity() != identity:
            fail("VISUAL_WINDOW_CHANGED", "输入前微信已失去前台身份。")
        if not re.fullmatch(r"客序自测 \d{8}T\d{6}Z-[a-f0-9]{8}", text):
            fail("FILEHELPER_MARKER_ONLY", "剪贴板仅允许本次固定自测标记。")
        import win32clipboard
        # 测试会占用剪贴板；不读取、保存或恢复用户原剪贴板内容。
        win32clipboard.OpenClipboard()
        try:
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardData(self.constants.CF_UNICODETEXT, text)
        finally:
            win32clipboard.CloseClipboard()
        if self.identity() != identity:
            fail("VISUAL_WINDOW_CHANGED", "粘贴前微信已失去前台身份。")
        if any(self.api.GetAsyncKeyState(key) & 0x8000 for key in (0x10, 0x11, 0x12, 0x5B, 0x5C)):
            fail("VISUAL_MODIFIER_PRESSED", "检测到用户修饰键按下，未执行粘贴。")
        # 仅一次Ctrl+V，随后由本机OCR逐字核验输入区；没有重试或回车兜底。
        self.api.keybd_event(self.constants.VK_CONTROL, 0, 0, 0)
        try:
            self.api.keybd_event(ord("V"), 0, 0, 0)
            self.api.keybd_event(ord("V"), 0, self.constants.KEYEVENTF_KEYUP, 0)
        finally:
            self.api.keybd_event(self.constants.VK_CONTROL, 0, self.constants.KEYEVENTF_KEYUP, 0)


def verify_header_icon(vision, identity, recipe, expected_icon=None):
    text = re.sub(r"\s+", "", vision.ocr(vision.crop(identity, recipe["headerRect"])))
    if text != "文件传输助手":
        fail("FILEHELPER_HEADER_UNVERIFIED", "当前标题未被本机OCR唯一识别为文件传输助手。")
    icon = vision.crop(identity, recipe["iconRect"])
    if green_ratio(icon) < 0.08:
        fail("FILEHELPER_ICON_UNVERIFIED", "人工确认的系统助手绿色图标区域不匹配。")
    signature = image_hash(icon)
    if expected_icon and signature != expected_icon:
        fail("FILEHELPER_ICON_CHANGED", "系统助手图标签名已变化，未调用发送。")
    return signature


def calibrate_visual(recipe, token, vision_factory=LocalWindowsVision, now=time.time):
    vision = vision_factory()
    identity = vision.identity()
    validate_recipe(recipe, *identity["clientSize"])
    icon_hash = verify_header_icon(vision, identity, recipe)
    empty_image = vision.crop(identity, recipe["inputRect"])
    empty_hash = image_hash(empty_image)
    empty_dark = dark_pixels(empty_image)
    if empty_dark > 60:
        fail("VISUAL_INPUT_NOT_EMPTY", "校准输入区含可见内容，请人工清空或重新核对输入区矩形。")
    if vision.identity() != identity:
        fail("VISUAL_WINDOW_CHANGED", "校准期间微信窗口发生变化。")
    calibrated_at = now()
    return {**recipe, "workspaceToken": token, "identity": identity, "calibratedAt": calibrated_at, "expiresAt": calibrated_at + 120, "iconSha256": icon_hash, "emptyInputSha256": empty_hash, "emptyInputDarkPixels": empty_dark, "operatorConfirmedSystemFilehelper": True, "proof": "人工确认系统助手+本机标题OCR及图标签名；不代表稳定客户ID或界面账号自动识别"}


class WindowsVisualTarget:
    def __init__(self, profile, vision_factory=LocalWindowsVision, now=time.time, sleep=time.sleep):
        self.profile, self.vision, self.now, self.sleep = profile, vision_factory(), now, sleep
        identity = profile.get("identity", {})
        validate_recipe(profile, *identity.get("clientSize", [0, 0]))
        if profile.get("operatorConfirmedSystemFilehelper") is not True or not re.fullmatch(r"(?:legacy|acct-[a-f0-9]{20})@[1-9][0-9]*", str(profile.get("workspaceToken", ""))) or not all(re.fullmatch(r"[a-f0-9]{64}", str(profile.get(key, ""))) for key in ("iconSha256", "emptyInputSha256")):
            fail("VISUAL_PROFILE_INVALID", "缺少本次账号与窗口的人工系统助手校准证明。")

    def verify(self, draft=False):
        p = self.profile
        if not isinstance(p.get("calibratedAt"), (float, int)) or not isinstance(p.get("expiresAt"), (float, int)) or not p["calibratedAt"] <= self.now() <= p["expiresAt"] or p["expiresAt"] - p["calibratedAt"] > 120:
            fail("VISUAL_PROFILE_EXPIRED", "视觉校准仅在两分钟内有效，请重新人工核对。")
        if self.vision.identity() != p["identity"]:
            fail("VISUAL_WINDOW_CHANGED", "当前前台不再是本次校准的微信窗口。")
        verify_header_icon(self.vision, p["identity"], p, p["iconSha256"])
        if draft is not None:
            editor = self.vision.crop(p["identity"], p["inputRect"])
            empty = image_hash(editor) == p["emptyInputSha256"]
            ink = dark_pixels(editor)
            if not draft and not empty and ink > p.get("emptyInputDarkPixels", 0) + 30 or draft and (empty or ink < p.get("emptyInputDarkPixels", 0) + 80):
                fail("VISUAL_DRAFT_UNVERIFIED", "输入区不是预期空白或自测草稿状态，未点击发送。")
        if self.vision.identity() != p["identity"]:
            fail("VISUAL_WINDOW_CHANGED", "复核期间微信窗口发生变化。")

    def send_once(self, text, check_binding):
        if not re.fullmatch(r"客序自测 \d{8}T\d{6}Z-[a-f0-9]{8}", text):
            fail("FILEHELPER_MARKER_ONLY", "视觉原型只允许程序生成的短自测标记。")
        self.verify()
        check_binding()
        self.vision.click(self.profile["identity"], self.profile["inputPoint"])
        self.verify(draft=None)
        check_binding()
        self.vision.type_marker(self.profile["identity"], text)
        self.sleep(0.2)
        self.verify(draft=True)
        actual = self.vision.ocr(self.vision.crop(self.profile["identity"], self.profile["inputRect"]))
        if not exact_marker_text(actual, text):
            fail("VISUAL_MARKER_MISMATCH", "输入区OCR未逐字匹配固定自测标记，保留草稿，未点击发送且不会重试。")
        # OCR耗时期间也可能切换聊天，发送前重新核验标题、图标与同一前台窗口。
        self.verify(draft=True)
        check_binding()
        # 只点击一次本次校准的发送点，不重试，不按回车，也不导航其他会话。
        self.vision.click(self.profile["identity"], self.profile["sendPoint"])


def private_profile_path(root, filename):
    private = (Path(root).resolve() / ".local-wechat").resolve()
    filename = Path(filename).resolve()
    if private not in filename.parents or filename.suffix.lower() != ".json":
        fail("VISUAL_PROFILE_INVALID", "视觉校准文件必须保存在本机私有配置目录内。")
    return filename


def write_private_profile(filename, profile):
    filename.parent.mkdir(parents=True, exist_ok=True)
    temporary = filename.with_name(filename.name + ".tmp")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as handle:
            json.dump(profile, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, filename)
    finally:
        temporary.unlink(missing_ok=True)
