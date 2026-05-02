# Docker + EC2 Deployment Roadmap

This setup runs both services in Docker:

- `app`: FastAPI expense tracker
- `postgres`: PostgreSQL database with persistent Docker volume

The S3 export still uses AWS S3. On EC2, `boto3` should use the EC2 IAM role.

## Phase 1: Local Docker Setup

### 1. Create `.env`

Create `.env` in the project root:

```env
DATABASE_URL=postgresql://expense_user:expense_password@postgres:5432/expense_tracker
JWT_SECRET=YOUR_STRONG_SECRET
GEMINI_API_KEY=YOUR_GEMINI_KEY
GEMINI_MODEL=gemini-1.5-flash
S3_BUCKET_NAME=your-private-export-bucket
S3_EXPORT_PREFIX=exports
S3_DOWNLOAD_TTL_SECONDS=600
PORT=3000
```

Important: inside Docker Compose, the database hostname is `postgres`, not `localhost`.

### 2. Build and run the full stack

```bash
docker compose -f docker-compose.local.yml up --build
```

Open:

```text
http://localhost:3000
```

The backend creates the database tables automatically when it starts.

### 3. Run in the background

```bash
docker compose -f docker-compose.local.yml up --build -d
```

### 4. View logs

```bash
docker compose -f docker-compose.local.yml logs -f
```

Only app logs:

```bash
docker compose -f docker-compose.local.yml logs -f app
```

Only Postgres logs:

```bash
docker compose -f docker-compose.local.yml logs -f postgres
```

### 5. Stop containers without deleting data

```bash
docker compose -f docker-compose.local.yml down
```

Your database data remains in the named Docker volume `expense-tracker-app_postgres-data` or a similarly named Compose volume.

### 6. Stop containers and delete database data

Only do this when you want a clean database:

```bash
docker compose -f docker-compose.local.yml down -v
```

### 7. Access PostgreSQL from your machine

Because Compose maps Postgres to host port `5432`, you can connect with:

```bash
psql -h localhost -U expense_user -d expense_tracker
```

Password:

```text
expense_password
```

Useful queries:

```sql
SELECT id, username, created_at FROM users ORDER BY id;
SELECT id, user_id, amount, description, category, expense_date FROM expenses ORDER BY id DESC;
\q
```

### 8. Local S3 testing

If your local machine has AWS CLI credentials in `~/.aws`, `docker-compose.local.yml` mounts them read-only into the app container.

Check your local AWS identity:

```bash
aws sts get-caller-identity
```

The IAM user/role needs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject"
      ],
      "Resource": "arn:aws:s3:::your-private-export-bucket/exports/*"
    }
  ]
}
```

## Phase 2: EC2 Setup

### 1. SSH into EC2

```bash
ssh -i /path/to/key.pem ubuntu@YOUR_EC2_PUBLIC_IP
```

### 2. Install Docker, Docker Compose plugin, Nginx, and Git

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin nginx git
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker ubuntu
```

Log out and SSH back in so Docker permissions refresh.

### 3. Clone or update the project

```bash
git clone https://github.com/Srijanjpg/Ai-powered-Expense-Tracker.git
cd Ai-powered-Expense-Tracker
```

For later deployments:

```bash
cd ~/Ai-powered-Expense-Tracker
git pull
```

### 4. Create EC2 `.env`

```bash
nano .env
```

Use:

```env
DATABASE_URL=postgresql://expense_user:expense_password@postgres:5432/expense_tracker
JWT_SECRET=YOUR_STRONG_SECRET
GEMINI_API_KEY=YOUR_GEMINI_KEY
GEMINI_MODEL=gemini-1.5-flash
S3_BUCKET_NAME=your-private-export-bucket
S3_EXPORT_PREFIX=exports
S3_DOWNLOAD_TTL_SECONDS=600
PORT=3000
NODE_ENV=production
```

For a real EC2 deployment, change `expense_password` in both `.env` and `docker-compose.local.yml`.

## Phase 3: Run The Docker Stack On EC2

Run the stack:

```bash
docker compose -f docker-compose.local.yml up --build -d
```

Check containers:

```bash
docker ps
```

Check logs:

```bash
docker compose -f docker-compose.local.yml logs -f
```

Test from EC2:

```bash
curl http://127.0.0.1:3000
```

## Phase 4: Nginx Reverse Proxy

Create Nginx config:

```bash
sudo nano /etc/nginx/sites-available/expense-tracker
```

Use:

```nginx
server {
    listen 80;
    server_name YOUR_EC2_PUBLIC_IP_OR_DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable:

```bash
sudo ln -s /etc/nginx/sites-available/expense-tracker /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

Open:

```text
http://YOUR_EC2_PUBLIC_IP_OR_DOMAIN
```

Only expose ports `80`, `443`, and `22` in the EC2 security group. Do not expose `3000` or `5432`.

## Phase 5: S3 Integration On EC2

Create a private S3 bucket and keep public access blocked.

Attach an IAM role to the EC2 instance with:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject"
      ],
      "Resource": "arn:aws:s3:::your-private-export-bucket/exports/*"
    }
  ]
}
```

No AWS keys are needed in `.env` on EC2. `boto3` reads the EC2 IAM role automatically.

Restart after attaching/updating the role:

```bash
docker compose -f docker-compose.local.yml restart app
```

Test:

1. Log in through the UI.
2. Add an expense.
3. Click `Export CSV`.
4. Confirm the CSV downloads.
5. Confirm an object exists in S3 under `exports/user-USER_ID/`.

## Phase 6: Redeploy After Code Changes

```bash
cd ~/Ai-powered-Expense-Tracker
git pull
docker compose -f docker-compose.local.yml up --build -d
```

If you changed only environment variables:

```bash
docker compose -f docker-compose.local.yml up -d
```

## Phase 7: Database Backup

Create a database backup:

```bash
docker exec expense-tracker-postgres pg_dump -U expense_user expense_tracker > expense_tracker_backup.sql
```

Restore a backup into the running database:

```bash
cat expense_tracker_backup.sql | docker exec -i expense-tracker-postgres psql -U expense_user -d expense_tracker
```

## Phase 8: Optional HTTPS

If using a domain:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

Then make sure `.env` contains:

```env
NODE_ENV=production
```

Restart:

```bash
docker compose -f docker-compose.local.yml restart app
```
