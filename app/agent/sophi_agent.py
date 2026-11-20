#!/usr/bin/env python3
"""Agent Sổ phí: gom file báo cáo/đối soát trên máy nội bộ rồi đẩy lên máy chủ Sổ phí (Cloudflare hoặc local).

Nguồn hỗ trợ:
  - folder: thư mục trên máy / ổ mạng (vd thư mục Outlook tự lưu file đính kèm, thư mục tải từ portal ngân hàng)
  - sftp:   máy chủ SFTP của ngân hàng / cổng thanh toán (cần `pip install paramiko`); dùng máy có IP cố định
            đã được ngân hàng/cổng cho phép

Chạy:  python sophi_agent.py --config agent.json            (một lần, đặt Task Scheduler chạy định kỳ)
       python sophi_agent.py --config agent.json --dry-run  (chỉ liệt kê, không đẩy)

Mỗi file chỉ đẩy một lần cho mỗi máy chủ (nhớ theo sha256 trong file trạng thái). Máy chủ cũng tự bỏ qua file trùng.
"""
import argparse
import fnmatch
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

OK_EXT = re.compile(r"\.(xlsx|xlsm|xls|csv|md|markdown|txt)$", re.I)


def month_of(name, mtime, rule):
    """Kỳ YYYY-MM của file. rule: "mtime" | "mtime-1" (tháng trước ngày sửa file) | "filename" (ngày trong tên file) | "YYYY-MM" cố định."""
    if re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", rule or ""):
        return rule
    if rule == "filename":
        m = re.search(r"(20\d{2})[-_.]?(0[1-9]|1[0-2])", name)
        if m:
            return f"{m.group(1)}-{m.group(2)}"
    d = datetime.fromtimestamp(mtime, tz=timezone.utc)
    y, mo = d.year, d.month
    if rule == "mtime-1":
        y, mo = (y - 1, 12) if mo == 1 else (y, mo - 1)
    return f"{y}-{mo:02d}"


def iter_folder(src):
    root = src["path"]
    pattern = src.get("pattern", "*")
    max_age = float(src.get("max_age_days", 62)) * 86400
    for dirpath, _, files in os.walk(root):
        for fn in files:
            if not OK_EXT.search(fn) or not fnmatch.fnmatch(fn.lower(), pattern.lower()):
                continue
            full = os.path.join(dirpath, fn)
            st = os.stat(full)
            if time.time() - st.st_mtime > max_age:
                continue
            with open(full, "rb") as f:
                yield fn, st.st_mtime, f.read()
        if not src.get("recursive", False):
            break


def iter_sftp(src):
    try:
        import paramiko  # type: ignore
    except ImportError:
        sys.exit("Nguồn sftp cần thư viện paramiko: pip install paramiko")
    host, port = src["host"], int(src.get("port", 22))
    client = paramiko.SSHClient()
    known = src.get("known_hosts")
    if known:
        client.load_host_keys(known)
    else:
        client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())  # không tự tin khoá máy chủ lạ
    password = os.environ.get(src["password_env"]) if src.get("password_env") else None
    client.connect(host, port=port, username=src["user"], password=password, key_filename=src.get("key_file"), timeout=30)
    try:
        sftp = client.open_sftp()
        pattern = src.get("pattern", "*")
        max_age = float(src.get("max_age_days", 62)) * 86400
        for attr in sftp.listdir_attr(src.get("remote_dir", ".")):
            fn = attr.filename
            if not OK_EXT.search(fn) or not fnmatch.fnmatch(fn.lower(), pattern.lower()):
                continue
            if time.time() - (attr.st_mtime or 0) > max_age:
                continue
            with sftp.open(src.get("remote_dir", ".").rstrip("/") + "/" + fn, "rb") as f:
                yield fn, attr.st_mtime or time.time(), f.read()
    finally:
        client.close()


def push(target, src, name, month, data, sha, agent_name):
    q = urllib.parse.urlencode({"month": month, "sec": src["sec"], "acq": src.get("acq", ""), "name": name, "sha256": sha, "agent": agent_name})
    url = target["url"].rstrip("/") + "/api/ingest?" + q
    token = os.environ.get(target.get("token_env", "SOPHI_INGEST_TOKEN"), "")
    if not token:
        raise RuntimeError(f"Thiếu biến môi trường {target.get('token_env', 'SOPHI_INGEST_TOKEN')} (INGEST_TOKEN của máy chủ)")
    # User-Agent riêng: Cloudflare chặn chữ ký mặc định "Python-urllib" (lỗi 1010)
    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/octet-stream", "User-Agent": "sophi-agent/1.0"}
    # máy chủ Cloudflare đặt sau Access: thêm service token
    if target.get("access_client_id_env"):
        headers["CF-Access-Client-Id"] = os.environ.get(target["access_client_id_env"], "")
        headers["CF-Access-Client-Secret"] = os.environ.get(target.get("access_client_secret_env", ""), "")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def save_state(path, state):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def main():
    # console Windows / Task Scheduler thường là cp1252: in tiếng Việt không được thì thay ký tự, không dừng chương trình
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", required=True)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    with open(a.config, encoding="utf-8") as f:
        cfg = json.load(f)
    state_path = cfg.get("state_file") or os.path.splitext(a.config)[0] + ".state.json"
    try:
        with open(state_path, encoding="utf-8") as f:
            state = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        state = {}
    agent_name = cfg.get("agent_name", os.environ.get("COMPUTERNAME", "agent"))
    errors = 0
    try:
        for src in cfg["sources"]:
            kind = src.get("type", "folder")
            it = iter_folder(src) if kind == "folder" else iter_sftp(src) if kind == "sftp" else None
            if it is None:
                print(f"[bỏ qua] nguồn lạ: {kind}")
                continue
            try:
                for name, mtime, data in it:
                    sha = hashlib.sha256(data).hexdigest()
                    month = month_of(name, mtime, src.get("month", "mtime"))
                    for target in cfg["targets"]:
                        key = target["url"] + "|" + sha
                        if key in state:
                            continue
                        label = f"{src.get('name', kind)}: {name} -> {month} {src['sec']}/{src.get('acq', '')} -> {target['url']}"
                        if a.dry_run:
                            print("[thử] " + label)
                            continue
                        try:
                            r = push(target, src, name, month, data, sha, agent_name)
                            state[key] = {"name": name, "month": month, "at": datetime.now(timezone.utc).isoformat(), "id": r.get("id")}
                            print(("[trùng] " if r.get("duplicate") else "[đã đẩy] ") + label)
                        except urllib.error.HTTPError as e:
                            errors += 1
                            print(f"[lỗi {e.code}] {label}: {e.read().decode('utf-8', 'replace')[:300]}")
                        except (urllib.error.URLError, OSError, RuntimeError, ValueError) as e:  # mạng, token...
                            errors += 1
                            print(f"[lỗi] {label}: {e}")
            except Exception as e:  # một nguồn lỗi (SFTP không kết nối được...) không chặn các nguồn khác
                errors += 1
                print(f"[lỗi nguồn] {src.get('name', kind)}: {e}")
    finally:
        if not a.dry_run:
            save_state(state_path, state)
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
