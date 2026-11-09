  #!/usr/bin/env python3
"""app.py - the backend (FastAPI).   Run:  python app.py     then open http://localhost:8000
API docs: http://localhost:8000/docs

Everything except the sign-in page needs an employee login (cookie session).
  POST /api/login | /api/logout      GET /api/me
  GET  /api/tables                   list of providers (tables)
  GET  /api/tables/{t}/rows          FETCH one provider          POST /api/tables/{t}/rows   ADD an entry
  GET  /api/all/rows                 FETCH every provider at once (same filters, + Provider filter)
  GET/POST/DELETE /api/members       team (administrators only)          POST /api/password   change own password
  GET  /api/logins                   login history (administrators only)
Administrators (is_admin) also create tables. The built-in first login must change its password before anything else works.
"""
import logging
import os
import sys
from contextlib import asynccontextmanager
from typing import Any, Dict, List
from urllib.parse import quote

# Ensure backend directory is in sys.path so sibling imports work from anywhere
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import pymysql
from fastapi import APIRouter, Body, Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

import auth
import config
import db
from xlsxout import make_xlsx

# The website files are looked for in frontend/ (sibling or inside backend/) or next to app.py
PARENT = os.path.dirname(config.HERE)
WEB_DIRS = [
    os.path.join(PARENT, "frontend"),
    os.path.join(PARENT, "fronted"),
    os.path.join(config.HERE, "frontend"),
    os.path.join(config.HERE, "fronted"),
    config.HERE,
    PARENT,
]
WEB_FILES = {
    "index.html": "text/html",
    "style.css": "text/css",
    "script.js": "text/javascript",
    "ux3d.css": "text/css",
    "ux3d.js": "text/javascript",
}
COOKIE = "vi_session"
log = logging.getLogger("app")


def web_file(name):
    for d in WEB_DIRS:
        p = os.path.join(d, name)
        if os.path.isfile(p):
            return p
    raise HTTPException(404, f"{name} not found - put index.html, style.css and script.js next to app.py (or in a 'frontend' folder)")


@asynccontextmanager
async def lifespan(_):
    try:
        auth.setup()                                  # creates the login tables + the built-in first login
        db.ensure_customer_table()                    # ensures unified customer table exists
    except Exception as e:                            # MySQL not up yet: it is retried on the first sign-in
        print("Login/table setup postponed:", e)
    yield


app = FastAPI(title="bstpl sim info", lifespan=lifespan)

# Enable CORS for Netlify frontend, Render backend, localhost, and custom domains
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://.*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    if request.url.path.startswith("/api/"):
        resp.headers.setdefault("Cache-Control", "no-store")
    return resp


def _err(code, msg):
    return JSONResponse({"detail": msg}, status_code=code)


@app.exception_handler(auth.AuthError)
def _auth(_, e): return _err(e.code, e.msg)


@app.exception_handler(ValueError)
def _bad(_, e): return _err(400, str(e))


@app.exception_handler(db.DuplicateImport)
def _dup(_, e): return _err(409, str(e))


@app.exception_handler(LookupError)
def _missing(_, e): return _err(404, str(e).strip("'\""))


@app.exception_handler(pymysql.err.OperationalError)
def _down(_, e): return _err(503, "MySQL: " + (str(e.args[1]) if len(e.args) > 1 else str(e)))


@app.exception_handler(pymysql.MySQLError)
def _mysql(_, e): return _err(400, "MySQL: " + (str(e.args[1]) if len(e.args) > 1 else str(e)))


class Login(BaseModel):
    id: str
    password: str


class PwChange(BaseModel):
    current: str
    new: str


class Member(BaseModel):
    id: str
    name: str
    password: str
    admin: bool = False


class Col(BaseModel):
    name: str
    type: str = "text"


class NewTable(BaseModel):
    name: str
    columns: List[Col]


def filters(q: str = "", col: str = "", val: str = "", customer: str = "", provider: str = "",
            requested_by: str = "", raised_by: str = "",
            date_col: str = "", date_from: str = "", date_to: str = ""):
    return dict(q=q, col=col, val=val, customer=customer, provider=provider,
                requested_by=requested_by, raised_by=raised_by,
                date_col=date_col, date_from=date_from, date_to=date_to)


def who(request: Request):
    return (request.client.host if request.client else ""), request.headers.get("user-agent", "")


def extract_token(request: Request) -> str:
    token = request.cookies.get(COOKIE, "")
    if not token:
        auth_hdr = request.headers.get("authorization", "") or request.headers.get("Authorization", "")
        if auth_hdr.lower().startswith("bearer "):
            token = auth_hdr[7:].strip()
    return token


def require_user(request: Request):
    token = extract_token(request)
    user = auth.user_for(token)
    if not user:
        raise auth.AuthError("Please sign in.", 401)
    if user["default_pw"] and request.url.path != "/api/password":      # the well-known built-in password must be replaced first
        raise auth.AuthError("Please change the built-in password first.", 403)
    return user


def require_admin(user: dict = Depends(require_user)):
    if not user.get("admin"):
        raise auth.AuthError("Administrator access required.", 403)
    return user


# ---- sign in / out (the only public API routes)
@app.post("/api/login")
def login(b: Login, request: Request, response: Response):
    token, user = auth.login(b.id, b.password, *who(request))
    # When deployed on HTTPS (Render), samesite="none" allows cross-site Netlify -> Render calls
    same_site = "none" if config.COOKIE_SECURE else "lax"
    response.set_cookie(COOKIE, token, max_age=config.SESSION_HOURS * 3600, httponly=True,
                        samesite=same_site, secure=config.COOKIE_SECURE, path="/")
    return {"user": user, "token": token}


@app.post("/api/logout")
def logout(request: Request, response: Response):
    try:
        auth.logout(extract_token(request), *who(request))
    except Exception:
        pass
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@app.get("/api/me")
def me(request: Request):
    return {"user": auth.user_for(extract_token(request))}


# ---- everything below needs a signed-in employee
api = APIRouter(prefix="/api", dependencies=[Depends(require_user)])


@api.post("/password")
def change_password(b: PwChange, request: Request, user: dict = Depends(require_user)):
    auth.change_password(user["id"], b.current, b.new, request.cookies.get(COOKIE, ""), *who(request))
    return {"ok": True}


@api.get("/members", dependencies=[Depends(require_admin)])
def members(): return {"members": auth.members()}


@api.post("/members", status_code=201)                          # administrators only
def add_member(b: Member, request: Request, user: dict = Depends(require_admin)):
    auth.add_member(user["id"], b.id, b.name, b.password, b.admin, *who(request))
    return {"ok": True}


@api.delete("/members/{emp_id}")
def remove_member(emp_id: str, request: Request, user: dict = Depends(require_admin)):
    auth.remove_member(user["id"], emp_id, *who(request))
    return {"ok": True}


@api.get("/logins", dependencies=[Depends(require_admin)])
def logins(limit: int = 300): return {"logs": auth.history(limit)}


# ---- database / tables
@api.get("/status")
def status(): return db.status()


@api.get("/tables")
def list_tables(): return db.tables()


@api.post("/tables", status_code=201, dependencies=[Depends(require_admin)])      # CREATE TABLE
def new_table(t: NewTable): return db.create_table(t.name, [c.model_dump() for c in t.columns])


@api.get("/tables/{table}/columns")
def table_columns(table: str): return db.columns(table)


@api.get("/tables/{table}/values")                              # drop-down lists
def table_values(table: str, column: str): return {"values": db.values(table, column)}


# ---- fetch / add one provider
@api.get("/tables/{table}/rows")                                # FETCH
def fetch_rows(table: str, f: dict = Depends(filters), sort: str = "", desc: bool = True, limit: int = 100, offset: int = 0):
    return db.search(table, f, sort, desc, limit, offset)


@api.post("/tables/{table}/rows", status_code=201)              # ADD
def add_row(table: str, data: Dict[str, Any] = Body(...)): return db.insert_row(table, data)


# ---- bulk upload (single table, sheet name = provider, table row = customer)
@api.post("/upload")                                            # a plain `def`: runs in a worker thread, never blocks the server
def bulk_upload(request: Request, file: UploadFile = File(...), table: str = db.DEFAULT_TABLE, force: bool = False,
                user: dict = Depends(require_user)):
    name = file.filename or ""
    try:
        if not name.lower().endswith((".xlsx", ".xlsm")):
            raise HTTPException(400, "Please upload a valid Excel file (.xlsx).")
        limit = config.MAX_UPLOAD_MB * 1024 * 1024
        data = file.file.read(limit + 1)
        if len(data) > limit:
            raise HTTPException(413, f"The file is too large (the limit is {config.MAX_UPLOAD_MB} MB).")
        try:
            res = db.bulk_import_excel(data, table_name=table, filename=name, by=user["id"], force=force)
        except (ValueError, LookupError, pymysql.MySQLError, db.DuplicateImport):
            raise                                               # clear messages, handled above
        except Exception:
            log.exception("bulk upload failed")
            raise HTTPException(400, "The file could not be processed. Check that it is a valid workbook with a header row on each sheet.")
        auth.audit(user["id"], "bulk_upload", f"{name}: {res['rows_inserted']} rows into {table}", *who(request))
        return res
    finally:
        file.file.close()


@api.get("/providers")
def list_providers(table: str = db.DEFAULT_TABLE):
    return {
        "providers": db.DEFAULT_PROVIDERS,
        "summary": db.get_providers_summary(table)
    }


@api.get("/customers")
def list_customers(table: str = db.DEFAULT_TABLE):
    return {"customers": db.get_customers(table)}


def _xlsx(name, r, visible_cols=None):
    cols = r["columns"]
    if visible_cols:
        requested = [c.strip() for c in visible_cols.split(",") if c.strip()]
        filtered = [c for c in cols if c in requested]
        if filtered:
            cols = filtered
    data = make_xlsx(cols, [[row[c] for c in cols] for row in r["rows"]], name)
    plain = "".join(ch for ch in name if ch.isascii() and ch not in '"\\/\r\n').strip() or "export"
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f"attachment; filename=\"{plain}.xlsx\"; filename*=UTF-8''{quote(name)}.xlsx"})


@api.get("/tables/{table}/export")                              # same filters -> .xlsx
def export(table: str, f: dict = Depends(filters), sort: str = "", desc: bool = True, cols: str = ""):
    return _xlsx(table, db.search(table, f, sort, desc, 50000, 0), visible_cols=cols)


# ---- fetch every provider at once
@api.get("/all/columns")
def all_columns(): return db.all_columns()


@api.get("/all/values")
def all_values(column: str): return {"values": db.values_all(column)}


@api.get("/all/rows")
def all_rows(f: dict = Depends(filters), sort: str = "", desc: bool = True, limit: int = 100, offset: int = 0):
    return db.search_all(f, sort, desc, limit, offset)


@api.get("/all/export")
def all_export(f: dict = Depends(filters), sort: str = "", desc: bool = True, cols: str = ""):
    return _xlsx("All providers", db.search_all(f, sort, desc, 50000, 0), visible_cols=cols)


app.include_router(api)


# ---- the website: only these files are served (never config.py or anything else in the folder)
@app.get("/", include_in_schema=False)
def home():
    resp = FileResponse(web_file("index.html"))
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp


@app.get("/static/{name}", include_in_schema=False)
@app.get("/{name}", include_in_schema=False)
def static_file(name: str):
    if name not in WEB_FILES:
        raise HTTPException(404, "Not found")
    resp = FileResponse(web_file(name), media_type=WEB_FILES[name])
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp


if __name__ == "__main__":
    import uvicorn
    s = db.status()
    missing = [n for n in WEB_FILES if not any(os.path.isfile(os.path.join(d, n)) for d in WEB_DIRS)]
    if missing:
        print("WARNING: website file(s) not found:", ", ".join(missing), "- put them next to app.py")
    print(f"bstpl sim info is running ->  http://{'localhost' if config.HOST in ('127.0.0.1', '0.0.0.0') else config.HOST}:{config.PORT}")
    if s["connected"]:
        print("MySQL                 ->", "connected, database:", s["database"] or "(set 'database' in config.py)")
    else:
        print("MySQL                 ->", "NOT connected:", s["error"])
    print("First sign-in         ->  employee ID 1234 / password 1234567890  (you are forced to change it at once)")
    uvicorn.run(app, host=config.HOST, port=config.PORT)
