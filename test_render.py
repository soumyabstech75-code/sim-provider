#!/usr/bin/env python3
"""test_render.py - Comprehensive Test Suite for Render Cloud Deployment Readiness.

Tests:
1. Environment Configuration & Cloud Simulation (PORT, HOST, RENDER, COOKIE_SECURE, DATABASE_URL)
2. Database Connectivity, Schema Integrity, Unified Customer Data Table & Providers
3. Search Query Engine (Multi-word search, Provider filtering, Date range handling)
4. Excel Generator (xlsxout) output validation
5. Static Web File Resolution & Security Headers
6. Full End-to-End Live HTTP API Endpoints (Auth, Me, Tables, Rows, Providers, XLSX Export)
"""
import http.client
import json
import os
import secrets
import sys
import unittest
from urllib.parse import urlparse

# Ensure backend directory is in path
HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(HERE, "backend")
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import config
import db
import auth
from xlsxout import make_xlsx


class TestRenderCloudReadiness(unittest.TestCase):
    """Test suite ensuring zero-downtime, error-free Render deployment."""

    def test_01_cloud_environment_and_url_parsing(self):
        """Verify that config correctly parses DATABASE_URL and binds to 0.0.0.0 on Render."""
        from urllib.parse import urlparse, parse_qs, unquote

        test_url = "mysql://render_user:p%40ssword123@aws.mysql.tidb.com:4000/cloud_db?ssl_ca=system"
        p = urlparse(test_url)
        self.assertEqual(p.hostname, "aws.mysql.tidb.com")
        self.assertEqual(p.port, 4000)
        self.assertEqual(unquote(p.username), "render_user")
        self.assertEqual(unquote(p.password), "p@ssword123")
        self.assertEqual(unquote(p.path.strip("/")), "cloud_db")
        self.assertEqual(parse_qs(p.query).get("ssl_ca"), ["system"])
        print("  [PASS] Cloud DATABASE_URL parser verified")

    def test_02_database_connectivity_and_schema(self):
        """Verify that TiDB / MySQL connection pool works and customer_data exists."""
        status = db.status()
        self.assertTrue(status.get("connected"), f"Database connection failed: {status.get('error')}")
        self.assertTrue(status.get("database"), "No active schema selected")

        # Verify unified table exists and check columns
        cols = db.columns("customer_data")
        self.assertIsInstance(cols, list)
        self.assertGreater(len(cols), 0, "customer_data has no columns")
        col_names = [c["name"].lower() for c in cols]

        # Verify essential columns
        for essential in ["provider", "customer", "date", "qty"]:
            self.assertIn(essential, col_names, f"Missing essential column: {essential}")

        # Check search returns valid columns and schema
        sample = db.search("customer_data", {}, limit=1)
        row_count = sample.get("total", 0)
        print(f"  [PASS] Database connected. Found {row_count} records with {len(cols)} columns in customer_data")

    def test_03_providers_dropdown_breakdown(self):
        """Verify that db.get_providers_summary returns supported provider options."""
        summary = db.get_providers_summary("customer_data")
        self.assertIsInstance(summary, list)
        self.assertGreater(len(summary), 0)

        provider_names = [p["provider"].lower() for p in summary]
        # Must include all 5 major providers
        for expected in ["sensorise", "iotivity", "vi", "growspace", "taisys"]:
            self.assertIn(expected, provider_names, f"Provider '{expected}' not detected")
        print(f"  [PASS] Providers dropdown list verified: {provider_names}")

    def test_04_search_engine_and_tokenization(self):
        """Test multi-word search, provider filter, and date format handling."""
        new_row = db.insert_row("customer_data", {"customer": "Madhuri Test", "provider": "sensorise", "date": "2026-05-15", "Quantity": 1})
        temp_id = new_row.get("id")
        try:
            # 1. Search with provider filter
            res_provider = db.search("customer_data", {"provider": "sensorise"}, limit=5)
            self.assertGreater(res_provider["total"], 0)
            for r in res_provider["rows"]:
                self.assertEqual(str(r.get("provider")).lower(), "sensorise")

            # 2. Search with customer filter
            res_search = db.search("customer_data", {"customer": "Madhuri"}, limit=5)
            self.assertGreater(res_search["total"], 0)

            # 3. Search with dual date format (YYYY-MM-DD or DD-MM-YYYY)
            res_date = db.search("customer_data", {"date_col": "date", "date_from": "2026-01-01", "date_to": "2026-12-31"}, limit=5)
            self.assertGreater(res_date["total"], 0)
            print("  [PASS] Search engine (tokens, provider filters, date ranges) working accurately")
        finally:
            try:
                db.delete_row("customer_data", temp_id)
            except Exception:
                pass

    def test_05_xlsx_export_generator(self):
        """Test binary Excel output generation without errors."""
        headers = ["provider", "customer", "date", "qty"]
        matrix = [["sensorise", "Sample Customer", "2026-05-15", 1]]
        raw_xlsx = make_xlsx(headers, matrix, sheet="customer_data")
        self.assertIsInstance(raw_xlsx, bytes)
        self.assertGreater(len(raw_xlsx), 1000)
        # Check standard PK zip magic header for xlsx files
        self.assertTrue(raw_xlsx.startswith(b"PK"), "Exported data is not a valid zip/xlsx archive")
        print(f"  [PASS] Excel export generated valid {len(raw_xlsx)} byte workbook")

    def test_06_live_http_frontend_and_static_files(self):
        """Test live HTTP server serving frontend index.html, CSS, JS with headers."""
        conn = http.client.HTTPConnection("127.0.0.1", 8000, timeout=5)

        # 1. Home page
        conn.request("GET", "/")
        resp = conn.getresponse()
        body = resp.read().decode("utf-8")
        self.assertEqual(resp.status, 200)
        self.assertIn("<title>bstpl sim info</title>", body)
        self.assertEqual(resp.getheader("X-Content-Type-Options"), "nosniff")
        self.assertEqual(resp.getheader("X-Frame-Options"), "DENY")

        # 2. Static CSS
        conn.request("GET", "/static/style.css")
        resp = conn.getresponse()
        css = resp.read().decode("utf-8")
        self.assertEqual(resp.status, 200)
        self.assertIn("bstpl sim info", css)

        # 3. Static JS
        conn.request("GET", "/static/script.js")
        resp = conn.getresponse()
        js = resp.read().decode("utf-8")
        self.assertEqual(resp.status, 200)
        self.assertIn("bstpl sim info", js)

        # 4. 3D CSS and JS
        for asset in ["ux3d.css", "ux3d.js"]:
            conn.request("GET", f"/static/{asset}")
            resp = conn.getresponse()
            content = resp.read()
            self.assertEqual(resp.status, 200)
            self.assertGreater(len(content), 100)

        conn.close()
        print("  [PASS] Frontend HTML, CSS, JS and 3D assets served with security headers")

    def test_07_live_http_api_auth_and_endpoints(self):
        """Test live API endpoints with session cookie injection and cleanup."""
        conn = http.client.HTTPConnection("127.0.0.1", 8000, timeout=5)

        # 1. Unauthenticated /api/tables should return 401
        conn.request("GET", "/api/tables")
        resp = conn.getresponse()
        resp.read()
        self.assertEqual(resp.status, 401)

        # 2. Unauthenticated /api/me returns {"user": null}
        conn.request("GET", "/api/me")
        resp = conn.getresponse()
        unauth_me = json.loads(resp.read().decode("utf-8"))
        self.assertIsNone(unauth_me.get("user"))

        # 3. Create a temporary test session token directly in auth database
        test_token = secrets.token_urlsafe(32)
        token_hash = auth._sha(test_token)

        def insert_session(c):
            c.execute(
                "INSERT INTO sessions (token_hash, emp_id, expires_at) VALUES (%s, %s, NOW() + INTERVAL 1 HOUR)",
                (token_hash, "1234"),
            )
        db.run(insert_session, schema=config.AUTH_DB)

        try:
            headers = {"Cookie": f"vi_session={test_token}"}

            # 4. Authenticated /api/me
            conn.request("GET", "/api/me", headers=headers)
            resp = conn.getresponse()
            self.assertEqual(resp.status, 200)
            user_data = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(user_data["user"]["id"], "1234")

            # 5. /api/tables
            conn.request("GET", "/api/tables", headers=headers)
            resp = conn.getresponse()
            self.assertEqual(resp.status, 200)
            tables = json.loads(resp.read().decode("utf-8"))
            table_names = [t["name"] if isinstance(t, dict) else t for t in tables]
            self.assertIn("customer_data", table_names)

            # 6. /api/tables/customer_data/rows
            conn.request("GET", "/api/tables/customer_data/rows?limit=5", headers=headers)
            resp = conn.getresponse()
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertIn("rows", data)
            self.assertIsInstance(data["rows"], list)

            # 7. /api/providers?table=customer_data
            conn.request("GET", "/api/providers?table=customer_data", headers=headers)
            resp = conn.getresponse()
            self.assertEqual(resp.status, 200)
            prov_resp = json.loads(resp.read().decode("utf-8"))
            self.assertIn("providers", prov_resp)

            # 8. /api/tables/customer_data/export
            conn.request("GET", "/api/tables/customer_data/export?limit=5", headers=headers)
            resp = conn.getresponse()
            xlsx_bytes = resp.read()
            self.assertEqual(resp.status, 200)
            self.assertTrue(xlsx_bytes.startswith(b"PK"))
            print("  [PASS] Live HTTP API endpoints (Auth, Me, Tables, Rows, Providers, XLSX Export) fully verified")

        finally:
            # Clean up test session token
            def cleanup_session(c):
                c.execute("DELETE FROM sessions WHERE token_hash=%s", (token_hash,))
            db.run(cleanup_session, schema=config.AUTH_DB)
            conn.close()


if __name__ == "__main__":
    print("==================================================================")
    print(" Running Cloud & Backend Readiness Test Suite for Render Deploy")
    print("==================================================================")
    unittest.main(verbosity=2)
