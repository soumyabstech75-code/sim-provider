# Render Deployment Guide: BSTPL SIM Info

This guide walks you through deploying the **BSTPL SIM Info** full-stack web application (FastAPI backend + HTML5/CSS/JS frontend) to [Render](https://render.com).

---

## 🚀 Key Configurations Implemented

The repository has been pre-configured for Render:
1. **Dynamic Port Binding (`$PORT`)**: Render assigns a random port at runtime. The app listens on `0.0.0.0:$PORT`.
2. **Unified Full-Stack Delivery**: FastAPI automatically serves both the backend REST API (`/api/*`) and the frontend single-page application (`/` and `/static/*`). You only need **one single Render Web Service** (no need to pay for separate frontend hosting).
3. **Flexible Database Credentials**: Reads standard `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` or a unified `DATABASE_URL` / `MYSQL_URL`.
4. **Cloud SSL/TLS Support**: Automatically enables TLS and detects system CA certificates (`/etc/ssl/certs/ca-certificates.crt`) required by TiDB Cloud and AWS RDS.
5. **Auto HTTPS Cookies**: `COOKIE_SECURE` automatically turns on under Render (`*.onrender.com`).
6. **Deployment Files**:
   - `requirements.txt` — Python dependencies (`fastapi`, `uvicorn`, `gunicorn`, `pymysql`, `openpyxl`, `cryptography`, `python-multipart`).
   - `render.yaml` — Render Blueprint specification for 1-click deployment.
   - `Procfile` — Process runner `web: uvicorn app:app --host 0.0.0.0 --port $PORT`.
   - `.env.example` — Reference template for environment variables.
   - `.gitignore` — Prevents secrets and temporary files from being committed.

---

## 📋 Option 1: Standard Web Service Setup (Recommended)

### Step 1: Push Code to GitHub / GitLab
1. Initialize git in your project directory (if not already done) and commit all files:
   ```bash
   git init
   git add .
   git commit -m "Configure full-stack app for Render deployment"
   ```
2. Push the code to a repository on GitHub (or GitLab).

---

### Step 2: Create a Web Service on Render
1. Log in to [dashboard.render.com](https://dashboard.render.com).
2. Click **New +** in the top right and select **Web Service**.
3. Choose **Build and deploy from a Git repository** and select your GitHub repository.
4. Fill in the service details:
   - **Name**: `bstpl-sim-info` (or your preferred name)
   - **Region**: Choose the region closest to you or your database (e.g., `Singapore`, `Frankfurt`, or `Oregon`)
   - **Language / Runtime**: `Python`
   - **Branch**: `main` (or `master`)
   - **Root Directory**: *(leave blank)*
   - **Build Command**:
     ```bash
     pip install -r requirements.txt
     ```
   - **Start Command**:
     ```bash
     uvicorn app:app --host 0.0.0.0 --port $PORT
     ```
   - **Instance Type**: `Free` (or `Starter` / `Standard`)

---

### Step 3: Add Environment Variables in Render Dashboard
Scroll down to the **Environment Variables** section and click **Add Environment Variable**:

| Variable Key | Recommended Value / Description |
| :--- | :--- |
| `PYTHON_VERSION` | `3.11.8` |
| `MYSQL_HOST` | `gateway01.ap-northeast-1.prod.aws.tidbcloud.com` (or your host) |
| `MYSQL_PORT` | `4000` |
| `MYSQL_USER` | `2DQWZxtzB8QkzXZ.root` |
| `MYSQL_PASSWORD` | `RTksF8mDqlKfQz8u` (or your database password) |
| `MYSQL_DATABASE` | `sim_provider_data` |
| `MYSQL_SSL_CA` | `system` |
| `COOKIE_SECURE` | `true` |
| `SESSION_HOURS` | `12` |
| `MAX_UPLOAD_MB` | `25` |

*(Optional)* If you prefer using a single connection string instead of separate variables, you can set:
```env
DATABASE_URL=mysql://2DQWZxtzB8QkzXZ.root:RTksF8mDqlKfQz8u@gateway01.ap-northeast-1.prod.aws.tidbcloud.com:4000/sim_provider_data?ssl_ca=system
```

---

### Step 4: Deploy & Verify
1. Click **Create Web Service**.
2. Render will build the environment, install packages from `requirements.txt`, and start the app with Uvicorn.
3. When the deploy log displays:
   ```
   Application startup complete.
   Uvicorn running on http://0.0.0.0:10000
   ==> Your service is live 🎉 at https://bstpl-sim-info.onrender.com
   ```
4. Click your Render URL (`https://your-service-name.onrender.com`) to access the website!

---

## 🛠 Option 2: Render Blueprint (Infrastructure as Code)

Because `render.yaml` is already present in your project:
1. Go to [dashboard.render.com/blueprints](https://dashboard.render.com/blueprints).
2. Click **New Blueprint Instance**.
3. Select your repository. Render will automatically parse `render.yaml` and configure the build command, start command, and environment variables.
4. When prompted for `MYSQL_PASSWORD`, enter your database password.
5. Click **Apply**.

---

## 🔐 Initial Login Credentials

- **Employee ID**: `1234`
- **Password**: `1234567890`

At first sign-in, the system will prompt you to change the administrator password. Once changed, other team members can be added from the **Team** tab.

