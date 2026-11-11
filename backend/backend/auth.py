"""auth.py - employee sign-in, sessions and the login history.

Everything lives in its own MySQL schema (config.AUTH_DB). That schema is hidden from the Database drop-down, so it
never appears as a provider table. Passwords are stored only as salted PBKDF2 hashes (never in clear text)."""
import hashlib
import hmac
import os
import re
import secrets
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import config
import db

ITER, MAX_FAILS, MAX_FAILS_IP, LOCK_MIN = 200_000, 5, 20, 10   # hash cost / wrong passwords per ID / per IP address / minutes to wait
ID_OK = re.compile(r"^[A-Za-z0-9_.-]{3,30}$")
_ready = False


class AuthError(Exception):
    def __init__(self, msg, code=401):
        super().__init__(msg)
        self.msg, self.code = msg, code


# ------------------------------------------------------------------ passwords
def hash_pw(pw, salt=None):
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), ITER).hex()
    return f"pbkdf2${ITER}${salt}${h}"


def check_pw(pw, stored):
    try:
        _, it, salt, h = stored.split("$")
        t = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(it)).hex()
    except ValueError:
        return False
    return hmac.compare_digest(t, h)


DUMMY = hash_pw("not-a-real-password")               # unknown IDs cost the same time as known ones
_sha = lambda token: hashlib.sha256((token or "").encode()).hexdigest()


def _check_new(pw):
    if not pw or len(pw) < 6:
        raise ValueError("Password must be at least 6 characters")
    if len(pw) > 100:
        raise ValueError("Password is too long (max 100 characters)")


# ------------------------------------------------------------------ schema + built-in first login
def setup():
    global _ready
    if _ready:
        return
    db.run(lambda c: c.execute(f"CREATE DATABASE IF NOT EXISTS {db.ident(config.AUTH_DB)} CHARACTER SET utf8mb4"), use_db=False)

    def go(c):
        t = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
        c.execute("CREATE TABLE IF NOT EXISTS employees (emp_id VARCHAR(30) PRIMARY KEY, name VARCHAR(100) NOT NULL, "
                  "pw_hash VARCHAR(255) NOT NULL, default_pw TINYINT(1) NOT NULL DEFAULT 0, is_admin TINYINT(1) NOT NULL DEFAULT 0, added_by VARCHAR(30) NULL, "
                  f"created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, last_login DATETIME NULL) {t}")
        c.execute("CREATE TABLE IF NOT EXISTS sessions (token_hash CHAR(64) PRIMARY KEY, emp_id VARCHAR(30) NOT NULL, "
                  f"created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME NOT NULL) {t}")
        c.execute("CREATE TABLE IF NOT EXISTS login_log (id BIGINT AUTO_INCREMENT PRIMARY KEY, ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP, "
                  "emp_id VARCHAR(30), emp_name VARCHAR(100), action VARCHAR(20), ok TINYINT(1), ip VARCHAR(64), "
                  f"device VARCHAR(255), note VARCHAR(255)) {t}")
        c.execute("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema=%s AND table_name='employees' "
                  "AND column_name='is_admin'", (config.AUTH_DB,))
        if c.fetchone()["n"] == 0:                       # database created by an older version: add the role column
            c.execute("ALTER TABLE employees ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0 AFTER default_pw")
        c.execute("SELECT COUNT(*) AS n FROM employees")
        if c.fetchone()["n"] == 0:                       # first start: the built-in login (an administrator)
            d = config.DEFAULT_ADMIN
            c.execute("INSERT INTO employees (emp_id, name, pw_hash, default_pw, is_admin) VALUES (%s,%s,%s,1,1)",
                      (d["id"], d["name"], hash_pw(d["password"])))
        c.execute("SELECT COUNT(*) AS n FROM employees WHERE is_admin=1")
        if c.fetchone()["n"] == 0:                       # upgrade: nobody is an administrator yet -> the oldest account is
            c.execute("SELECT emp_id FROM employees ORDER BY created_at, emp_id LIMIT 1")
            r = c.fetchone()
            if r:
                c.execute("UPDATE employees SET is_admin=1 WHERE emp_id=%s", (r["emp_id"],))
    db.run(go, schema=config.AUTH_DB)
    _ready = True


def _public(u):
    return {"id": u["emp_id"], "name": u["name"], "default_pw": bool(u["default_pw"]), "admin": bool(u["is_admin"])}


def _log(c, emp_id, action, ok=True, ip="", device="", note="", name=None):
    if name is None:
        c.execute("SELECT name FROM employees WHERE emp_id=%s", (emp_id,))
        r = c.fetchone()
        name = r["name"] if r else ""
    c.execute("INSERT INTO login_log (emp_id, emp_name, action, ok, ip, device, note) VALUES (%s,%s,%s,%s,%s,%s,%s)",
              ((emp_id or "")[:30], name, action, int(ok), (ip or "")[:64], (device or "")[:255], (note or "")[:255]))


# ------------------------------------------------------------------ sign in / out
def login(emp_id, password, ip="", device=""):
    setup()
    emp_id = (emp_id or "").strip()[:30]

    def go(c):
        c.execute("DELETE FROM sessions WHERE expires_at < NOW()")
        c.execute("SELECT COUNT(*) AS n FROM login_log WHERE action='login' AND ok=0 AND emp_id=%s "
                  "AND ts > NOW() - INTERVAL %s MINUTE "
                  "AND ts > COALESCE((SELECT MAX(l.ts) FROM login_log l WHERE l.action='login' AND l.ok=1 AND l.emp_id=%s), '2000-01-01')",
                  (emp_id, LOCK_MIN, emp_id))
        if c.fetchone()["n"] >= MAX_FAILS:
            return None, f"Too many wrong attempts. Try again in {LOCK_MIN} minutes.", 429
        if ip:                                           # also limit by IP address, so one person cannot lock out everybody
            c.execute("SELECT COUNT(*) AS n FROM login_log WHERE action='login' AND ok=0 AND ip=%s "
                      "AND ts > NOW() - INTERVAL %s MINUTE", (ip[:64], LOCK_MIN))
            if c.fetchone()["n"] >= MAX_FAILS_IP:
                return None, f"Too many wrong attempts from this device. Try again in {LOCK_MIN} minutes.", 429
        c.execute("SELECT emp_id, name, pw_hash, default_pw, is_admin FROM employees WHERE emp_id=%s", (emp_id,))
        u = c.fetchone()
        ok = check_pw(password or "", u["pw_hash"] if u else DUMMY)
        if not (u and ok):
            _log(c, emp_id, "login", False, ip, device, name=u["name"] if u else "")
            return None, "Wrong employee ID or password.", 401
        token = secrets.token_urlsafe(32)
        c.execute("INSERT INTO sessions (token_hash, emp_id, expires_at) VALUES (%s,%s, NOW() + INTERVAL %s HOUR)",
                  (_sha(token), u["emp_id"], config.SESSION_HOURS))
        c.execute("UPDATE employees SET last_login=NOW() WHERE emp_id=%s", (u["emp_id"],))
        _log(c, u["emp_id"], "login", True, ip, device, name=u["name"])
        return token, _public(u), 200
    token, info, code = db.run(go, schema=config.AUTH_DB)      # (a failed attempt must be committed, so nothing is raised inside)
    if not token:
        raise AuthError(info, code)
    return token, info


def user_for(token):
    if not token:
        return None
    setup()
    rows = db.fetch("SELECT e.emp_id, e.name, e.default_pw, e.is_admin FROM sessions s JOIN employees e ON e.emp_id=s.emp_id "
                    "WHERE s.token_hash=%s AND s.expires_at > NOW()", (_sha(token),), schema=config.AUTH_DB)
    return _public(rows[0]) if rows else None


def logout(token, ip="", device=""):
    setup()

    def go(c):
        c.execute("SELECT emp_id FROM sessions WHERE token_hash=%s", (_sha(token),))
        r = c.fetchone()
        if r:
            c.execute("DELETE FROM sessions WHERE token_hash=%s", (_sha(token),))
            _log(c, r["emp_id"], "logout", True, ip, device)
    db.run(go, schema=config.AUTH_DB)


# ------------------------------------------------------------------ password
def change_password(emp_id, current, new, token, ip="", device=""):
    _check_new(new)

    def go(c):
        c.execute("SELECT pw_hash FROM employees WHERE emp_id=%s", (emp_id,))
        u = c.fetchone()
        if not u or not check_pw(current or "", u["pw_hash"]):
            raise ValueError("Current password is wrong")
        if current == new:
            raise ValueError("The new password must be different from the current one")
        c.execute("UPDATE employees SET pw_hash=%s, default_pw=0 WHERE emp_id=%s", (hash_pw(new), emp_id))
        c.execute("DELETE FROM sessions WHERE emp_id=%s AND token_hash<>%s", (emp_id, _sha(token)))   # sign out other devices
        _log(c, emp_id, "password_change", True, ip, device)
    db.run(go, schema=config.AUTH_DB)


# ------------------------------------------------------------------ team members
def members():
    setup()
    rows = db.fetch("SELECT emp_id, name, is_admin, added_by, created_at, last_login FROM employees ORDER BY created_at, emp_id",
                    schema=config.AUTH_DB)
    return [{k: (bool(v) if k == "is_admin" else db.jsonable(v)) for k, v in r.items()} for r in rows]


def add_member(by, emp_id, name, password, admin=False, ip="", device=""):
    emp_id, name = (emp_id or "").strip(), " ".join((name or "").split())
    if not ID_OK.match(emp_id):
        raise ValueError("Employee ID: 3-30 letters, numbers, dot, dash or underscore")
    if not name or len(name) > 100:
        raise ValueError("Enter the employee's name (max 100 characters)")
    _check_new(password)
    setup()

    def go(c):
        c.execute("SELECT 1 FROM employees WHERE emp_id=%s", (emp_id,))
        if c.fetchone():
            raise ValueError(f"Employee ID {emp_id} already exists")
        c.execute("INSERT INTO employees (emp_id, name, pw_hash, is_admin, added_by) VALUES (%s,%s,%s,%s,%s)",
                  (emp_id, name, hash_pw(password), int(bool(admin)), by))
        _log(c, by, "member_added", True, ip, device, f"{emp_id} - {name}" + (" (administrator)" if admin else ""))
    db.run(go, schema=config.AUTH_DB)


def remove_member(by, emp_id, ip="", device=""):
    if (emp_id or "").lower() == by.lower():
        raise ValueError("You cannot remove your own account")
    setup()

    def go(c):
        c.execute("SELECT name FROM employees WHERE emp_id=%s", (emp_id,))
        u = c.fetchone()
        if not u:
            raise LookupError(f"Employee {emp_id} not found")
        c.execute("DELETE FROM sessions WHERE emp_id=%s", (emp_id,))
        c.execute("DELETE FROM employees WHERE emp_id=%s", (emp_id,))
        _log(c, by, "member_removed", True, ip, device, f"{emp_id} - {u['name']}")
    db.run(go, schema=config.AUTH_DB)


# ------------------------------------------------------------------ login history
def audit(emp_id, action, note="", ip="", device=""):
    """write one line (e.g. a bulk upload) into the history"""
    setup()
    db.run(lambda c: _log(c, emp_id, action, True, ip, device, note), schema=config.AUTH_DB)


def history(limit=300):
    setup()
    limit = min(max(int(limit), 1), 2000)
    rows = db.fetch("SELECT id, ts, emp_id, emp_name, action, ok, ip, device, note FROM login_log ORDER BY id DESC LIMIT %s",
                    (limit,), schema=config.AUTH_DB)
    return [{k: db.jsonable(v) for k, v in r.items()} for r in rows]
