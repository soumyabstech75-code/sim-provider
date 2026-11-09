# Netlify Frontend Deployment Guide

This guide explains how to deploy the frontend of **BSTPL SIM Info** to **Netlify** and connect it to your live Render backend (`https://sim-provider-1f4c.onrender.com`).

---

## ⚡ Option A: Netlify Drop (Fastest & Simplest — 30 Seconds)

1. Open your browser and go to: **[app.netlify.com/drop](https://app.netlify.com/drop)**
2. Log in to your Netlify account (if not already logged in).
3. Drag and drop the **`frontend`** folder (or the newly created **`netlify_frontend.zip`** located in your project root) into the drop zone.
4. Netlify will deploy your site in ~10 seconds and generate your live URL (e.g. `https://bstpl-sim-info.netlify.app`).

---

## 🐙 Option B: Connect via GitHub / GitLab

If your project is pushed to a GitHub repository:

1. Log in to [app.netlify.com](https://app.netlify.com).
2. Click **Add new site** ➔ **Import an existing project**.
3. Select **GitHub** and choose your repository.
4. Netlify will automatically detect the pre-configured `netlify.toml` settings:
   - **Base directory:** *(leave blank / empty)*
   - **Build command:** *(leave blank / empty)*
   - **Publish directory:** `frontend`
5. Click **Deploy site**.

---

## 🛠 Features Pre-Configured for Netlify

1. **Automatic Backend Proxying (`_redirects` & `netlify.toml`)**:
   - Any API request to `/api/*` is automatically forwarded by Netlify's edge servers to `https://sim-provider-1f4c.onrender.com/api/*`.
   - Bypasses cross-origin restrictions, eliminates third-party cookie blocks, and ensures fast CDN performance.

2. **Cross-Origin Bearer Authentication (`script.js`)**:
   - Session tokens are stored in `localStorage` and sent via `Authorization: Bearer <token>` with every fetch request and Excel export.

3. **Relative Asset Paths**:
   - CSS (`style.css`, `ux3d.css`) and JavaScript (`script.js`, `ux3d.js`) resolve directly from the root with fallback mirrors in `/static/`.

4. **Security & Cache Headers (`_headers`)**:
   - Disables stale browser caching for scripts and stylesheets so any future updates display immediately.
   - Adds `X-Content-Type-Options: nosniff` and `X-Frame-Options: SAMEORIGIN`.

