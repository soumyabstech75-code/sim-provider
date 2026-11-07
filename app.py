"""app.py - Root entry point that launches backend/app.py.
Allows running 'python app.py' directly from the root workspace.
"""
import os
import runpy
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(HERE, "backend")

if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

os.chdir(BACKEND_DIR)

if __name__ == "__main__":
    runpy.run_path(os.path.join(BACKEND_DIR, "app.py"), run_name="__main__")
else:
    import importlib.util
    spec = importlib.util.spec_from_file_location("backend_app", os.path.join(BACKEND_DIR, "app.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    app = mod.app
