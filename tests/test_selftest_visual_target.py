"""视觉自测纯合成测试；不导入Pillow/WinRT/pywin32，不截图或操作Windows。"""

import copy
import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "local-wechat" / "selftest_visual_target.py"
spec = importlib.util.spec_from_file_location("kexu_selftest_visual", SCRIPT)
visual = importlib.util.module_from_spec(spec)
spec.loader.exec_module(visual)


class Image:
    def __init__(self, dark=0, green=False, role="header"):
        self.size = (20, 20)
        self.role = role
        self.pixels = [(20, 180, 60) if green else (255, 255, 255)] * 400
        self.pixels[:dark] = [(0, 0, 0)] * dark

    def convert(self, _mode):
        return self

    def getdata(self):
        return self.pixels

    def tobytes(self):
        return bytes(channel for pixel in self.pixels for channel in pixel)


class Vision:
    def __init__(self):
        self.current = {"hwnd": 1, "pid": 2, "processCreated": "synthetic", "windowClass": "synthetic", "wechatVersion": "4.1.0.1", "clientSize": [1000, 800], "clientOrigin": [100, 100], "dpi": 144}
        self.header = "文件传输助手"
        self.green = True
        self.dark = 0
        self.clicks = []
        self.typed = []
        self.ocr_calls = 0
        self.marker_ocr = None

    def identity(self):
        return copy.deepcopy(self.current)

    def crop(self, _identity, rectangle):
        return Image(self.dark, role="input") if rectangle == RECIPE["inputRect"] else Image(green=self.green) if rectangle == RECIPE["iconRect"] else Image()

    def ocr(self, image):
        self.ocr_calls += 1
        if image.role == "input":
            return self.marker_ocr if self.marker_ocr is not None else self.typed[-1] if self.typed else ""
        return self.header

    def click(self, _identity, point):
        self.clicks.append(point)

    def type_marker(self, _identity, text):
        self.typed.append(text)
        self.dark = 120


RECIPE = {"version": 1, "mode": "visual-filehelper-only", "headerRect": [600, 20, 800, 60], "iconRect": [350, 180, 400, 230], "inputRect": [500, 600, 950, 700], "sendRect": [850, 740, 950, 780], "inputPoint": [600, 650], "sendPoint": [900, 760]}
TOKEN = "acct-" + "a" * 20 + "@2"
MARKER = "客序自测 20261107T120000Z-1234abcd"


class VisualTargetTests(unittest.TestCase):
    def setUp(self):
        self.vision = Vision()
        self.profile = visual.calibrate_visual(copy.deepcopy(RECIPE), TOKEN, vision_factory=lambda: self.vision, now=lambda: 1000)

    def target(self, now=1001):
        return visual.WindowsVisualTarget(self.profile, vision_factory=lambda: self.vision, now=lambda: now, sleep=lambda _: None)

    def test_calibration_and_inspection_are_read_only_and_bind_physical_identity(self):
        self.target().verify()
        self.assertEqual(self.vision.clicks, [])
        self.assertEqual(self.vision.typed, [])
        self.assertEqual(self.profile["identity"]["dpi"], 144)
        self.assertEqual(self.profile["workspaceToken"], TOKEN)
        self.assertEqual(self.profile["expiresAt"], 1120)

    def test_fixed_marker_two_clicks_only_and_revalidates_target(self):
        checked = []
        self.target().send_once(MARKER, lambda: checked.append(True))
        self.assertEqual(self.vision.clicks, [RECIPE["inputPoint"], RECIPE["sendPoint"]])
        self.assertEqual(self.vision.typed, [MARKER])
        self.assertEqual(len(checked), 3)
        self.assertGreaterEqual(self.vision.ocr_calls, 4)

    def test_custom_text_is_rejected_without_click(self):
        with self.assertRaises(visual.VisualError):
            self.target().send_once("任意客户营销正文", lambda: None)
        self.assertEqual(self.vision.clicks, [])

    def test_changed_header_icon_identity_or_expiry_fail_without_click(self):
        for change in ("header", "icon", "identity", "expiry"):
            with self.subTest(change=change):
                self.setUp()
                if change == "header":
                    self.vision.header = "其他客户"
                elif change == "icon":
                    self.vision.green = False
                elif change == "identity":
                    self.vision.current["clientOrigin"] = [110, 100]
                with self.assertRaises(visual.VisualError):
                    self.target(now=1200 if change == "expiry" else 1001).send_once(MARKER, lambda: None)
                self.assertEqual(self.vision.clicks, [])

    def test_focus_change_after_input_prevents_send_click(self):
        original_type = self.vision.type_marker

        def changed(identity, text):
            original_type(identity, text)
            self.vision.current["hwnd"] = 99

        self.vision.type_marker = changed
        with self.assertRaises(visual.VisualError):
            self.target().send_once(MARKER, lambda: None)
        self.assertEqual(self.vision.clicks, [RECIPE["inputPoint"]])

    def test_missing_glyphs_prevent_send_even_if_caret_changes_hash(self):
        self.vision.type_marker = lambda _identity, _text: setattr(self.vision, "dark", 15)
        with self.assertRaises(visual.VisualError):
            self.target().send_once(MARKER, lambda: None)
        self.assertEqual(self.vision.clicks, [RECIPE["inputPoint"]])

    def test_old_or_outside_window_coordinates_are_rejected(self):
        bad = copy.deepcopy(RECIPE)
        bad["sendPoint"] = [2000, 760]
        with self.assertRaises(visual.VisualError):
            visual.calibrate_visual(bad, TOKEN, vision_factory=lambda: self.vision)
        self.assertEqual(self.vision.clicks, [])

    def test_calibration_uses_one_timestamp_even_when_clock_advances(self):
        clock = iter([1000.0, 1000.001, 1000.002])
        profile = visual.calibrate_visual(copy.deepcopy(RECIPE), TOKEN, vision_factory=lambda: self.vision, now=lambda: next(clock))
        self.assertEqual(profile["expiresAt"] - profile["calibratedAt"], 120)

    def test_letter_replaced_by_previous_hyphen_is_blocked_before_send(self):
        expected = "客序自测 20261107T051439Z-bd7f490c"
        self.vision.marker_ocr = "客序自测 20261107T051439Z--d7f490c"
        with self.assertRaises(visual.VisualError) as raised:
            self.target().send_once(expected, lambda: None)
        self.assertEqual(raised.exception.code, "VISUAL_MARKER_MISMATCH")
        self.assertEqual(self.vision.clicks, [RECIPE["inputPoint"]])
        self.assertEqual(len(self.vision.typed), 1)

    def test_marker_ocr_only_normalizes_whitespace(self):
        self.assertTrue(visual.exact_marker_text("客序 自测\n20261107T051439Z- bd7f490c", "客序自测 20261107T051439Z-bd7f490c"))
        self.assertFalse(visual.exact_marker_text("客序自测 20261107t051439Z-bd7f490c", "客序自测 20261107T051439Z-bd7f490c"))
        self.assertFalse(visual.exact_marker_text("客序自测 20261107T051439Z—bd7f490c", "客序自测 20261107T051439Z-bd7f490c"))

    def test_settings_window_is_ignored_but_multiple_main_windows_are_rejected(self):
        foreground = {"hwnd": 1, "pid": 2, "windowClass": "QtSynthetic", "title": "微信"}
        main = {**foreground, "visible": True}
        settings = {**main, "hwnd": 3, "title": "设置"}
        visual.verify_main_windows(foreground, [settings, main])
        with self.assertRaises(visual.VisualError) as raised:
            visual.verify_main_windows(foreground, [settings, main, {**main, "hwnd": 4}])
        self.assertEqual(raised.exception.code, "VISUAL_WINDOW_AMBIGUOUS")
        with self.assertRaises(visual.VisualError) as raised:
            visual.verify_main_windows(settings, [settings, main])
        self.assertEqual(raised.exception.code, "VISUAL_NOT_FOREGROUND")


if __name__ == "__main__":
    unittest.main()
