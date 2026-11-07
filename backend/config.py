"""config.py - settings.

NEVER put real passwords in this file. Put them in config_local.py (next to this file, keep it out of git -
see config_local.example.py) or set the environment variables MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD,
MYSQL_DATABASE, MYSQL_SSL_CA (path to a CA bundle - needed for TLS-only servers such as TiDB Cloud),
HOST, PORT, COOKIE_SECURE (1 when served over HTTPS), MAX_UPLOAD_MB."""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 8000                                   # the website: http://localhost:8000
HOST = "127.0.0.1"                            # 127.0.0.1 = this computer only; 0.0.0.0 = reachable from the network

MYSQL = {
    "host": "gateway01.ap-northeast-1.prod.aws.tidbcloud.com",
    "port": 4000,
    "user": "2DQWZxtzB8QkzXZ.root",                               # set in config_local.py or MYSQL_USER
    "password": "RTksF8mDqlKfQz8u",                           # set in config_local.py or MYSQL_PASSWORD
    "database": "sim_provider_data",          # schema name; leave empty to see a hint in the website
                            # e.g. /etc/ssl/certs/ca-certificates.crt  (turns on verified TLS)
}

# ---- employee login ------------------------------------------------------------------------------------------
AUTH_DB = "vi_tracker_auth"                   # separate schema for employees / sessions / login history (created automatically,
                                              # hidden from the Database drop-down, never shown as a provider)
SESSION_HOURS = 12                            # how long a sign-in lasts
COOKIE_SECURE = False                         # set True (or COOKIE_SECURE=1) when the site is served over HTTPS
MAX_UPLOAD_MB = 25                            # largest Excel file accepted by the bulk upload
DEFAULT_ADMIN = {"id": "1234", "name": "Administrator", "password": "1234567890"}   # built-in first login, created only while
                                              # the employees table is empty. The app FORCES a password change at first sign-in.

try:                                          # private overrides: create config_local.py next to this file
    import config_local
    MYSQL.update(getattr(config_local, "MYSQL", {}))
    PORT = getattr(config_local, "PORT", PORT)
    HOST = getattr(config_local, "HOST", HOST)
    AUTH_DB = getattr(config_local, "AUTH_DB", AUTH_DB)
    COOKIE_SECURE = getattr(config_local, "COOKIE_SECURE", COOKIE_SECURE)
    MAX_UPLOAD_MB = getattr(config_local, "MAX_UPLOAD_MB", MAX_UPLOAD_MB)
except ImportError:
    pass
for key, env in (("host", "MYSQL_HOST"), ("port", "MYSQL_PORT"), ("user", "MYSQL_USER"),
                 ("password", "MYSQL_PASSWORD"), ("database", "MYSQL_DATABASE"), ("ssl_ca", "MYSQL_SSL_CA")):
    if os.environ.get(env):
        MYSQL[key] = os.environ[env]
if os.environ.get("HOST"):
    HOST = os.environ["HOST"]
if os.environ.get("PORT"):
    PORT = int(os.environ["PORT"])
if os.environ.get("COOKIE_SECURE"):
    COOKIE_SECURE = os.environ["COOKIE_SECURE"].lower() in ("1", "true", "yes")
if os.environ.get("MAX_UPLOAD_MB"):
    MAX_UPLOAD_MB = int(os.environ["MAX_UPLOAD_MB"])
