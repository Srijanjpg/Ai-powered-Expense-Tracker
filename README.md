# AI-Powered Expense Tracker

## Setup
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

Create a `.env` file:

DATABASE_URL=postgresql://expense_user:YOUR_PASSWORD@localhost:5432/expense_tracker
JWT_SECRET=YOUR_STRONG_SECRET
GEMINI_API_KEY=YOUR_GEMINI_KEY
GEMINI_MODEL=gemini-1.5-flash
S3_BUCKET_NAME=your-private-export-bucket
S3_EXPORT_PREFIX=exports
S3_DOWNLOAD_TTL_SECONDS=600

## Run
uvicorn main:app --reload --port 3000

## Export expenses to S3
Authenticated users can call:

GET /export

The endpoint creates a CSV of that user's expenses, uploads it to the private S3 bucket, and returns a temporary pre-signed download URL.

## Notes
- Uses PostgreSQL.
- Uses AWS credentials from the EC2 instance role or standard AWS environment/config files.
