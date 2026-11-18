"""AI-Assisted Quiet Hours Scheduler - Python (FastAPI) backend."""

from pathlib import Path

from dotenv import load_dotenv

SERVER_DIR = Path(__file__).resolve().parent.parent

# Load server/.env (if present) before any module reads configuration.
if (SERVER_DIR / ".env").exists():
    load_dotenv(SERVER_DIR / ".env")
else:
    print(".env not found. Continuing without it.")
