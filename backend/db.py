"""db.py - everything that talks to MySQL.

Nothing about the tables is hard-coded: the tables, their columns and types are read from MySQL (information_schema)
(cached for a few seconds), so a table you create in MySQL Workbench (or on the website) shows up automatically.
Table / column names that arrive from the browser are only ever used after they have been checked against that list.
Connections are pooled (a new TLS connection per query is slow on a cloud database)."""
import collections
import datetime
import decimal
import hashlib
import io
import logging
import os
import re
import shlex
import sys
import threading
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import openpyxl
import pymysql
from pymysql.cursors import DictCursor

import config

log = logging.getLogger("db")

SYSTEM = {"information_schema", "mysql", "performance_schema", "sys", config.AUTH_DB.lower()}
_state = {"db": config.MYSQL.get("database", "")}          # the schema is set in config.py (not on the website)

INTS = {"tinyint", "smallint", "mediumint", "int", "integer", "bigint"}
DECS = {"decimal", "numeric", "float", "double"}
LONGS = {"tinytext", "text", "mediumtext", "longtext", "json"}
SUMMED = re.compile(r"^(qty|quantity|amount|total|price|cost)$", re.I)     # these columns get a "total" box
CUSTOMER = re.compile(r"customer", re.I)
NAME_OK = re.compile(r"^[A-Za-z0-9_](?:[A-Za-z0-9_ .\-]{0,61}[A-Za-z0-9_\-])?$")
TYPES = {"text": "VARCHAR(255)", "longtext": "TEXT", "int": "INT", "decimal": "DECIMAL(14,2)", "date": "DATE"}


# ------------------------------------------------------------------ connection pool
_POOL_MAX, _IDLE_PING = 4, 30                  # idle connections kept per schema / seconds before an idle one is pinged
_LOST = (2006, 2013, 2055)                     # "server has gone away" / "lost connection"
_pool, _pool_lock = {}, threading.Lock()


def ident(name):
    """a safely quoted table / column name.  NOTE: '%' is doubled because pymysql runs `sql % args` whenever args is not
    None - so EVERY execute() that contains ident() must be given args (use `()` when there are none)."""
    return "`" + str(name).replace("`", "``").replace("%", "%%") + "`"


def _target(use_db, schema):
    return schema or ((_state["db"] or None) if use_db else None)


def _open(target):
    m = config.MYSQL
    kw = dict(host=m["host"], port=int(m["port"]), user=m["user"], password=m["password"], database=target,
              charset="utf8mb4", cursorclass=DictCursor, connect_timeout=5, read_timeout=120, write_timeout=120)
    ca = m.get("ssl_ca")
    if ca:
        if isinstance(ca, str) and os.path.isfile(ca):
            kw.update(ssl_ca=ca, ssl_verify_cert=True, ssl_verify_identity=True)
        elif str(ca).lower() in ("true", "1", "yes", "require", "system"):
            # Auto-detect Linux/Render system CA bundle if present
            for ca_path in ("/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/ca-bundle.pem"):
                if os.path.isfile(ca_path):
                    kw.update(ssl_ca=ca_path, ssl_verify_cert=True, ssl_verify_identity=True)
                    break
            else:
                kw.update(ssl={"ssl": True})
        else:
            kw.update(ssl_ca=ca)
    return pymysql.connect(**kw)


def connect(use_db=True, schema=None):                    # kept for compatibility (not pooled)
    return _open(_target(use_db, schema))


def _discard(conn):
    try:
        conn.close()
    except Exception:
        pass


def _acquire(target):
    while True:
        with _pool_lock:
            idle = _pool.get(target) or []
            item = idle.pop() if idle else None
        if item is None:
            return _open(target)
        conn, ts = item
        if time.time() - ts < _IDLE_PING:
            return conn
        try:
            conn.ping(reconnect=False)
            return conn
        except Exception:
            _discard(conn)


def _release(conn, target):
    with _pool_lock:
        idle = _pool.setdefault(target, [])
        if len(idle) < _POOL_MAX:
            idle.append((conn, time.time()))
            return
    _discard(conn)


def run(fn, use_db=True, schema=None):
    target = _target(use_db, schema)
    for attempt in (0, 1):
        conn = _acquire(target) if attempt == 0 else _open(target)
        try:
            with conn.cursor() as cur:
                out = fn(cur)
            conn.commit()
        except pymysql.err.OperationalError as e:
            _discard(conn)
            if attempt == 0 and e.args and e.args[0] in _LOST:      # a pooled connection the server had closed: retry once
                continue
            raise
        except BaseException:
            try:
                conn.rollback()
                _release(conn, target)
            except Exception:
                _discard(conn)
            raise
        else:
            _release(conn, target)
            return out


def fetch(sql, args=(), use_db=True, schema=None):
    def go(c):
        c.execute(sql, args)
        return c.fetchall()
    return run(go, use_db, schema)


def jsonable(v):
    if isinstance(v, decimal.Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    if isinstance(v, datetime.datetime):
        return v.isoformat(" ")
    if isinstance(v, (datetime.date, datetime.time, datetime.timedelta)):
        return str(v)
    if isinstance(v, (bytes, bytearray)):
        return bytes(v).decode("utf-8", "replace")
    return v


# ------------------------------------------------------------------ tiny schema cache
_TTL = 10
_cache, _cache_lock = {}, threading.Lock()


def _cached(key, fn):
    with _cache_lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < _TTL and hit[2] == _state["db"]:
            return hit[1]
    val = fn()
    with _cache_lock:
        _cache[key] = (time.time(), val, _state["db"])
    return val


def invalidate():
    """forget the cached table / column lists (call after any CREATE / ALTER)"""
    with _cache_lock:
        _cache.clear()


# ------------------------------------------------------------------ databases (schemas)
def databases():
    rows = fetch("SHOW DATABASES", (), use_db=False)
    return sorted((list(r.values())[0] for r in rows if list(r.values())[0].lower() not in SYSTEM), key=str.lower)


def status():
    try:
        dbs = databases()
    except Exception as e:
        return {"connected": False, "error": str(e), "database": "", "configured": _state["db"]}
    cur = _state["db"] if _state["db"] in dbs else ""
    return {"connected": True, "error": "", "database": cur, "configured": _state["db"]}


# ------------------------------------------------------------------ tables and columns (read from MySQL)
def table_names():
    if not _state["db"]:
        return []

    def load():
        rows = fetch("SELECT table_name AS name FROM information_schema.tables "
                     "WHERE table_schema=%s AND table_type='BASE TABLE' ORDER BY table_name", (_state["db"],))
        return [r["name"] for r in rows]
    return _cached("tables", load)


def require_table(name):
    if name not in table_names():
        raise LookupError(f"Table '{name}' not found")
    return name


def tables():
    names = table_names()

    def go(c):
        out = []
        for n in names:
            c.execute(f"SELECT COUNT(*) AS n FROM {ident(n)}", ())
            out.append({"name": n, "rows": c.fetchone()["n"]})
        return out
    return run(go) if names else []


def kind_of(name, dtype):
    if dtype in INTS:
        return "int"
    if dtype in DECS:
        return "decimal"
    if dtype == "date":
        return "date"
    if dtype in ("datetime", "timestamp"):
        return "datetime"
    if dtype in LONGS:
        return "longtext"
    if name.strip().lower() == "date":
        return "date_text"                    # a text column called DATE (as in the Excel sheets)
    return "text"


COLQ = ("SELECT table_name AS tname, column_name AS name, data_type AS dtype, column_type AS ctype, is_nullable AS nullable, "
        "column_key AS ckey, extra AS extra, column_default AS dflt FROM information_schema.columns "
        "WHERE table_schema=%s{} ORDER BY table_name, ordinal_position")


def _shape(rows):
    pks = [r["name"] for r in rows if r["ckey"] == "PRI"]
    out = []
    for r in rows:
        extra, dflt = (r["extra"] or "").lower(), r["dflt"]
        kind = kind_of(r["name"], (r["dtype"] or "").lower())
        auto = "auto_increment" in extra
        computed = len(pks) == 1 and r["name"] == pks[0] and kind == "int" and not auto     # e.g. row_no: filled with MAX+1
        stamp = dflt is not None and "current_timestamp" in str(dflt).lower()
        generated = "generated" in extra and "default_generated" not in extra
        hide = auto or computed or stamp or generated
        out.append({"name": r["name"], "type": r["ctype"], "kind": kind, "key": r["ckey"], "auto": auto, "computed": computed,
                    "hide": hide, "required": r["nullable"] == "NO" and dflt is None and not hide})
    return out


def columns(table):
    if table not in table_names():
        raise LookupError(f"Table '{table}' not found")
    return _cached(("cols", table), lambda: _shape(fetch(COLQ.format(" AND table_name=%s"), (_state["db"], table))))


def _all_cols():
    """{table: columns} for every table of the selected database (one query)"""
    def load():
        names = set(table_names())
        if not names:
            return {}
        by = {}
        for r in fetch(COLQ.format(""), (_state["db"],)):
            if r["tname"] in names:
                by.setdefault(r["tname"], []).append(r)
        return {t: _shape(rs) for t, rs in sorted(by.items(), key=lambda kv: kv[0].lower())}
    return _cached("allcols", load)


# ------------------------------------------------------------------ FETCH
def build_where(cols, f):
    names = {c["name"] for c in cols}
    w, a = [], []
    dc = f.get("date_col") or next((c["name"] for c in cols if c["name"].lower() == "date"), None)
    if dc and dc in names:
        if f.get("date_from"):
            w.append(f"{ident(dc)}>=%s"); a.append(f["date_from"])
        if f.get("date_to"):
            w.append(f"{ident(dc)}<=%s"); a.append(f["date_to"])
    if f.get("col") in names and f.get("val") not in (None, ""):
        w.append(f"{ident(f['col'])}=%s"); a.append(f["val"])
    cust = f.get("customer") or f.get("cf_customer")
    if cust and str(cust).strip() and cust != "__all__":
        cust_col = next((c["name"] for c in cols if c["name"].lower() == "customer"), None)
        if cust_col:
            w.append(f"LOWER(CAST({ident(cust_col)} AS CHAR)) LIKE %s"); a.append(f"%{str(cust).strip().lower()}%")
    prov = f.get("provider") or f.get("cf_provider")
    if prov and str(prov).strip().lower() not in ("__all__", "all data", "all providers", ""):
        prov_col = next((c["name"] for c in cols if c["name"].lower() == "provider"), None)
        if prov_col:
            w.append(f"LOWER(TRIM({ident(prov_col)}))=%s"); a.append(str(prov).strip().lower())

    # Requested by filter
    req_by = f.get("requested_by") or f.get("cf_requested_by") or f.get("cf_REQUESTED BY")
    if req_by and str(req_by).strip():
        req_col = next((c["name"] for c in cols if c["name"].lower() in ("requested by", "requested_by", "requestedby")), None)
        if req_col:
            w.append(f"LOWER(CAST({ident(req_col)} AS CHAR)) LIKE %s")
            a.append(f"%{str(req_by).strip().lower()}%")

    # Raised by filter
    raised_by = f.get("raised_by") or f.get("cf_raised_by") or f.get("cf_RAISED BY")
    if raised_by and str(raised_by).strip():
        raised_col = next((c["name"] for c in cols if c["name"].lower() in ("raised by", "raised_by", "raisedby")), None)
        if raised_col:
            w.append(f"LOWER(CAST({ident(raised_col)} AS CHAR)) LIKE %s")
            a.append(f"%{str(raised_by).strip().lower()}%")

    # Generic Excel column filters (cf_<colName>)
    col_map = {c["name"].lower(): c["name"] for c in cols}
    handled_keys = {"q", "col", "val", "customer", "cf_customer", "provider", "cf_provider",
                    "requested_by", "cf_requested_by", "cf_REQUESTED BY",
                    "raised_by", "cf_raised_by", "cf_RAISED BY",
                    "date_col", "date_from", "date_to", "sort", "desc", "limit", "offset", "table", "cols"}
    for k, v in f.items():
        if not v or str(v).strip() == "" or k in handled_keys:
            continue
        v_str = str(v).strip()
        col_name = None
        if k.startswith("cf_"):
            target_k = k[3:].lower()
            col_name = col_map.get(target_k)
        elif k.lower() in col_map:
            col_name = col_map[k.lower()]

        if col_name:
            cn = ident(col_name)
            cl = col_name.lower()
            if cl in ("qty", "quantity"):
                w.append(f"(LOWER(CAST({ident('qty')} AS CHAR)) LIKE %s OR LOWER(CAST({ident('Quantity')} AS CHAR)) LIKE %s)")
                a.extend([f"%{v_str.lower()}%", f"%{v_str.lower()}%"])
            elif "," in v_str:
                parts = [p.strip().lower() for p in v_str.split(",") if p.strip()]
                if parts:
                    placeholders = ", ".join(["%s"] * len(parts))
                    w.append(f"LOWER(TRIM(CAST({cn} AS CHAR))) IN ({placeholders})")
                    a.extend(parts)
            else:
                w.append(f"LOWER(CAST({cn} AS CHAR)) LIKE %s")
                a.append(f"%{v_str.lower()}%")
    # Search every column (supports multiple words, exact phrases, date formats, etc.)
    q_raw = (f.get("q") or "").strip()
    if q_raw:
        try:
            tokens = shlex.split(q_raw)
        except ValueError:
            tokens = [t.strip() for t in q_raw.split() if t.strip()]
        tokens = [t.strip() for t in tokens if t.strip()]

        for token in tokens:
            like = "%" + re.sub(r"([\\%_])", r"\\\1", token) + "%"
            parsed_date = clean_date_val(token)
            like_date = ("%" + parsed_date + "%") if parsed_date else None

            token_clauses = []
            token_args = []
            for c in cols:
                cn = ident(c["name"])
                if c.get("kind") in ("date", "datetime", "date_text") or c["name"].lower() == "date":
                    token_clauses.append(f"(CAST({cn} AS CHAR) LIKE %s OR DATE_FORMAT({cn}, '%%d-%%m-%%Y') LIKE %s OR DATE_FORMAT({cn}, '%%d/%%m/%%Y') LIKE %s)")
                    token_args.extend([like, like, like])
                    if like_date:
                        token_clauses.append(f"CAST({cn} AS CHAR) LIKE %s")
                        token_args.append(like_date)
                else:
                    token_clauses.append(f"CAST({cn} AS CHAR) LIKE %s")
                    token_args.append(like)
            if token_clauses:
                w.append("(" + " OR ".join(token_clauses) + ")")
                a.extend(token_args)
    return (" AND ".join(w) or "1=1"), a


def search(table, f, sort="", desc=True, limit=100, offset=0):
    cols = columns(table)
    names = [c["name"] for c in cols]
    where, args = build_where(cols, f)
    pk = next((c["name"] for c in cols if c["key"] == "PRI"), None)
    order = sort if sort in names else pk
    parts = []
    if order:
        parts.append(f"{ident(order)} {'DESC' if desc else 'ASC'}")
    if pk and pk != order:
        parts.append(f"{ident(pk)} DESC")
    orderby = (" ORDER BY " + ", ".join(parts)) if parts else ""
    sums = [n for n in names if SUMMED.match(n)]
    today_iso = datetime.date.today().isoformat()
    date_col = next((c["name"] for c in cols if c["name"].lower() in ("date", "activation_date")), None)
    today_expr = f", COALESCE(SUM(CASE WHEN CAST({ident(date_col)} AS CHAR) LIKE '{today_iso}%%' THEN 1 ELSE 0 END),0) AS today_n" if date_col else ", 0 AS today_n"
    sel = ", ".join(["COUNT(*) AS n"] + [f"COALESCE(SUM(CAST(NULLIF(TRIM({ident(n)}),'') AS DECIMAL(20,2))),0) AS s{i}"
                                         for i, n in enumerate(sums)]) + today_expr
    limit, offset = min(max(int(limit), 1), 50000), max(int(offset), 0)

    def go(c):
        c.execute(f"SELECT {sel} FROM {ident(table)} WHERE {where}", args)
        tot = c.fetchone()
        c.execute(f"SELECT * FROM {ident(table)} WHERE {where}{orderby} LIMIT %s OFFSET %s", args + [limit, offset])
        return tot, c.fetchall()
    tot, rows = run(go)
    return {"total": tot["n"], "today_count": jsonable(tot.get("today_n", 0)), "columns": names, "pk": pk,
            "sums": [{"column": n, "sum": jsonable(tot[f"s{i}"])} for i, n in enumerate(sums)],
            "rows": [{k: jsonable(v) for k, v in r.items()} for r in rows]}


def values(table, column, limit=2000):
    """the different values of one column (fills the drop-downs)"""
    if column not in [c["name"] for c in columns(table)]:
        raise LookupError(f"Column '{column}' not found")
    rows = fetch(f"SELECT DISTINCT {ident(column)} AS v FROM {ident(table)} WHERE {ident(column)} IS NOT NULL "
                 f"AND CAST({ident(column)} AS CHAR)<>'' ORDER BY v LIMIT %s", (int(limit),))
    return [jsonable(r["v"]) for r in rows]


def analytics(table, f=None):
    """Monthly activation percentages & Single vs Dual Profile distribution."""
    if f is None:
        f = {}
    if table == "__all__" or not table:
        table = "customer_data"
    cols = columns(table)
    where, args = build_where(cols, f)

    # 1. Monthly activations (based on date column)
    date_col = next((c["name"] for c in cols if c["name"].lower() in ("date", "activation_date")), None)
    monthly = []
    if date_col:
        sql = (f"SELECT LEFT(CAST({ident(date_col)} AS CHAR), 7) AS ym, COUNT(*) AS c "
               f"FROM {ident(table)} WHERE {where} AND {ident(date_col)} IS NOT NULL "
               f"GROUP BY ym ORDER BY ym")
        rows = run(lambda c: (c.execute(sql, args), c.fetchall())[1])
        tot_m = sum(r["c"] for r in rows) or 1
        MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        for r in rows:
            ym = str(r["ym"] or "").strip()
            if not ym:
                continue
            parts = ym.split("-")
            label = ym
            if len(parts) == 2 and parts[1].isdigit():
                m_num = int(parts[1])
                if 1 <= m_num <= 12:
                    label = f"{MONTH_NAMES[m_num]} {parts[0]}"
            monthly.append({
                "key": ym,
                "label": label,
                "count": int(r["c"]),
                "pct": round(r["c"] / tot_m * 100, 1)
            })

    # 2. Profile distribution (Single vs Dual Profile)
    profile_col = next((c["name"] for c in cols if c["name"].lower() in ("profile", "sim_profile")), None)
    profiles = []
    if profile_col:
        sql = (f"SELECT {ident(profile_col)} AS p, COUNT(*) AS c "
               f"FROM {ident(table)} WHERE {where} "
               f"GROUP BY p")
        rows = run(lambda c: (c.execute(sql, args), c.fetchall())[1])
        single_cnt = 0
        dual_cnt = 0
        other_cnt = 0
        for r in rows:
            raw_p = str(r["p"] or "").strip().lower()
            cnt = int(r["c"])
            if not raw_p or raw_p in ("none", "null", ""):
                other_cnt += cnt
            elif "single" in raw_p or raw_p == "1 profile" or raw_p == "1":
                single_cnt += cnt
            elif "dual" in raw_p or "2 profile" in raw_p or "2" in raw_p or "(a+b)" in raw_p:
                dual_cnt += cnt
            else:
                other_cnt += cnt

        tot_p = single_cnt + dual_cnt + other_cnt or 1
        if single_cnt > 0:
            profiles.append({"type": "Single Profile", "count": single_cnt, "pct": round(single_cnt / tot_p * 100, 1), "color": "#0284c7"})
        if dual_cnt > 0:
            profiles.append({"type": "Dual Profile", "count": dual_cnt, "pct": round(dual_cnt / tot_p * 100, 1), "color": "#8b5cf6"})
        if other_cnt > 0:
            profiles.append({"type": "Standard / Other", "count": other_cnt, "pct": round(other_cnt / tot_p * 100, 1), "color": "#10b981"})

    return {
        "monthly": monthly,
        "profiles": profiles
    }


# ------------------------------------------------------------------ ONE-TIME DELETE ALL DATA
_delete_all_executed = set()


def is_delete_all_used(table_name):
    """Check if delete-all has already been executed for this table."""
    if not table_name or table_name == "__all__":
        table_name = "customer_data"
    if table_name in _delete_all_executed:
        return True
    try:
        def check(c):
            c.execute("CREATE TABLE IF NOT EXISTS delete_all_log (table_name VARCHAR(100) PRIMARY KEY, executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, emp_id VARCHAR(50))")
            c.execute("SELECT table_name FROM delete_all_log WHERE table_name = %s", (table_name,))
            return bool(c.fetchone())
        used = run(check, schema=config.AUTH_DB)
        if used:
            _delete_all_executed.add(table_name)
        return used
    except Exception:
        return table_name in _delete_all_executed


def delete_all_data_once(table_name, user_id="", ip_info=("", "")):
    """Delete all records from table. Strictly works only once per table."""
    if not table_name or table_name == "__all__":
        table_name = "customer_data"
    if is_delete_all_used(table_name):
        raise ValueError(f"Delete All has already been executed for '{table_name}' and can only be used once.")

    def go(c):
        c.execute(f"DELETE FROM {ident(table_name)}")
    run(go)

    _delete_all_executed.add(table_name)
    try:
        def rec(c):
            c.execute("CREATE TABLE IF NOT EXISTS delete_all_log (table_name VARCHAR(100) PRIMARY KEY, executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, emp_id VARCHAR(50))")
            c.execute("INSERT INTO delete_all_log (table_name, emp_id) VALUES (%s, %s) ON DUPLICATE KEY UPDATE executed_at = NOW()", (table_name, user_id))
        run(rec, schema=config.AUTH_DB)
    except Exception:
        pass

    try:
        auth.audit(user_id, "delete_all", f"Permanently deleted all rows from {table_name}", ip_info[0], ip_info[1])
    except Exception:
        pass

    return {"ok": True, "message": f"All data deleted from {table_name}. Delete All is now permanently locked."}


def delete_row(table_name, row_id, user_id="", ip_info=("", "")):
    """Delete a single record from table by primary key (id)."""
    if not table_name or table_name == "__all__":
        table_name = "customer_data"
    require_table(table_name)
    cols = columns(table_name)
    pk = next((c["name"] for c in cols if c["key"] == "PRI"), "id")

    def fetch_row(c):
        c.execute(f"SELECT * FROM {ident(table_name)} WHERE {ident(pk)} = %s LIMIT 1", (row_id,))
        return c.fetchone()
    row = run(fetch_row)
    if not row:
        raise LookupError(f"Record with ID '{row_id}' not found in '{table_name}'")

    def go(c):
        c.execute(f"DELETE FROM {ident(table_name)} WHERE {ident(pk)} = %s", (row_id,))
        return c.rowcount
    affected = run(go)

    cust = row.get("customer") or row.get("CUSTOMER NAME") or row.get("CUSTOMER") or ""
    prov = row.get("provider") or row.get("PROVIDER") or ""
    info_txt = f"#{row_id}"
    if cust:
        info_txt += f" - {cust}"
    if prov:
        info_txt += f" ({prov})"

    try:
        auth.audit(user_id, "delete_row", f"Deleted record {info_txt} from {table_name}", ip_info[0], ip_info[1])
    except Exception:
        pass

    invalidate()
    return {"ok": True, "id": row_id, "affected": affected, "customer": cust, "provider": prov}


def delete_rows(table_name, row_ids, user_id="", ip_info=("", "")):
    """Delete multiple records from table by primary keys."""
    if not table_name or table_name == "__all__":
        table_name = "customer_data"
    require_table(table_name)
    if not row_ids:
        return {"ok": True, "affected": 0}
    cols = columns(table_name)
    pk = next((c["name"] for c in cols if c["key"] == "PRI"), "id")

    placeholders = ", ".join(["%s"] * len(row_ids))
    def go(c):
        c.execute(f"DELETE FROM {ident(table_name)} WHERE {ident(pk)} IN ({placeholders})", tuple(row_ids))
        return c.rowcount
    affected = run(go)

    try:
        auth.audit(user_id, "delete_rows", f"Deleted {affected} records from {table_name}", ip_info[0], ip_info[1])
    except Exception:
        pass

    invalidate()
    return {"ok": True, "affected": affected}


# ------------------------------------------------------------------ ALL PROVIDERS (every table at once)
UNI = "CAST({} AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_general_ci"       # same type + collation in every UNION branch
DATEISH = ("date", "datetime", "date_text")


def _merge_kind(ks):
    if len(ks) == 1:
        return next(iter(ks))
    if ks <= {"int", "decimal"}:
        return "decimal"
    if ks <= set(DATEISH):
        return "date_text"
    return "text"


def _union(allc):
    """columns of the combined view + the UNION ALL sql + its args. Columns with the same name (any case) are merged;
    a provider that lacks a column simply shows it empty. id / created_at / row_no style columns are left out."""
    used = {c["name"].lower() for cols in allc.values() for c in cols}
    prov = "PROVIDER" if "provider" not in used else "SOURCE TABLE"
    order, info = [], {}
    for cols in allc.values():
        for c in cols:
            if c["hide"]:
                continue
            k = c["name"].lower()
            if k not in info:
                info[k] = [c["name"], set()]
                order.append(k)
            info[k][1].add(c["kind"])
    ucols = [{"name": prov, "kind": "text", "provider": True}] + \
            [{"name": info[k][0], "kind": _merge_kind(info[k][1]), "hide": False, "required": False} for k in order]
    parts, args = [], []
    for t, cols in allc.items():
        have = {c["name"].lower(): c["name"] for c in cols if not c["hide"]}
        sel = [UNI.format("%s") + f" AS {ident(prov)}"]
        args.append(t)
        for k in order:
            sel.append(UNI.format(ident(have[k]) if k in have else "NULL") + f" AS {ident(info[k][0])}")
        parts.append(f"SELECT {', '.join(sel)} FROM {ident(t)}")
    return ucols, " UNION ALL ".join(parts), args


def all_columns():
    return _union(_all_cols())[0]


def search_all(f, sort="", desc=True, limit=100, offset=0):
    allc = _all_cols()
    ucols, usql, uargs = _union(allc)
    names = [c["name"] for c in ucols]
    if not allc:
        return {"total": 0, "columns": names, "pk": names[0], "sums": [], "rows": []}
    where, args = build_where(ucols, f)
    dflt = next((c["name"] for c in ucols if c["kind"] in DATEISH), names[0])      # newest first when there is a date column
    order = sort if sort in names else dflt
    numeric = {c["name"] for c in ucols if c["kind"] in ("int", "decimal")}
    expr = f"CAST(NULLIF(TRIM({ident(order)}),'') AS DECIMAL(20,2))" if order in numeric else ident(order)
    orderby = f" ORDER BY {expr} {'DESC' if desc else 'ASC'}, {ident(names[0])}"
    sums = [n for n in names if SUMMED.match(n)]
    sel = ", ".join(["COUNT(*) AS n"] + [f"COALESCE(SUM(CAST(NULLIF(TRIM({ident(n)}),'') AS DECIMAL(20,2))),0) AS s{i}"
                                         for i, n in enumerate(sums)])
    limit, offset = min(max(int(limit), 1), 50000), max(int(offset), 0)

    def go(c):
        c.execute(f"SELECT {sel} FROM ({usql}) u WHERE {where}", uargs + args)
        tot = c.fetchone()
        c.execute(f"SELECT * FROM ({usql}) u WHERE {where}{orderby} LIMIT %s OFFSET %s", uargs + args + [limit, offset])
        return tot, c.fetchall()
    tot, rows = run(go)
    return {"total": tot["n"], "columns": names, "pk": dflt,        # "pk" = the column the list is sorted by when nothing is chosen
            "sums": [{"column": n, "sum": jsonable(tot[f"s{i}"])} for i, n in enumerate(sums)],
            "rows": [{k: jsonable(v) for k, v in r.items()} for r in rows]}


def values_all(column, limit=2000):
    allc = _all_cols()
    ucols = _union(allc)[0]
    if column == ucols[0]["name"]:
        return list(allc)                                           # the provider names
    if column.lower() not in {c["name"].lower() for c in ucols[1:]}:
        raise LookupError(f"Column '{column}' not found")

    def go(c):
        seen = set()
        for t, cols in allc.items():
            real = next((x["name"] for x in cols if x["name"].lower() == column.lower() and not x["hide"]), None)
            if real:
                c.execute(f"SELECT DISTINCT {ident(real)} AS v FROM {ident(t)} WHERE {ident(real)} IS NOT NULL "
                          f"AND CAST({ident(real)} AS CHAR)<>'' LIMIT %s", (int(limit),))
                seen.update(str(jsonable(r["v"])) for r in c.fetchall())
        return sorted(seen, key=str.lower)[:limit]
    return run(go)


# ------------------------------------------------------------------ ADD (INSERT) & DATE/NUMERIC HELPERS
def clean_date_val(val):
    """Convert any date representation (DD-MM-YYYY, DD/MM/YYYY, Excel serial, datetime, etc.)
    into standard system date format YYYY-MM-DD for MySQL DATE columns."""
    if val is None:
        return None
    if isinstance(val, datetime.datetime):
        return val.date().isoformat()
    if isinstance(val, datetime.date):
        return val.isoformat()
    if isinstance(val, (int, float)):
        # Excel serial date (e.g. 45439 -> 2024-05-27)
        if 30000 <= val <= 65000:
            try:
                return (datetime.date(1899, 12, 30) + datetime.timedelta(days=int(val))).isoformat()
            except Exception:
                pass
        return None

    s = str(val).strip()
    if not s or s.lower() in ("none", "null", "n/a", "-", "na", "nil", ""):
        return None

    # Try common strptime formats first (day-first, as used in India / Europe)
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%Y/%m/%d",
                "%d-%b-%Y", "%d %b %Y", "%d-%B-%Y", "%d %B %Y",
                "%Y-%m-%d %H:%M:%S", "%d-%m-%Y %H:%M:%S", "%d/%m/%Y %H:%M:%S"):
        try:
            return datetime.datetime.strptime(s, fmt).date().isoformat()
        except Exception:
            pass

    # Regex for DD-MM-YYYY or DD/MM/YYYY or DD.MM.YYYY
    s_date = s.split("T")[0].split(" ")[0]
    m = re.fullmatch(r"(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})", s_date)
    if m:
        p1, p2, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            return datetime.date(y, p2, p1).isoformat()           # day = p1, month = p2
        except ValueError:
            try:
                return datetime.date(y, p1, p2).isoformat()       # p1 cannot be a month-day swap -> try month-first
            except ValueError:
                return None

    # Regex for YYYY-MM-DD or YYYY/MM/DD
    m2 = re.fullmatch(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", s_date)
    if m2:
        y, m, d = int(m2.group(1)), int(m2.group(2)), int(m2.group(3))
        try:
            return datetime.date(y, m, d).isoformat()
        except ValueError:
            return None

    return None


def clean_num_val(val, is_int=False):
    """Sanitize numeric values (currency symbols, spaces, commas). Returns None when it is not a number - and, for
    whole-number columns, when it has a fraction (1.5 is NOT silently turned into 1)."""
    if val is None:
        return None
    if isinstance(val, bool):
        val = int(val)
    if isinstance(val, (int, float, decimal.Decimal)):
        try:
            d = val if isinstance(val, decimal.Decimal) else decimal.Decimal(val)
        except Exception:
            return None
    else:
        s = str(val).strip()
        if not s or s.lower() in ("none", "null", "n/a", "-", "na", "nil"):
            return None
        try:
            d = decimal.Decimal(re.sub(r"[₹$,\s]|/-$", "", s))
        except Exception:
            return None
    if not d.is_finite():
        return None
    if is_int:
        return int(d) if d == d.to_integral_value() else None
    return float(d)


def iso_date(s):
    return clean_date_val(s)


def coerce(col, v):
    """turn what the form sent into a value that fits the column"""
    k, n = col["kind"], col["name"]
    if isinstance(v, str):
        v = v.strip()
    if v is None or v == "":
        return None
    if k in ("int", "decimal"):
        try:
            d = decimal.Decimal(re.sub(r"[,\s]|/-$", "", str(v)))
        except decimal.InvalidOperation:
            raise ValueError(f"{n}: '{v}' is not a number")
        if not d.is_finite():
            raise ValueError(f"{n}: '{v}' is not a number")
        if k == "int":
            if d != d.to_integral_value():
                raise ValueError(f"{n}: '{v}' must be a whole number")
            return int(d)
        return d
    if k in ("date", "date_text"):
        d = iso_date(v)
        if d is None and k == "date":
            raise ValueError(f"{n}: '{v}' is not a valid date")
        return d or str(v)
    if k == "datetime":
        s = str(v).replace("T", " ")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?", s):
            raise ValueError(f"{n}: '{v}' is not a valid date/time")
        return s
    return str(v)


# Field names that mean the same thing (the form says "Request ID", an Excel sheet may say "REQUEST_ID" ...)
_ALIASES = [("qty", "quantity"), ("month", "months"), ("request id", "request_id", "requestid"),
            ("requested by", "requested_by"), ("raised by", "raised_by")]


def _norm(name):
    """case-, space- and underscore-insensitive:  'Mobile Number' == 'mobile_number'"""
    return " ".join(re.sub(r"[_\s]+", " ", str(name).strip().lower()).split())


_CANON = {_norm(a): _norm(g[0]) for g in _ALIASES for a in g}


def _canon(name):
    k = _norm(name)
    return _CANON.get(k, k)


def _blank(v):
    return v is None or str(v).strip() == ""


def insert_row(table, data):
    cols = columns(table)
    supplied = {}
    for k, v in data.items():
        if not _blank(v):
            supplied.setdefault(_canon(k), v)

    def go(c):
        names, vals, got, used = [], [], 0, set()
        for col in cols:
            n = col["name"]
            raw = data.get(n)
            if _blank(raw):
                raw = supplied.get(_canon(n))
            if col["computed"] and _blank(raw):                       # e.g. row_no: next free number
                c.execute(f"SELECT COALESCE(MAX({ident(n)}),0)+1 AS n FROM {ident(table)} FOR UPDATE", ())
                names.append(n); vals.append(c.fetchone()["n"])
                continue
            if col["hide"] and not col["computed"]:                   # auto-increment id, created_at ...
                continue
            v = coerce(col, raw)
            if v is None:
                if col["required"]:
                    raise ValueError(f"{n} is required")
                continue
            if CUSTOMER.search(n) and col["kind"] == "text":          # "ind  TRACK" -> the spelling already in the table
                v = " ".join(str(v).split())
                c.execute(f"SELECT {ident(n)} AS v FROM {ident(table)} WHERE {ident(n)}=%s LIMIT 1", (v,))
                r = c.fetchone()
                v = r["v"] if r else v
            names.append(n); vals.append(v); got += 1; used.add(_canon(n))
        if not got:
            raise ValueError("Enter at least one value")
        c.execute(f"INSERT INTO {ident(table)} ({', '.join(ident(x) for x in names)}) VALUES ({', '.join(['%s'] * len(vals))})", vals)
        # fields the browser sent that this table has no column for: reported, not silently dropped
        ignored = sorted({str(k) for k, v in data.items() if not _blank(v) and _canon(k) not in used})
        return c.lastrowid, ignored
    new_id, ignored = run(go)
    return {"ok": True, "id": new_id, "ignored": ignored}


# ------------------------------------------------------------------ CREATE TABLE
def create_table(name, cols):
    name = (name or "").strip()
    if not NAME_OK.match(name):
        raise ValueError("Table name: letters, numbers, space, _ - . only (max 63 characters)")
    if name.lower() in [t.lower() for t in table_names()]:
        raise ValueError(f"A table called '{name}' already exists")
    if not cols:
        raise ValueError("Add at least one column")
    seen, defs = {"id", "created_at"}, []
    for c in cols:
        cn, ct = (c.get("name") or "").strip(), c.get("type") or "text"
        if not NAME_OK.match(cn):
            raise ValueError(f"Column name '{cn}' is not allowed (letters, numbers, space, _ - . only)")
        if cn.lower() in seen:
            raise ValueError(f"Column name '{cn}' is used twice (or is reserved: id, created_at)")
        if ct not in TYPES:
            raise ValueError(f"Unknown column type '{ct}'")
        seen.add(cn.lower())
        defs.append(f"{ident(cn)} {TYPES[ct]}")
    sql = (f"CREATE TABLE {ident(name)} (id INT AUTO_INCREMENT PRIMARY KEY, {', '.join(defs)}, "
           f"created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4")
    run(lambda c: c.execute(sql, ()))
    invalidate()
    return {"ok": True, "name": name}


# ------------------------------------------------------------------ BULK UPLOAD & UNIFIED CUSTOMER TABLE
DEFAULT_TABLE = "customer_data"
DEFAULT_PROVIDERS = ["sensorise", "iotivity", "vi", "growspace", "taisys"]
_PROV_SET = set(DEFAULT_PROVIDERS)
FORM_COLUMNS = ["Request ID", "Profile", "Product", "Requested By", "Raised By", "Month"]   # the Insert form fills these
MAX_IMPORT_ROWS, MAX_SHEETS = 100_000, 50
_ensured = set()


class DuplicateImport(Exception):
    """the very same file was imported before"""


def normalize_provider(name):
    """Normalize sheet names to canonical provider names."""
    s = str(name or "").strip().lower()
    s_clean = re.sub(r"[\s_-]+", "", s)
    if "sensorise" in s_clean:
        return "sensorise"
    if "iotivity" in s_clean:
        return "iotivity"
    if s_clean in ("vi", "vodafone", "idea", "vodafoneidea"):
        return "vi"
    if "growspace" in s_clean:
        return "growspace"
    if "taisys" in s_clean:
        return "taisys"
    return s or "sensorise"


def is_customer_header(h):
    """Check if an Excel column header represents a Customer Name."""
    hl = re.sub(r"[\s_.-]+", "", str(h or "").strip().lower())
    return hl in (
        "customer", "customername", "client", "clientname",
        "company", "companyname", "party", "partyname",
        "account", "accountname", "custname", "cust"
    )


def is_date_header(h):
    """Check if an Excel header is a date name or an accidental date string (e.g. 2026-08-29 00:00:00)."""
    if h is None:
        return False
    if isinstance(h, (datetime.date, datetime.datetime)):
        return True
    s = str(h).strip().lower()
    if s in ("date", "dates", "datetime", "created_date", "entry_date"):
        return True
    if re.match(r"^\d{2,4}[-/.]\d{1,2}[-/.]\d{2,4}", s):
        return True
    return False


def is_valid_column_header(h):
    """Check if an Excel header value is a valid, genuine column name (rejects dummy and date headers)."""
    if h is None:
        return False
    if isinstance(h, (datetime.date, datetime.datetime)):
        return False
    s = str(h).strip()
    if not s:
        return False
    if re.match(r"^col(?:umn)?[_\s]?\d+$", s, re.I):          # dummy column_N names
        return False
    if not re.search(r"[A-Za-z]", s):                         # must contain a letter
        return False
    if re.match(r"^\d{2,4}[-/.]\d{1,2}[-/.]\d{2,4}", s):      # looks like a date / timestamp
        return False
    if s.startswith("=") or s.lower() in ("true", "false", "null", "none"):
        return False
    if len(s) > 64:
        return False
    return True


def _columns_present(c, table_name):
    c.execute("SELECT column_name AS n FROM information_schema.columns WHERE table_schema=%s AND table_name=%s",
              (_state["db"], table_name))
    return {r["n"].lower() for r in c.fetchall()}


def ensure_customer_table(table_name=DEFAULT_TABLE):
    """Make sure the customer entries table exists with provider, the standard columns and the columns the Insert
    form fills (so nothing typed in the form is lost). Runs once per process."""
    if table_name in _ensured:
        return

    def go(c):
        c.execute(f"""
            CREATE TABLE IF NOT EXISTS {ident(table_name)} (
                id INT AUTO_INCREMENT PRIMARY KEY,
                customer VARCHAR(255) NOT NULL,
                provider VARCHAR(100) NOT NULL DEFAULT 'sensorise',
                mobile_number VARCHAR(50) NULL,
                sim_number VARCHAR(100) NULL,
                plan VARCHAR(100) NULL,
                qty INT DEFAULT 1,
                amount DECIMAL(14,2) NULL,
                status VARCHAR(50) NULL,
                date DATE NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """, ())
        have = _columns_present(c, table_name)
        if "provider" not in have:
            c.execute(f"ALTER TABLE {ident(table_name)} ADD COLUMN provider VARCHAR(100) NOT NULL DEFAULT 'sensorise' AFTER customer", ())
            have.add("provider")
        have_canon = {_canon(h) for h in have}
        for name in FORM_COLUMNS:
            if _canon(name) not in have_canon:
                c.execute(f"ALTER TABLE {ident(table_name)} ADD COLUMN {ident(name)} VARCHAR(255) NULL", ())
    run(go)
    invalidate()
    _ensured.add(table_name)


def _prepare(table_name):
    if table_name == DEFAULT_TABLE:
        ensure_customer_table(table_name)
    require_table(table_name)


def get_providers_summary(table_name=DEFAULT_TABLE):
    """Entry counts for the five default providers, followed by any other provider found in the data."""
    _prepare(table_name)
    prov = next((c["name"] for c in columns(table_name) if c["name"].lower() == "provider"), None)
    counts = {}
    if prov:
        p = ident(prov)
        for r in fetch(f"SELECT LOWER(TRIM({p})) AS prov, COUNT(*) AS cnt FROM {ident(table_name)} "
                       f"WHERE {p} IS NOT NULL AND TRIM({p})<>'' GROUP BY LOWER(TRIM({p}))", ()):
            counts[r["prov"]] = r["cnt"]
    out = [{"provider": p, "count": counts.pop(p, 0)} for p in DEFAULT_PROVIDERS]
    out += [{"provider": p, "count": n} for p, n in sorted(counts.items())]
    return out


def get_customers(table_name=DEFAULT_TABLE):
    """Distinct customer names with entry counts."""
    _prepare(table_name)
    cust = next((c["name"] for c in columns(table_name) if c["name"].lower() == "customer"), None)
    if not cust:
        return []
    k = ident(cust)
    return fetch(f"SELECT {k} AS customer, COUNT(*) AS count FROM {ident(table_name)} "
                 f"WHERE {k} IS NOT NULL AND TRIM({k}) <> '' GROUP BY {k} ORDER BY {k} ASC", ())


# --- import fingerprint log (kept in the hidden login schema, so it never shows up as a provider table)
def _import_log_setup(c):
    c.execute("CREATE TABLE IF NOT EXISTS import_log (id BIGINT AUTO_INCREMENT PRIMARY KEY, ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP, "
              "file_sha CHAR(64), table_name VARCHAR(100), filename VARCHAR(255), rows_count INT, emp_id VARCHAR(30), "
              "KEY idx_sha (file_sha)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4")


def _find_import(digest, table_name):
    def go(c):
        _import_log_setup(c)
        c.execute("SELECT ts, filename, rows_count, emp_id FROM import_log WHERE file_sha=%s AND table_name=%s "
                  "ORDER BY id DESC LIMIT 1", (digest, table_name))
        return c.fetchone()
    try:
        return run(go, schema=config.AUTH_DB)
    except Exception:
        log.warning("import log unavailable - duplicate-file check skipped", exc_info=True)
        return None


def _record_import(digest, table_name, filename, rows, by):
    def go(c):
        _import_log_setup(c)
        c.execute("INSERT INTO import_log (file_sha, table_name, filename, rows_count, emp_id) VALUES (%s,%s,%s,%s,%s)",
                  (digest, table_name, (filename or "")[:255], rows, (by or "")[:30]))
    try:
        run(go, schema=config.AUTH_DB)
    except Exception:
        log.warning("could not record the import", exc_info=True)


def _conv(kind, val, title, col, bad):
    """convert one Excel cell for a column of the given kind; values that cannot be read are counted in `bad`"""
    if val is None or (isinstance(val, str) and not val.strip()):
        return None
    if kind in ("date", "datetime"):
        out = clean_date_val(val)
        if out is None:
            bad[(title, col, "date")] += 1
        return out
    if kind == "date_text":
        return clean_date_val(val) or str(val).strip()
    if kind in ("int", "decimal"):
        out = clean_num_val(val, is_int=(kind == "int"))
        if out is None:
            bad[(title, col, "whole number" if kind == "int" else "number")] += 1
        return out
    if isinstance(val, datetime.datetime):
        return val.isoformat(" ") if (val.hour or val.minute or val.second) else val.date().isoformat()
    if isinstance(val, datetime.date):
        return val.isoformat()
    if isinstance(val, float) and val.is_integer():
        return str(int(val))
    return str(val).strip()


def bulk_import_excel(file_bytes, table_name=DEFAULT_TABLE, filename="", by="", force=False):
    """
    Import an Excel workbook where each SHEET NAME is a SIM PROVIDER (sensorise, iotivity, vi, growspace, taisys) and the
    rows of the sheet are entries with their CUSTOMER names. All rows of all sheets go into one table.
    New sheet columns are added to the table. Everything is read in memory - the file itself is never stored; only its
    SHA-256 fingerprint is kept so that importing the very same file twice asks for confirmation (force=True).
    Values that cannot be read (bad dates / numbers) are left empty and reported in `warnings`.
    """
    _prepare(table_name)
    digest = hashlib.sha256(file_bytes).hexdigest()
    if not force:
        prev = _find_import(digest, table_name)
        if prev:
            raise DuplicateImport(f"This exact file was already imported on {prev['ts']} by {prev['emp_id'] or 'someone'} "
                                  f"({prev['rows_count']} rows). Importing it again will create duplicate rows.")

    cols = columns(table_name)
    by_canon = {_canon(c["name"]): c["name"] for c in cols}
    cust_col, prov_col = by_canon.get("customer"), by_canon.get("provider")
    if not cust_col or not prov_col:
        raise ValueError(f"Table '{table_name}' needs 'customer' and 'provider' columns for the bulk upload")

    try:
        wb = openpyxl.load_workbook(io.BytesIO(file_bytes), data_only=True, read_only=True)
    except Exception:
        raise ValueError("Could not read this file - make sure it is a genuine .xlsx workbook.")

    new_cols, pending, sheets, total = [], {}, [], 0
    try:
        if len(wb.sheetnames) > MAX_SHEETS:
            raise ValueError(f"Too many sheets ({len(wb.sheetnames)}); the limit is {MAX_SHEETS}.")
        for ws in wb.worksheets:
            title = str(ws.title).strip()
            if not title:
                continue
            rows = []
            for r in ws.iter_rows(values_only=True):
                rows.append(r)
                if len(rows) + total > MAX_IMPORT_ROWS + 20:
                    raise ValueError(f"Too many rows; the limit is {MAX_IMPORT_ROWS:,} per upload.")
            if not rows:
                continue

            # header row = the one of the first 10 rows with the most valid column names
            header_idx, best = 0, 0
            for r_idx, r_vals in enumerate(rows[:10]):
                if not r_vals:
                    continue
                n_valid = sum(1 for v in r_vals if is_valid_column_header(v))
                if n_valid > best and n_valid >= 2:
                    best, header_idx = n_valid, r_idx

            mapping = {}                                          # excel column index -> table column
            for i, h in enumerate(rows[header_idx]):
                if is_valid_column_header(h):
                    name = " ".join(str(h).strip().split())
                    key = _canon(name)
                    if is_customer_header(name):
                        target = cust_col
                    elif key in ("provider", "sim provider"):
                        target = prov_col
                    elif key in ("id", "created at"):
                        continue
                    elif key in by_canon:
                        target = by_canon[key]
                    elif key in pending:
                        target = pending[key]
                    else:
                        target = pending[key] = name
                        new_cols.append(name)
                    if target not in mapping.values():
                        mapping[i] = target
                elif is_date_header(h) and "date" in by_canon:    # an accidental date value in the header row
                    if by_canon["date"] not in mapping.values():
                        mapping[i] = by_canon["date"]
            if not mapping:
                continue

            entries = []
            for row in rows[header_idx + 1:]:
                if not row or all(v is None or str(v).strip() == "" for v in row):
                    continue
                e = {t: row[i] for i, t in mapping.items() if i < len(row) and row[i] is not None and str(row[i]).strip() != ""}
                if e:
                    entries.append(e)
            total += len(entries)
            sheets.append({"title": title, "prov": normalize_provider(title), "entries": entries,
                           "cols": list(dict.fromkeys(mapping.values()))})
    finally:
        wb.close()

    if total == 0:
        raise ValueError("No data rows were found. Each sheet needs a header row (with a customer column) followed by data.")

    if new_cols:                                                   # add the new Excel columns to the table
        def alter(c):
            have = _columns_present(c, table_name)
            for name in new_cols:
                if name.lower() not in have:
                    c.execute(f"ALTER TABLE {ident(table_name)} ADD COLUMN {ident(name)} VARCHAR(255) NULL", ())
        run(alter)
        invalidate()
    kinds = {c["name"]: c["kind"] for c in columns(table_name)}

    bad = collections.defaultdict(int)
    nocust = collections.defaultdict(int)
    customers_all, providers_all = set(), set()
    inserted = 0

    def insert_all(c):
        nonlocal inserted
        inserted = 0                                               # (reset: this function may be retried once)
        bad.clear(); nocust.clear(); customers_all.clear(); providers_all.clear()
        for sh in sheets:
            sh["customers"], sh["provs"] = set(), set()
            if not sh["entries"]:
                continue
            target_cols = [cust_col, prov_col] + [t for t in sh["cols"] if t not in (cust_col, prov_col)]
            sql = (f"INSERT INTO {ident(table_name)} ({', '.join(ident(k) for k in target_cols)}) "
                   f"VALUES ({', '.join(['%s'] * len(target_cols))})")
            batch = []
            for e in sh["entries"]:
                cust = " ".join(str(e.get(cust_col, "")).split())[:255]
                if not cust:
                    cust = "—"
                    nocust[sh["title"]] += 1
                prov = sh["prov"]
                if prov not in _PROV_SET and e.get(prov_col):      # a sheet like "Sheet1" with its own provider column
                    prov = normalize_provider(e[prov_col])
                prov = prov[:100]
                sh["customers"].add(cust); sh["provs"].add(prov)
                customers_all.add(cust); providers_all.add(prov)
                batch.append([cust, prov] + [_conv(kinds.get(col, "text"), e.get(col), sh["title"], col, bad)
                                             for col in target_cols[2:]])
                if len(batch) >= 500:
                    c.executemany(sql, batch)
                    inserted += len(batch)
                    batch = []
            if batch:
                c.executemany(sql, batch)
                inserted += len(batch)
    run(insert_all)
    _record_import(digest, table_name, filename, inserted, by)

    warnings = [f"Sheet '{t}': {n} value(s) in column '{col}' were not a valid {what} and were left empty."
                for (t, col, what), n in sorted(bad.items())]
    warnings += [f"Sheet '{t}': {n} row(s) had no customer name and were saved as '—'." for t, n in sorted(nocust.items())]
    details = []
    for sh in sheets:
        for p in sorted(sh["provs"] - _PROV_SET):
            warnings.append(f"Sheet '{sh['title']}' is not one of the five providers - its rows were saved under the new provider '{p}'.")
        details.append({"sheet_name": sh["title"], "provider": ", ".join(sorted(sh["provs"])) or sh["prov"],
                        "rows_count": len(sh["entries"]), "customers_count": len(sh["customers"]),
                        "customers_sample": sorted(sh["customers"])[:5], "columns": sh["cols"][:6]})
    return {"ok": True, "table": table_name, "rows_inserted": inserted, "providers": sorted(providers_all),
            "customers_count": len(customers_all), "sheets_count": len(sheets), "sheets": details,
            "new_columns": new_cols, "warnings": warnings}
