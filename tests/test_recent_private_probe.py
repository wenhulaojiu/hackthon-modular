"""水位探针只使用合成SQLite，不导入真实微信组件。"""
from contextlib import contextmanager
import hashlib
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("recent_probe", Path(__file__).resolve().parents[1] / "scripts/local-wechat/recent-private-probe.py")
probe_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe_module)
START = 1794024000000


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.chats = ["wxid_customer", "wxid_merchant_only", "gh_public", "group@chatroom", "wxid_owner"]
        self.table = lambda name: "Msg_" + hashlib.md5(name.encode()).hexdigest()
        self.connections = {}
        self.opens = []
        files = []
        for index in range(2):
            filename = self.directory / f"message_{index}.db"
            filename.write_text("合成占位", encoding="utf-8")
            files.append(filename)
            con = sqlite3.connect(":memory:")
            con.row_factory = sqlite3.Row
            con.execute("CREATE TABLE Name2Id(user_name TEXT)")
            con.executemany("INSERT INTO Name2Id VALUES (?)", [(name,) for name in self.chats])
            for name in self.chats:
                con.execute(f'CREATE TABLE "{self.table(name)}"(local_id INTEGER,server_id INTEGER,create_time INTEGER,local_type INTEGER,real_sender_id INTEGER,message_content TEXT)')
            # SQL层明确禁止读取正文列，避免测试只检查输出而漏掉内部正文查询。
            con.set_authorizer(lambda action, table, column, _db, _trigger: sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_READ and column == "message_content" else sqlite3.SQLITE_OK)
            self.connections[filename] = con
            self.addCleanup(con.close)
        @contextmanager
        def database(filename):
            self.opens.append(filename.name)
            yield self.connections[filename]
        self.account = SimpleNamespace(contact_file=self.directory / "missing-contact.db", files=files, database=database, own_username="wxid_owner")
        self.api = SimpleNamespace(read_contacts=lambda _con: {}, message_tables=lambda con: {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE name LIKE 'Msg_%'")}, shard_usernames=lambda _con: self.chats, build_catalog=lambda _contacts, _names, _tables: [{"username": name, "name": name, "type": "group" if "@" in name else "private"} for name in self.chats], message_table=self.table)

    def insert(self, chat, server, *, shard=0, sender=None, at=START + 1000):
        con = self.connections[self.account.files[shard]]
        author = self.chats.index(sender or chat) + 1
        con.execute(f'INSERT INTO "{self.table(chat)}" VALUES (?,?,?,?,?,?)', (server, server, at // 1000, 1, author, "不可读取的合成正文"))

    def run_probe(self):
        return probe_module.probe(self.account, self.api, START, START + 5000)

    def test_first_probe_keeps_new_inbound_and_ignores_old_system_and_own_chat(self):
        self.insert("wxid_customer", 100, at=START - 1000)
        self.insert("wxid_customer", 101)
        self.insert("gh_public", 102)
        self.insert("group@chatroom", 103)
        self.insert("wxid_owner", 104)
        result = self.run_probe()
        self.assertEqual([item["id"] for item in result], ["wxid_customer"])
        self.assertTrue(result[0]["inbound"])
        self.assertEqual(result[0]["lastIncomingAt"], START + 1000)
        self.assertEqual(self.opens, ["message_0.db", "message_1.db"])
        self.assertNotIn("不可读取", str(result))

    def test_same_second_new_native_id_changes_watermark(self):
        self.insert("wxid_customer", 101)
        first = self.run_probe()[0]
        self.insert("wxid_customer", 102)
        second = self.run_probe()[0]
        self.assertEqual(first["timestamp"], second["timestamp"])
        self.assertNotEqual(first["watermark"], second["watermark"])

    def test_merchant_only_is_visible_to_selected_but_not_new_customer(self):
        self.insert("wxid_merchant_only", 201, sender="wxid_owner")
        result = self.run_probe()[0]
        self.assertFalse(result["inbound"])
        self.assertIsNone(result["lastIncomingAt"])

    def test_duplicate_native_ids_across_shards_are_rejected(self):
        self.insert("wxid_customer", 301)
        self.insert("wxid_customer", 301, shard=1)
        with self.assertRaisesRegex(ValueError, "DUPLICATE"):
            self.run_probe()

    def test_unverified_exporter_is_rejected_before_import(self):
        (self.directory / "scripts").mkdir()
        (self.directory / "scripts/export_wechat.py").write_text("raise RuntimeError('不得执行')", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "UNVERIFIED"):
            probe_module.load_exporter(self.directory)

    def test_system_10000_without_author_is_metadata_only_and_recall_is_excluded(self):
        con = self.connections[self.account.files[0]]
        con.execute(f'INSERT INTO "{self.table("wxid_customer")}" VALUES (?,?,?,?,?,?)', (401, 0, (START + 1000) // 1000, 10000, 999, "你已添加了合成好友，现在可以开始聊天了。"))
        con.execute(f'INSERT INTO "{self.table("wxid_merchant_only")}" VALUES (?,?,?,?,?,?)', (402, 0, (START + 1000) // 1000, 10002, 999, "合成撤回消息"))
        result = self.run_probe()
        self.assertEqual([item["id"] for item in result], ["wxid_customer"])
        self.assertTrue(result[0]["systemChanged"])
        self.assertEqual(result[0]["lastSystemAt"], START + 1000)
        self.assertFalse(result[0]["inbound"])
        self.assertNotIn("合成好友", str(result))


if __name__ == "__main__":
    unittest.main()
