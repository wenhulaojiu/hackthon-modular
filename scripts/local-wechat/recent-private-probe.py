"""借助固定导出组件只读检查新私聊水位，不查询或返回聊天正文。"""
import argparse
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import sys

EXPORTER_SHA256 = "e98528025a274623702128d822909c01a79ceee5d864084edb1882f6e666554e"
SYSTEM = {"filehelper", "weixin", "fmessage", "newsapp", "medianote", "floatbottle", "qmessage", "tmessage", "qqmail", "weibo", "feedsapp", "brandsessionholder", "notifymessage", "weixinreminder", "officialaccounts", "notification_messages", "wxpay", "shakeapp"}


def private_id(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.+-]{1,160}", value) and not value.startswith(("-", "gh_", "wxpay_")) and value.lower() not in SYSTEM


def load_exporter(root):
    script = Path(root) / "scripts/export_wechat.py"
    source = script.read_text(encoding="utf-8").replace("\r\n", "\n")
    if hashlib.sha256(source.encode("utf-8")).hexdigest() != EXPORTER_SHA256:
        raise ValueError("EXPORTER_UNVERIFIED")
    sys.path.insert(0, str(script.parent))
    spec = importlib.util.spec_from_file_location("kexu_verified_exporter", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def probe(account, api, started_at, until):
    if not isinstance(started_at, int) or not isinstance(until, int) or started_at < 0 or until < started_at:
        raise ValueError("TIME_INVALID")
    contacts = {}
    if account.contact_file.is_file():
        with account.database(account.contact_file) as con:
            contacts = api.read_contacts(con)
    tables, usernames, rows_by_table = set(), set(), {}
    total = 0
    for filename in account.files:
        if filename.stat().st_size == 0:
            continue
        # 每个分片只打开、认证、解密一次，目录和水位查询复用同一内存快照。
        with account.database(filename) as con:
            shard_tables = api.message_tables(con)
            tables.update(shard_tables)
            usernames.update(api.shard_usernames(con))
            has_names = con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND lower(name)='name2id'").fetchone()
            for table in shard_tables:
                if not re.fullmatch(r"Msg_[a-fA-F0-9]{32}", table, re.IGNORECASE):
                    raise ValueError("TABLE_INVALID")
                columns = {row[1].lower() for row in con.execute(f'PRAGMA table_info("{table}")')}
                if not {"local_id", "server_id", "create_time", "local_type", "real_sender_id"} <= columns:
                    raise ValueError("TABLE_UNSUPPORTED")
                latest = con.execute(f'SELECT MAX(create_time) FROM "{table}"').fetchone()[0]
                scale = 1000 if latest is not None and int(latest) > 100_000_000_000 else 1
                # 系统提示可能没有作者；普通文字仍需明确方向，均不查询正文列。
                author = "n.user_name" if has_names else "NULL"
                join = "LEFT JOIN Name2Id n ON n.rowid=m.real_sender_id" if has_names else ""
                sql = f'SELECT m.local_id,m.server_id,m.create_time,m.local_type,{author} AS sender_username FROM "{table}" m {join} WHERE m.create_time>=? AND m.create_time<=? AND m.local_type IN (1,10000)'
                for raw in con.execute(sql, ((started_at + 999) // 1000 * scale, until // 1000 * scale)):
                    total += 1
                    if total > 100_000:
                        raise ValueError("PROBE_CAPACITY")
                    row = dict(raw)
                    row["timestamp"] = int(row["create_time"]) // scale * 1000
                    row["database"] = filename.name
                    rows_by_table.setdefault(table.lower(), []).append(row)
    catalog = api.build_catalog(contacts, usernames, tables)
    result = []
    seen_chats = set()
    server_owners = {}
    for chat in catalog:
        chat_id = chat.get("username")
        if chat.get("type") != "private" or not private_id(chat_id) or chat_id == account.own_username:
            continue
        if chat_id in seen_chats:
            raise ValueError("DUPLICATE_CHAT")
        seen_chats.add(chat_id)
        records = {}
        incoming_times = []
        system_times = []
        for row in rows_by_table.get(api.message_table(chat_id).lower(), []):
            is_system = str(row["local_type"]) == "10000"
            if not is_system and row["sender_username"] not in (chat_id, account.own_username):
                continue
            server = str(row["server_id"] or "")
            local = str(row["local_id"] or "")
            identity = "server:" + server if re.fullmatch(r"[0-9]+", server) and int(server) > 0 else "local:" + row["database"] + ":" + local if re.fullmatch(r"[0-9]+", local) and int(local) > 0 else None
            if identity is None:
                raise ValueError("MESSAGE_ID_INVALID")
            evidence = (row["timestamp"], "system" if is_system else "customer" if row["sender_username"] == chat_id else "merchant")
            if identity in records or identity.startswith("server:") and identity in server_owners:
                raise ValueError("MESSAGE_ID_DUPLICATE")
            records[identity] = evidence
            if identity.startswith("server:"):
                server_owners[identity] = chat_id
            if evidence[1] == "customer":
                incoming_times.append(row["timestamp"])
            elif is_system:
                system_times.append(row["timestamp"])
        if records:
            material = json.dumps(sorted(records.items()), separators=(",", ":"), ensure_ascii=True)
            result.append({"id": chat_id, "name": str(chat.get("name") or chat_id)[:120], "type": "private", "timestamp": max(value[0] for value in records.values()), "watermark": hashlib.sha256(material.encode("utf-8")).hexdigest(), "inbound": bool(incoming_times), "lastIncomingAt": max(incoming_times) if incoming_times else None, "systemChanged": bool(system_times), "lastSystemAt": max(system_times) if system_times else None})
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exporter-root", required=True)
    parser.add_argument("--db-dir", required=True)
    parser.add_argument("--workspace-token", required=True)
    parser.add_argument("--started-at", required=True, type=int)
    parser.add_argument("--until", required=True, type=int)
    args = parser.parse_args()
    if not re.fullmatch(r"acct-[a-f0-9]{20}@[1-9][0-9]*", args.workspace_token):
        raise ValueError("WORKSPACE_INVALID")
    # 上游诊断只留在进程内，不把路径、账号或内存检查输出传给Node。
    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
        api = load_exporter(args.exporter_root)
        with api.LocalAccount(Path(args.db_dir)) as account:
            chats = probe(account, api, args.started_at, args.until)
    print(json.dumps({"status": "watermarked", "workspaceToken": args.workspace_token, "chats": chats, "message_bodies_read": False, "files_written": False}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"status": "failed", "reason": "RECENT_PRIVATE_PROBE_FAILED"}))
        sys.exit(1)
