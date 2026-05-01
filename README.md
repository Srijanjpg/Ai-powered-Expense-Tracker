# FastAPI backend (Step 1)

## Setup
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

## Run
uvicorn main:app --reload --port 3000

## Notes
- Uses the existing expense_tracker.db SQLite file.
- Keeps the same /api routes and responses as the Node backend.