"""app.py - Root entry point for Render, Netlify backend integration, and local execution.

Allows running:
  uvicorn app:app --host 0.0.0.0 --port $PORT
  uvicorn backend.app:app --host 0.0.0.0 --port $PORT
  python app.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(HERE, "backend")

if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from backend.app import app

if __name__ == "__main__":
    import uvicorn
    import config
    uvicorn.run("backend.app:app", host=config.HOST, port=config.PORT, reload=False)

