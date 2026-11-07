"""Copy this file to config_local.py and fill in your real values. config_local.py must NOT be committed to git."""
MYSQL = {
    "host": "gateway01.ap-northeast-1.prod.aws.tidbcloud.com",
    "port": 4000,
    "user": "YOUR_USER",
    "password": "YOUR_PASSWORD",
    "database": "sim_provider_data",
    "ssl_ca": "/etc/ssl/certs/ca-certificates.crt",   # TiDB Cloud needs TLS; on Windows download the CA file from the TiDB Cloud console
}
# COOKIE_SECURE = True      # when served over HTTPS
# HOST = "0.0.0.0"          # to reach it from other computers (put it behind HTTPS!)
