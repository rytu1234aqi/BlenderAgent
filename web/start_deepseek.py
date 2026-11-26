from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys


def configured_key() -> str | None:
    if sys.platform != "win32":
        return os.environ.get("DEEPSEEK_API_KEY")
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as environment:
            value, _ = winreg.QueryValueEx(environment, "DEEPSEEK_API_KEY")
    except FileNotFoundError:
        return None
    return value if isinstance(value, str) else None


key = configured_key()
if not key or not key.strip():
    raise SystemExit("DEEPSEEK_API_KEY is not configured in the current Windows user environment.")

os.environ["DEEPSEEK_API_KEY"] = key
root = Path(__file__).resolve().parent.parent
npm = "npm.cmd" if sys.platform == "win32" else "npm"
completed = subprocess.run([npm, "run", "start", "--prefix", "web"], cwd=root, check=False)
raise SystemExit(completed.returncode)
