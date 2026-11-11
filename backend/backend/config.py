"""config.py - application configuration.

Configures database connection, network ports, auth sessions, and file upload limits.
Supports local execution and cloud deployment (e.g., Render, Railway, TiDB Cloud).

Priority order for settings:
1. Environment variables (e.g., DATABASE_URL, MYSQL_HOST, PORT, RENDER, etc.)
2. config_local.py overrides (if present)
3. Default hardcoded fallbacks
"""
import os
from urllib.parse import parse_qs, unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))

# Cloud detection: Render sets RENDER=true; any containerized deploy usually provides PORT
IS_RENDER = bool(os.environ.get("RENDER")) or ("PORT" in os.environ and os.environ.get("PORT") != "8000")

# Production Cloud URL (generated Render deployment URL)
RENDER_URL = os.environ.get("RENDER_EXTERNAL_URL", "https://sim-provider-1f4c.onrender.com")

PORT = int(os.environ.get("PORT", 8000))
# Cloud platforms require 0.0.0.0 to bind externally; local default is 127.0.0.1
HOST = os.environ.get("HOST", "0.0.0.0" if (IS_RENDER or "PORT" in os.environ) else "127.0.0.1")

# Default database connection parameters
MYSQL = {
    "host": "gateway01.ap-northeast-1.prod.aws.tidbcloud.com",
    "port": 4000,
    "user": "2DQWZxtzB8QkzXZ.root",
    "password": "RTksF8mDqlKfQz8u",
    "database": "sim_provider_data",
    "ssl_ca": "system",
}

# Employee login / auth settings
AUTH_DB = "vi_tracker_auth"
SESSION_HOURS = 12
# On Render / HTTPS, secure cookies are enabled automatically
COOKIE_SECURE = True if (IS_RENDER or "onrender.com" in RENDER_URL) else False
MAX_UPLOAD_MB = 25

DEFAULT_ADMIN = {
    "id": os.environ.get("DEFAULT_ADMIN_ID", "1234"),
    "name": os.environ.get("DEFAULT_ADMIN_NAME", "Administrator"),
    "password": os.environ.get("DEFAULT_ADMIN_PASSWORD", "1234567890"),
}

# Optional local override file (ignored by git)
try:
    import config_local
    MYSQL.update(getattr(config_local, "MYSQL", {}))
    PORT = getattr(config_local, "PORT", PORT)
    HOST = getattr(config_local, "HOST", HOST)
    AUTH_DB = getattr(config_local, "AUTH_DB", AUTH_DB)
    COOKIE_SECURE = getattr(config_local, "COOKIE_SECURE", COOKIE_SECURE)
    MAX_UPLOAD_MB = getattr(config_local, "MAX_UPLOAD_MB", MAX_UPLOAD_MB)
except ImportError:
    pass

# Parse cloud database URL if provided (e.g., from Render / TiDB Cloud / Aiven)
db_url = os.environ.get("DATABASE_URL") or os.environ.get("MYSQL_URL")
if db_url:
    if db_url.startswith("mysql+pymysql://"):
        db_url = "mysql://" + db_url[len("mysql+pymysql://"):]
    try:
        p = urlparse(db_url)
        if p.hostname:
            MYSQL["host"] = p.hostname
        if p.port:
            MYSQL["port"] = int(p.port)
        if p.username:
            MYSQL["user"] = unquote(p.username)
        if p.password:
            MYSQL["password"] = unquote(p.password)
        if p.path and p.path.strip("/"):
            MYSQL["database"] = unquote(p.path.strip("/"))
        query = parse_qs(p.query)
        if "ssl_ca" in query:
            MYSQL["ssl_ca"] = query["ssl_ca"][0]
    except Exception as e:
        print("Warning: Failed to parse DATABASE_URL:", e)

# Individual environment variables take final precedence
for key, env in (
    ("host", "MYSQL_HOST"),
    ("port", "MYSQL_PORT"),
    ("user", "MYSQL_USER"),
    ("password", "MYSQL_PASSWORD"),
    ("database", "MYSQL_DATABASE"),
    ("ssl_ca", "MYSQL_SSL_CA"),
):
    val = os.environ.get(env)
    if val:
        MYSQL[key] = int(val) if key == "port" else val

if os.environ.get("AUTH_DB"):
    AUTH_DB = os.environ["AUTH_DB"]

if os.environ.get("SESSION_HOURS"):
    SESSION_HOURS = int(os.environ["SESSION_HOURS"])

if os.environ.get("HOST"):
    HOST = os.environ["HOST"]

if os.environ.get("PORT"):
    PORT = int(os.environ["PORT"])

if os.environ.get("COOKIE_SECURE"):
    COOKIE_SECURE = os.environ["COOKIE_SECURE"].lower() in ("1", "true", "yes")

if os.environ.get("MAX_UPLOAD_MB"):
    MAX_UPLOAD_MB = int(os.environ["MAX_UPLOAD_MB"])
