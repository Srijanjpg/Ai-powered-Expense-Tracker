# Ai-Powered Expense Tracker

A lightweight web app to record, analyze, and export personal expenses — enhanced with AI-powered categorization and smart export capabilities.

**Highlights:**
- Modern single-file frontend (`index.html`, `script.js`, `style.css`) with a simple Python backend (`main.py`).
- Persistent storage via PostgreSQL and optional CSV export to AWS S3 with pre-signed URLs.
- Docker-ready for local development and EC2 deployment.

--

**Table of Contents**
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Quick Start (dev)](#quick-start-dev)
- [Environment & Configuration](#environment--configuration)
- [Run & Usage](#run--usage)
- [Docker & Deployment](#docker--deployment)
- [Exporting Data](#exporting-data)
- [Contributing](#contributing)
- [License & Contact](#license--contact)

--

## Features

- Add, edit, and remove expenses from a simple UI
- Automatic AI-assisted categorization (configurable model)
- CSV export per-user uploaded to S3 with time-limited pre-signed download links
- Configurable authentication via JWT

## Tech Stack

- Frontend: HTML, CSS, JavaScript (`index.html`, `script.js`, `style.css`)
- Backend: Python (see `main.py`)
- Database: PostgreSQL
- Storage: AWS S3 for exports
- DevOps: `Dockerfile`, `docker-compose.local.yml`

## Quick Start (dev)

1. Create and activate a Python virtual environment

```bash
python -m venv .venv
source .venv/bin/activate
```

2. Install dependencies

```bash
pip install -r requirements.txt
```

3. Create a `.env` file (see below) and start the app

```bash
# from project root
python main.py
# or, if the app uses ASGI/uvicorn:
uvicorn main:app --reload --port 3000
```

Open the frontend at `http://localhost:3000` (or the port configured in the app).

## Environment & Configuration

Create a `.env` file in the project root and set at minimum:

```
DATABASE_URL=postgresql://expense_user:expense_password@postgres:5432/expense_tracker
JWT_SECRET=YOUR_STRONG_SECRET
GEMINI_API_KEY=YOUR_GEMINI_KEY
GEMINI_MODEL=gemini-1.5-flash
S3_BUCKET_NAME=your-private-export-bucket
S3_EXPORT_PREFIX=exports
S3_DOWNLOAD_TTL_SECONDS=600
AWS_REGION=ap-south-1
S3_ENDPOINT_URL=
S3_ADDRESSING_STYLE=auto
```

Notes:
- `GEMINI_API_KEY` / `GEMINI_MODEL` are used if AI categorization is enabled.
- AWS credentials may come from the environment, IAM role (EC2), or standard AWS config.
- Leave `S3_ENDPOINT_URL` empty for AWS S3. Set it only for S3-compatible providers, and use `S3_ADDRESSING_STYLE=path` if your provider does not support virtual-hosted bucket URLs.

## Run & Usage

- Start the backend server (see Quick Start).
- The frontend served by the backend will allow creating and browsing expenses.
- API: the app exposes endpoints (e.g., `/export`) to request CSV exports and other CRUD operations — consult `main.py` for the exact routes.

## Exporting Data

Authenticated users can request a CSV export of their expenses. The server will:

1. Generate a per-user CSV
2. Upload it to the configured S3 bucket under the `S3_EXPORT_PREFIX`
3. Return a time-limited pre-signed download URL (`S3_DOWNLOAD_TTL_SECONDS` controls expiry)

Example (local quick test):

```bash
curl -H "Authorization: Bearer <JWT>" http://localhost:3000/export
```

## Docker & Deployment

- Local Docker (recommended for environment parity):

```bash
docker compose -f docker-compose.local.yml up --build
```

- For EC2 deploy steps and a phased guide, see [DOCKER_EC2_DEPLOYMENT.md](DOCKER_EC2_DEPLOYMENT.md).

## Contributing

Contributions, issues, and feature requests are welcome. Suggested workflow:

1. Fork the repo
2. Create a branch for your feature/fix
3. Open a pull request describing your change

If you add new env vars or services, update this `README.md` and the sample `.env`.

## License & Contact

This project is provided as-is. Add your license file if you wish to open-source it.

For questions or help, open an issue or contact the maintainer.
