"""临时网关纯合成测试；不连接微信、不截图、不读真实聊天或密钥。"""

import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "local-wechat" / "temporary-reply-gateway.py"
sys.path.insert(0, str(SCRIPT.parent))
spec = importlib.util.spec_from_file_location("kexu_temporary_gateway", SCRIPT)
gateway_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway_module)


class Image:
    def __init__(self, role="header", dark=0):
        self.role, self.size = role, (20, 20)
        self.pixels = [(255, 255, 255)] * 400
        self.pixels[:dark] = [(0, 0, 0)] * dark

    def convert(self, _mode):
        return self

    def getdata(self):
        return self.pixels

    def tobytes(self):
        return bytes(channel for pixel in self.pixels for channel in pixel)

    def resize(self, size, resample=None):
        image = Image(self.role)
        image.size = size
        image.resample = resample
        return image


RECIPE = {"version": 1, "type": "scoped-test-http", "chatId": "wxid_synthetic_target", "targetLabel": "合成测试对象", "testPrefix": "【自测a1b2】", "headerRect": [600, 20, 800, 60], "iconRect": [350, 180, 400, 230], "selectedRowRect": [410, 180, 420, 190], "inputRect": [500, 600, 950, 700], "sendRect": [850, 740, 950, 780], "inputPoint": [600, 650], "sendPoint": [900, 760]}


class Vision:
    def __init__(self):
        self.current = {"hwnd": 1, "pid": 2, "processCreated": "synthetic", "windowClass": "synthetic", "wechatVersion": "4.1.0.1", "clientSize": [1000, 800], "clientOrigin": [100, 100], "dpi": 144}
        self.body, self.header, self.clicks = "", RECIPE["targetLabel"], []

    def identity(self):
        return copy.deepcopy(self.current)

    def crop(self, _identity, rectangle):
        return Image("input", 120 if self.body else 0) if rectangle == RECIPE["inputRect"] else Image()

    def ocr(self, image):
        return self.body if image.role == "input" else self.header

    def click(self, _identity, point):
        self.clicks.append(point)


class GridImage:
    def __init__(self, width, height, pixels, role="header"):
        self.size, self.pixels, self.role = (width, height), pixels, role

    def convert(self, _mode):
        return self

    def getdata(self):
        return self.pixels

    def tobytes(self):
        return bytes(channel for pixel in self.pixels for channel in pixel)

    def crop(self, rectangle):
        left, top, right, bottom = rectangle
        width = self.size[0]
        pixels = [pixel for row in range(top, bottom) for pixel in self.pixels[row * width + left:row * width + right]]
        return GridImage(right - left, bottom - top, pixels, self.role)


class ScanVision(Vision):
    def __init__(self):
        super().__init__()
        self.rows = [(0, True)]
        self.captured = []

    def crop(self, _identity, rectangle):
        self.captured.append(rectangle)
        left, top, right, bottom = rectangle
        icon, selected = RECIPE["iconRect"], RECIPE["selectedRowRect"]
        pixels = []
        for y in range(top, bottom):
            for x in range(left, right):
                color = (255, 255, 255)
                for shift, active in self.rows:
                    if icon[0] <= x < icon[2] and icon[1] + shift <= y < icon[3] + shift:
                        color = ((x - icon[0]) * 3 % 255, (y - icon[1] - shift) * 5 % 255, 120)
                    if active and selected[0] <= x < selected[2] and selected[1] + shift <= y < selected[3] + shift:
                        color = (15, 180, 40)
                pixels.append(color)
        return GridImage(right - left, bottom - top, pixels, "input" if rectangle == RECIPE["inputRect"] else "header")


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kexu-temporary-gateway-test-")
        self.root = Path(self.temp.name).resolve()
        self.private = self.root / ".local-wechat"
        self.private.mkdir()
        self.database = self.root / "synthetic" / "db_storage"
        self.database.mkdir(parents=True)
        self.save("config.json", {"dbDir": str(self.database), "exporterRoot": str(self.root), "pythonPath": sys.executable})
        self.save("accounts.json", {"version": 1, "activeId": "legacy", "revision": 1, "accounts": [{"id": "legacy", "dbDir": str(self.database)}]})
        self.now, self.tick = 1800000000.0, 0.0
        self.vision = Vision()
        self.config = gateway_module.calibrate(self.root, "legacy@1", copy.deepcopy(RECIPE), vision_factory=lambda: self.vision, now=lambda: self.now)
        self.sends, self.reads = 0, 0
        self.current_text, self.target_error, self.no_readback = "", None, False
        self.foreground, self.metadata_error, self.visual_checks = True, None, 0
        self.gateway = self.make_gateway()

    def tearDown(self):
        # 仅清理本测试生成的合成目录，不接触用户数据。
        self.assertTrue(self.root.name.startswith("kexu-temporary-gateway-test-"))
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.temp.cleanup()

    def save(self, filename, data):
        (self.private / filename).write_text(json.dumps(data), encoding="utf-8")

    def make_gateway(self):
        owner = self

        class Target:
            def __init__(self, _config):
                pass

            def verify(self):
                owner.visual_checks += 1
                if not owner.foreground:
                    raise gateway_module.GatewayError("VISUAL_NOT_FOREGROUND", "合成微信不在前台")
                if owner.target_error:
                    raise gateway_module.GatewayError(owner.target_error, "合成目标校验失败")

            def send_once(self, text, check_live):
                check_live()
                owner.sends += 1
                owner.current_text = text

        class Reader:
            def __init__(self, _bound, chat_id):
                owner.assertEqual(chat_id, RECIPE["chatId"])
                self.calls = 0

            def read(self, *_args, **_kwargs):
                owner.reads += 1
                self.calls += 1
                if self.calls == 1 or owner.no_readback:
                    return []
                return [{"chatId": RECIPE["chatId"], "nativeId": str(100 + owner.sends), "outbound": True, "textSha256": gateway_module.shared.sha(owner.current_text)}]

        def sleep(seconds):
            self.tick += max(0.1, seconds)

        return gateway_module.Gateway(self.root, self.config, target_factory=Target, reader_factory=Reader, now=lambda: self.now, monotonic=lambda: self.tick, sleep=sleep, metadata_probe=self.metadata_probe)

    def metadata_probe(self, _config):
        if self.metadata_error:
            raise gateway_module.GatewayError(self.metadata_error, "合成窗口元数据漂移")
        return {"foregroundReady": self.foreground}

    def payload(self, key="synthetic-request-1", **changes):
        return {"chatId": RECIPE["chatId"], "text": "你好，这是合成测试回复。", "idempotencyKey": key, "workspaceToken": "legacy@1", **changes}

    def test_calibration_is_read_only_and_status_is_explicitly_scoped(self):
        self.assertEqual(self.vision.clicks, [])
        self.assertEqual(gateway_module.timestamp(self.config["expiresAt"]) - gateway_module.timestamp(self.config["createdAt"]), 300)
        status = self.gateway.status()
        self.assertTrue(status["ready"])
        self.assertFalse(status["capabilities"]["stableChatIds"])
        self.assertTrue(status["capabilities"]["scopedStableChatIds"])
        self.assertEqual(status["allowedChatIds"], [RECIPE["chatId"]])
        self.assertEqual(status["testPrefix"], RECIPE["testPrefix"])
        self.assertNotIn("bearerToken", status)
        self.assertEqual(self.reads, 0)

    def test_other_chat_workspace_fields_or_large_body_are_rejected_without_read_or_send(self):
        for change in ({"chatId": "wxid_other"}, {"workspaceToken": "legacy@2"}, {"extra": 1}, {"text": "长" * 301}):
            with self.assertRaises(gateway_module.GatewayError):
                self.gateway.send(self.payload(**change))
        self.assertEqual(self.sends, 0)
        self.assertEqual(self.reads, 0)

    def test_sent_requires_native_hash_receipt_and_persistent_idempotency(self):
        result = self.gateway.send(self.payload())
        self.assertEqual(result["status"], "sent")
        self.assertTrue(result["readback"])
        self.assertEqual(result["messageId"], "101")
        self.assertEqual(result["workspaceToken"], "legacy@1")
        self.assertEqual(result["textSha256"], gateway_module.shared.sha(self.payload()["text"]))
        reopened = self.make_gateway()
        self.assertTrue(reopened.send(self.payload())["duplicate"])
        self.assertEqual(self.sends, 1)
        self.assertEqual(self.reads, 2)
        with self.assertRaises(gateway_module.GatewayError):
            reopened.send(self.payload(text="更换正文应拒绝"))

    def test_unknown_consumes_quota_revokes_and_never_retries(self):
        self.no_readback = True
        result = self.gateway.send(self.payload())
        self.assertEqual(result["status"], "unknown")
        self.assertFalse(result["readback"])
        self.assertEqual(self.gateway.remaining(), 2)
        self.assertFalse(self.gateway.status()["ready"])
        self.assertTrue(self.make_gateway().send(self.payload())["duplicate"])
        self.assertEqual(self.sends, 1)

    def test_maximum_three_attempts_are_enforced(self):
        for index in range(3):
            self.assertEqual(self.gateway.send(self.payload(key=f"request-{index}"))["status"], "sent")
        reads = self.reads
        with self.assertRaises(gateway_module.GatewayError):
            self.gateway.send(self.payload(key="request-4"))
        self.assertEqual(self.sends, 3)
        self.assertEqual(self.reads, reads)
        self.assertEqual(self.gateway.remaining(), 0)

    def test_expiry_and_workspace_change_persistently_revoke(self):
        self.now += 301
        self.assertFalse(self.gateway.status()["ready"])
        self.now -= 301
        self.assertFalse(self.gateway.status()["ready"])
        self.assertEqual(self.sends, 0)

    def test_wrong_target_revokes_even_if_window_later_restored(self):
        self.target_error = "TARGET_TITLE_MISMATCH"
        self.assertFalse(self.gateway.status()["ready"])
        self.target_error = None
        self.assertFalse(self.gateway.status()["ready"])
        self.assertEqual(self.sends, 0)

    def test_workspace_revision_change_revokes_and_does_not_resume(self):
        registry = {"version": 1, "activeId": "legacy", "revision": 2, "accounts": [{"id": "legacy", "dbDir": str(self.database)}]}
        self.save("accounts.json", registry)
        status = self.gateway.status()
        self.assertFalse(status["ready"])
        self.assertEqual(status["code"], "WORKSPACE_CHANGED")
        registry["revision"] = 1
        self.save("accounts.json", registry)
        self.assertFalse(self.gateway.status()["ready"])
        self.assertEqual(self.sends, 0)

    def test_interrupted_inflight_is_unknown_and_never_replayed(self):
        payload = self.payload()
        with self.gateway.connect() as con:
            con.execute("INSERT INTO attempts(scope,id,authorization,chat_id,body_sha,status) VALUES(?,?,?,?,?,'inflight')", ("legacy", payload["idempotencyKey"], self.config["authorizationId"], payload["chatId"], gateway_module.shared.sha(payload["text"])))
        result = self.make_gateway().send(payload)
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["code"], "INFLIGHT_NO_RETRY")
        self.assertFalse(result["readback"])
        self.assertEqual(self.sends, 0)
        self.assertEqual(self.reads, 0)
        self.assertEqual(self.gateway.remaining(), 2)

    def test_readback_ignores_other_chat_hash_direction_and_old_native_id(self):
        owner = self

        class Reader:
            def __init__(self, _bound, _chat):
                self.calls = 0

            def read(self, *_args, **_kwargs):
                self.calls += 1
                item = {"chatId": RECIPE["chatId"], "nativeId": "41", "outbound": True, "textSha256": gateway_module.shared.sha(owner.payload()["text"])}
                return [item] if self.calls == 1 else [item, {**item, "nativeId": "42", "chatId": "wxid_other"}, {**item, "nativeId": "43", "outbound": False}, {**item, "nativeId": "44", "textSha256": "wrong"}, {**item, "nativeId": "45"}]

        scoped = gateway_module.Gateway(self.root, self.config, target_factory=self.gateway.target_factory, reader_factory=Reader, now=lambda: self.now, monotonic=lambda: self.tick, sleep=lambda _: None, metadata_probe=self.metadata_probe)
        result = scoped.send(self.payload())
        self.assertEqual(result["status"], "sent")
        self.assertEqual(result["messageId"], "45")
        self.assertEqual(self.sends, 1)

    def test_exact_body_ocr_mismatch_blocks_send_click(self):
        target = gateway_module.ScopedTarget(self.config, vision_factory=lambda: self.vision, sleep=lambda _: None)
        target.paste_once = lambda _text: setattr(self.vision, "body", "正文b被误写为-")
        with self.assertRaises(gateway_module.GatewayError) as raised:
            target.send_once("正文b被正确保留", lambda: None)
        self.assertEqual(raised.exception.code, "BODY_OCR_MISMATCH")
        self.assertEqual(self.vision.clicks, [RECIPE["inputPoint"]])

    def test_http_requires_token_and_returns_scope_in_receipt(self):
        server = gateway_module.ThreadingHTTPServer(("127.0.0.1", 0), gateway_module.handler_for(self.gateway))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            with self.assertRaises(HTTPError) as denied:
                urlopen(base + "/kexu/v1/status", timeout=3)
            self.assertEqual(denied.exception.code, 403)
            headers = {"Authorization": "Bearer " + self.config["bearerToken"], "Content-Type": "application/json"}
            with urlopen(Request(base + "/kexu/v1/status", headers=headers), timeout=3) as response:
                self.assertTrue(json.load(response)["ready"])
            with urlopen(Request(base + "/kexu/v1/send", data=json.dumps(self.payload()).encode("utf-8"), headers=headers), timeout=3) as response:
                result = json.load(response)
            self.assertEqual(result["status"], "sent")
            self.assertEqual(result["workspaceToken"], "legacy@1")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

    def scan_setup(self):
        vision = ScanVision()
        recipe = {**copy.deepcopy(RECIPE), "listScanRange": [100, 400]}
        config = gateway_module.calibrate(self.root, "legacy@1", recipe, vision_factory=lambda: vision, now=lambda: self.now)
        return vision, config

    def test_list_target_can_move_up_and_down_with_unique_same_shift_signatures(self):
        vision, config = self.scan_setup()
        self.assertEqual(config["listSignatureOffset"]["y"], 0)
        for shift in (-70, 120):
            with self.subTest(shift=shift):
                vision.rows = [(shift, True)]
                vision.captured = []
                gateway_module.ScopedTarget(config, vision_factory=lambda: vision).verify()
                self.assertIn([350, 100, 400, 400], vision.captured)
                self.assertIn([410, 100, 420, 400], vision.captured)
                self.assertFalse(any(rect[0] < 410 < rect[2] and rect[3] - rect[1] == 300 for rect in vision.captured))
        self.assertEqual(vision.clicks, [])

    def test_same_avatar_on_unselected_row_does_not_match(self):
        vision, config = self.scan_setup()
        vision.rows = [(-70, False), (120, True)]
        self.assertEqual(gateway_module.matching_list_shifts(vision, config["identity"], config), [120])
        gateway_module.ScopedTarget(config, vision_factory=lambda: vision).verify()
        vision.rows = [(-70, False)]
        with self.assertRaises(gateway_module.GatewayError) as raised:
            gateway_module.ScopedTarget(config, vision_factory=lambda: vision).verify()
        self.assertEqual(raised.exception.code, "TARGET_SIGNATURE_CHANGED")

    def test_multiple_selected_signature_matches_are_rejected(self):
        vision, config = self.scan_setup()
        vision.rows = [(-70, True), (120, True)]
        with self.assertRaises(gateway_module.GatewayError) as raised:
            gateway_module.ScopedTarget(config, vision_factory=lambda: vision).verify()
        self.assertEqual(raised.exception.code, "TARGET_SIGNATURE_AMBIGUOUS")
        self.assertEqual(vision.clicks, [])

    def test_no_scan_range_keeps_static_signature_behavior(self):
        vision = ScanVision()
        config = gateway_module.calibrate(self.root, "legacy@1", copy.deepcopy(RECIPE), vision_factory=lambda: vision, now=lambda: self.now)
        vision.rows = [(120, True)]
        with self.assertRaises(gateway_module.GatewayError):
            gateway_module.ScopedTarget(config, vision_factory=lambda: vision).verify()
        self.assertNotIn("listSignatureOffset", config)

    def test_scan_calibration_rejects_unselected_plain_background(self):
        vision = ScanVision()
        vision.rows = [(0, False)]
        with self.assertRaises(gateway_module.GatewayError) as raised:
            gateway_module.calibrate(self.root, "legacy@1", {**copy.deepcopy(RECIPE), "listScanRange": [100, 400]}, vision_factory=lambda: vision, now=lambda: self.now)
        self.assertEqual(raised.exception.code, "TARGET_SELECTION_UNVERIFIED")

    def test_ocr_scale_requires_exact_supported_integer_type(self):
        self.assertEqual(gateway_module.ocr_scale({}), 1)
        for value in (1, 2, 3):
            self.assertEqual(gateway_module.ocr_scale({"ocrScale": value}), value)
        for value in (True, False, "2", 2.0, 0, 4, None):
            with self.subTest(value=value), self.assertRaises(gateway_module.GatewayError):
                gateway_module.calibrate(self.root, "legacy@1", {**copy.deepcopy(RECIPE), "ocrScale": value}, vision_factory=lambda: self.vision, now=lambda: self.now)

    def test_scaled_header_and_body_are_passed_to_ocr_in_memory(self):
        captured = []
        original_ocr = self.vision.ocr

        def observe(image):
            captured.append((image.role, image.size))
            return original_ocr(image)

        self.vision.ocr = observe
        config = gateway_module.calibrate(self.root, "legacy@1", {**copy.deepcopy(RECIPE), "ocrScale": 2}, vision_factory=lambda: self.vision, now=lambda: self.now)
        self.assertEqual(config["ocrScale"], 2)
        self.assertEqual(captured[-1], ("header", (40, 40)))
        self.vision.body = "合成回复"
        target = gateway_module.ScopedTarget(config, vision_factory=lambda: self.vision)
        target.verify(expected="合成回复")
        self.assertIn(("input", (40, 40)), captured)
        before = len(captured)
        image = Image()
        gateway_module.recognize_text(self.vision, image, {})
        self.assertEqual(captured[before], ("header", (20, 20)))
        gateway_module.recognize_text(self.vision, image, {"ocrScale": 3})
        self.assertEqual(captured[-1], ("header", (60, 60)))

    def test_unprefixed_test_flag_defaults_false_and_requires_boolean(self):
        self.assertFalse(gateway_module.accept_unprefixed_test_messages({}))
        self.assertFalse(self.config["acceptUnprefixedTestMessages"])
        self.assertFalse(self.gateway.status()["acceptUnprefixedTestMessages"])
        for value in (True, False):
            config = gateway_module.calibrate(self.root, "legacy@1", {**copy.deepcopy(RECIPE), "acceptUnprefixedTestMessages": value}, vision_factory=lambda: self.vision, now=lambda: self.now)
            scoped = gateway_module.Gateway(self.root, config, target_factory=self.gateway.target_factory, reader_factory=self.gateway.reader_factory, now=lambda: self.now, metadata_probe=self.metadata_probe)
            self.assertEqual(config["acceptUnprefixedTestMessages"], value)
            self.assertEqual(scoped.status()["acceptUnprefixedTestMessages"], value)
            with self.assertRaises(gateway_module.GatewayError):
                scoped.send(self.payload(chatId="wxid_other"))
        for value in (1, 0, "true", "false", None):
            with self.subTest(value=value), self.assertRaises(gateway_module.GatewayError):
                gateway_module.calibrate(self.root, "legacy@1", {**copy.deepcopy(RECIPE), "acceptUnprefixedTestMessages": value}, vision_factory=lambda: self.vision, now=lambda: self.now)

    def test_status_transient_signature_change_can_recover_without_extending_grant(self):
        original_expiry = self.config["expiresAt"]
        self.target_error = "TARGET_SIGNATURE_CHANGED"
        transient = self.gateway.status()
        self.assertFalse(transient["ready"])
        self.assertEqual(transient["code"], "TARGET_SIGNATURE_CHANGED")
        self.target_error = None
        recovered = self.gateway.status()
        self.assertTrue(recovered["ready"])
        self.assertEqual(recovered["expiresAt"], original_expiry)
        self.assertEqual(recovered["remainingSends"], 3)
        self.assertEqual(self.sends, 0)

    def test_send_signature_failure_still_permanently_revokes(self):
        self.target_error = "TARGET_SIGNATURE_CHANGED"
        with self.assertRaises(gateway_module.GatewayError):
            self.gateway.send(self.payload())
        self.target_error = None
        self.assertFalse(self.gateway.status()["ready"])
        with self.assertRaises(gateway_module.GatewayError):
            self.gateway.send(self.payload(key="new-request"))
        self.assertEqual(self.sends, 0)
        self.assertEqual(self.reads, 0)

    def test_previously_revoked_signature_grant_is_not_revived_by_status(self):
        self.gateway.revoke("TARGET_SIGNATURE_CHANGED")
        self.assertFalse(self.gateway.status()["ready"])
        reopened = self.make_gateway()
        self.assertFalse(reopened.status()["ready"])
        with self.assertRaises(gateway_module.GatewayError):
            reopened.send(self.payload())
        self.assertEqual(self.sends, 0)

    def test_background_window_is_configured_ready_without_visual_capture(self):
        self.foreground = False
        expiry = self.config["expiresAt"]
        status = self.gateway.status()
        self.assertTrue(status["ready"])
        self.assertFalse(status["foregroundReady"])
        self.assertTrue(status["requiresForeground"])
        self.assertEqual(status["code"], "NEEDS_FOREGROUND")
        self.assertEqual(self.visual_checks, 0)
        self.assertEqual(self.reads, 0)
        self.foreground = True
        recovered = self.gateway.status()
        self.assertTrue(recovered["ready"])
        self.assertTrue(recovered["foregroundReady"])
        self.assertEqual(recovered["expiresAt"], expiry)
        self.assertEqual(self.gateway.remaining(), 3)

    def test_background_availability_never_bypasses_send_foreground_gate(self):
        self.foreground = False
        self.assertTrue(self.gateway.status()["ready"])
        with self.assertRaises(gateway_module.GatewayError) as raised:
            self.gateway.send(self.payload())
        self.assertEqual(raised.exception.code, "VISUAL_NOT_FOREGROUND")
        self.assertEqual(self.sends, 0)
        self.assertEqual(self.reads, 0)
        self.foreground = True
        self.assertFalse(self.gateway.status()["ready"])

    def test_background_metadata_drift_revokes_and_exact_fields_are_required(self):
        expected = copy.deepcopy(self.config["identity"])
        gateway_module.validate_bound_metadata(expected, copy.deepcopy(expected))
        for key, value in (("pid", 99), ("processCreated", "other"), ("clientOrigin", [101, 100]), ("clientSize", [999, 800]), ("dpi", 96), ("windowClass", "other")):
            with self.subTest(key=key), self.assertRaises(gateway_module.GatewayError):
                gateway_module.validate_bound_metadata(expected, {**expected, key: value})
        self.foreground, self.metadata_error = False, "TARGET_WINDOW_CHANGED"
        self.assertFalse(self.gateway.status()["ready"])
        self.assertEqual(self.visual_checks, 0)
        self.foreground, self.metadata_error = True, None
        self.assertFalse(self.gateway.status()["ready"])

    def test_old_foreground_revocation_is_not_revived(self):
        self.gateway.revoke("VISUAL_NOT_FOREGROUND")
        self.foreground = False
        self.assertFalse(self.gateway.status()["ready"])
        self.foreground = True
        self.assertFalse(self.make_gateway().status()["ready"])


if __name__ == "__main__":
    unittest.main()
