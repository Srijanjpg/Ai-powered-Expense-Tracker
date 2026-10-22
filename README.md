# AI-Powered Expense Tracker

A full-stack expense tracker for recording, categorizing, reviewing, and exporting personal expenses. The app combines a lightweight HTML/CSS/JavaScript frontend with a Python FastAPI backend, PostgreSQL persistence, optional Gemini-powered categorization, and S3 exports.

![Expense Tracker dashboard](demo.png)

## Deployment Status

The application has been deployed to an AWS EC2 instance. The production setup uses Docker, PostgreSQL, and Nginx, with the EC2 instance serving the FastAPI application.

## Features

- Create, edit, and delete expenses
- Categorize expenses as Food/Beverage, Travel/Commute, or Shopping
- Use Gemini to suggest a category from a natural-language description
- View total spending, category totals, and an expense breakdown
- Authenticate with JWT access tokens and refresh-token cookies
- Export a user's expenses as CSV files uploaded to private S3 storage
- Run locally with Docker Compose or a Python virtual environment

## Tech Stack

- **Frontend**
  - HTML5, CSS3, Vanilla JavaScript
  - Flatpickr (date picker via CDN)

- **Backend**
  - Python 3.12
  - FastAPI + Uvicorn
  - Pydantic (request/response validation)

- **Authentication & Security**
  - JWT access tokens (`python-jose`)
  - Refresh-token session flow with secure HTTP-only cookies
  - Password hashing with `passlib` + `bcrypt`

- **Database**
  - PostgreSQL 16
  - `psycopg` (PostgreSQL driver)

- **AI Integration**
  - Google Gemini API (model configurable via `GEMINI_MODEL`)
  - `httpx` for Gemini API requests

- **Cloud & Storage**
  - AWS S3 for CSV export storage
  - Pre-signed S3 URLs for time-limited downloads
  - `boto3` + `botocore`

- **Containerization & Deployment**
  - Docker (`Dockerfile`)
  - Docker Compose (`docker-compose.local.yml`) for app + Postgres stack
  - AWS EC2 deployment workflow documented in `DOCKER_EC2_DEPLOYMENT.md`
  - Nginx reverse proxy setup for EC2 production deployment

## Quick Start With Docker

### Prerequisites

- Docker Desktop with Docker Compose
- A Gemini API key if AI categorization is required
- AWS credentials and an S3 bucket if CSV export is required

### Setup

From the project root:

```bash
cp .env.example .env
```

Update `.env` with a strong `JWT_SECRET`. The Docker Compose database connection is already configured for the local PostgreSQL container. Add `GEMINI_API_KEY` and `S3_BUCKET_NAME` when using those features.

Start the application:

```bash
docker compose -f docker-compose.local.yml up --build
```

Open [http://localhost:3000](http://localhost:3000) in a browser. Stop the services with `Ctrl+C`, or run the following to remove the containers:

```bash
docker compose -f docker-compose.local.yml down
```

PostgreSQL data is stored in the `postgres-data` Docker volume and remains available across restarts.

## Local Python Development

Use this option when PostgreSQL is installed and running on the host machine.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 3000
```

For host PostgreSQL, set `DATABASE_URL` in `.env` to a connection such as:

```env
DATABASE_URL=postgresql://expense_user:your_password@localhost:5432/expense_tracker
```

The API creates its required tables when the application starts.

## Configuration

Copy `.env.example` to `.env` and configure the values needed for your environment:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret used to sign authentication tokens |
| `PORT` | Application port; defaults to `3000` |
| `GEMINI_API_KEY` | Optional Gemini API key for categorization |
| `GEMINI_MODEL` | Gemini model name |
| `S3_BUCKET_NAME` | Private S3 bucket used for exports |
| `S3_EXPORT_PREFIX` | Folder prefix for exported files |
| `S3_DOWNLOAD_TTL_SECONDS` | Pre-signed URL lifetime |
| `AWS_REGION` | AWS region for S3 |
| `S3_ENDPOINT_URL` | Optional S3-compatible service endpoint |
| `S3_ADDRESSING_STYLE` | S3 addressing mode, usually `auto` |

Never commit `.env` or real API keys. AWS credentials can be provided through the standard AWS configuration, environment variables, or an EC2 IAM role.

## AWS S3 Export Storage

Expense exports are generated as CSV files and stored in a private AWS S3 bucket. When a user selects **Export CSV**, the application:

1. Generates a CSV file containing the authenticated user's expenses.
2. Uploads the file to the configured S3 bucket under `S3_EXPORT_PREFIX`.
3. Returns a time-limited pre-signed URL for downloading the file.

The EC2 deployment uses an IAM role or AWS credentials with permission to upload and download objects in the configured export path. Set `S3_BUCKET_NAME`, `AWS_REGION`, and the related S3 variables in `.env` to enable this feature.

## Using the App

1. Create an account or sign in.
2. Enter an expense description, amount, category, and date.
3. Use **Fill with Gemini** to get an AI-assisted description and category when Gemini is configured.
4. Review totals and the expense breakdown on the dashboard.
5. Select **Export CSV** to generate an export and receive a temporary download link when S3 is configured.

## API

The FastAPI server serves the frontend and API from the same origin. Available routes and request models are defined in [`main.py`](main.py). The interactive API documentation is available at [http://localhost:3000/docs](http://localhost:3000/docs) while the app is running.

## Deployment

The application is deployed on AWS EC2 using Docker, PostgreSQL, and Nginx. AWS S3 is used for private CSV export storage and time-limited downloads.

For the deployment steps and configuration details, see [`DOCKER_EC2_DEPLOYMENT.md`](DOCKER_EC2_DEPLOYMENT.md).

The included [`Dockerfile`](Dockerfile) and [`docker-compose.local.yml`](docker-compose.local.yml) provide the base container setup.

## Project Structure

```text
.
├── main.py                  # FastAPI application and database schema setup
├── index.html               # Frontend markup
├── script.js                # Frontend behavior and API calls
├── style.css                # Application styles
├── demo.png                 # Dashboard screenshot
├── requirements.txt         # Python dependencies
├── Dockerfile               # Application image
└── docker-compose.local.yml # Local app and PostgreSQL services
```

## Contributing

1. Create a feature branch.
2. Make and test your changes locally.
3. Update the README or `.env.example` when configuration changes.
4. Open a pull request with a clear description of the change.

## License

This project is provided as-is. Add a license file before distributing it publicly.
