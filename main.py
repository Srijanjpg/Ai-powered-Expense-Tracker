import os
import secrets
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import httpx
import psycopg
from dotenv import load_dotenv
from fastapi import FastAPI, Request, Response, HTTPException, Depends
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from jose import jwt, JWTError
from passlib.context import CryptContext
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://expense_user@localhost:5432/expense_tracker")

# ----------------------------
# Settings (mirrors server.js)
# ----------------------------
PORT = int(os.getenv("PORT", "3000"))
JWT_SECRET = os.getenv("JWT_SECRET", "dev_only_change_this_secret")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-1.5-flash")

ACCESS_TOKEN_TTL_SECONDS = 15 * 60
REFRESH_TOKEN_TTL_DAYS = 7
REFRESH_COOKIE_NAME = "refresh_token"
EXPENSE_CATEGORIES = ["Food/Beverage", "Travel/Commute", "Shopping"]

BASE_DIR = Path(__file__).resolve().parent

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# ----------------------------
# Database helpers
# ----------------------------
def get_db():
    return psycopg.connect(DATABASE_URL)

async def run(query: str, params: tuple = ()):
    def _run():
        conn = get_db()
        cur = conn.cursor()
        cur.execute(query, params)
        conn.commit()
        last_id = cur.fetchone()[0] if cur.description else None
        changes = cur.rowcount
        cur.close()
        conn.close()
        return {"id": last_id, "changes": changes}
    return await run_in_threadpool(_run)

async def get_one(query: str, params: tuple = ()):
    def _get_one():
        conn = get_db()
        cur = conn.cursor()
        cur.execute(query, params)
        row = cur.fetchone()
        cur.close()
        conn.close()
        return row
    return await run_in_threadpool(_get_one)

async def get_all(query: str, params: tuple = ()):
    def _get_all():
        conn = get_db()
        cur = conn.cursor()
        cur.execute(query, params)
        rows = cur.fetchall()
        cur.close()
        conn.close()
        return rows
    return await run_in_threadpool(_get_all)

# ----------------------------
# Schema setup (Postgres)
# ----------------------------
async def initialize_database():
    await run("""
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
    """)
    await run("""
        CREATE TABLE IF NOT EXISTS expenses (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          amount NUMERIC(12, 2) NOT NULL,
          description TEXT NOT NULL,
          category TEXT NOT NULL,
          expense_date DATE NOT NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
    """)
    await run("""
        CREATE TABLE IF NOT EXISTS refresh_tokens (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token TEXT NOT NULL UNIQUE,
          expires_at TIMESTAMP NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
    """)

async def revoke_expired_refresh_tokens():
    await run("DELETE FROM refresh_tokens WHERE expires_at <= NOW()")

# ----------------------------
# Auth helpers
# ----------------------------
def generate_access_token(user_id: int, username: str) -> str:
    payload = {
        "id": user_id,
        "username": username,
        "exp": datetime.utcnow() + timedelta(seconds=ACCESS_TOKEN_TTL_SECONDS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")

def set_refresh_cookie(response: Response, token: str):
    is_production = os.getenv("NODE_ENV") == "production"
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=token,
        httponly=True,
        secure=is_production,
        samesite="lax",
        max_age=REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
        path="/",
    )

def clear_refresh_cookie(response: Response):
    is_production = os.getenv("NODE_ENV") == "production"
    response.delete_cookie(
        key=REFRESH_COOKIE_NAME,
        httponly=True,
        secure=is_production,
        samesite="lax",
        path="/",
    )

async def create_refresh_token(user_id: int) -> str:
    token = secrets.token_hex(48)
    expires_at = (datetime.utcnow() + timedelta(days=REFRESH_TOKEN_TTL_DAYS)).isoformat()
    result = await run(
        "INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (%s, %s, %s) RETURNING id",
        (user_id, token, expires_at),
    )
    return token

async def revoke_refresh_token(token: Optional[str]):
    if not token:
        return
    await run("DELETE FROM refresh_tokens WHERE token = %s", (token,))

async def issue_session(user_id: int, username: str, response: Response) -> str:
    access_token = generate_access_token(user_id, username)
    refresh_token = await create_refresh_token(user_id)
    set_refresh_cookie(response, refresh_token)
    return access_token

async def get_current_user(request: Request):
    auth_header = request.headers.get("authorization", "")
    token = auth_header[7:] if auth_header.startswith("Bearer ") else ""
    if not token:
        raise HTTPException(status_code=401, detail="Missing authentication token.")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        return payload
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token.")

# ----------------------------
# Validation helpers (same logic)
# ----------------------------
def is_strong_password(password: str) -> bool:
    return (
        len(password) >= 8
        and any(c.islower() for c in password)
        and any(c.isupper() for c in password)
        and any(c.isdigit() for c in password)
        and any(not c.isalnum() for c in password)
    )

def validate_auth_input(username: str, password: str, password_confirm: str, is_register: bool) -> str:
    if not username or not password:
        return "Username and password are required."
    if len(username) < 3 or len(username) > 30:
        return "Username must be 3-30 characters."
    if is_register and not is_strong_password(password):
        return "Password must be 8+ chars with upper, lower, number, and symbol."
    if is_register and password != password_confirm:
        return "Passwords do not match."
    return ""

def normalize_expense(row):
    return {
        "id": row[0],
        "amount": float(row[1]),
        "description": row[2],
        "category": row[3],
        "date": row[4].isoformat() if hasattr(row[4], "isoformat") else row[4],
    }

def parse_model_category(raw_category: Optional[str]) -> Optional[str]:
    if not raw_category:
        return None
    normalized = str(raw_category).strip().lower()
    if normalized in ("food/beverage", "food", "beverage"):
        return "Food/Beverage"
    if normalized in ("travel/commute", "travel", "commute"):
        return "Travel/Commute"
    if normalized == "shopping":
        return "Shopping"
    return None

def parse_loose_number(value):
    if isinstance(value, (int, float)):
        return float(value) if value == value else None
    if not isinstance(value, str):
        return None
    normalized = value.replace(",", "").replace("rs.", "").replace("inr", "").replace("₹", "").strip()
    if not normalized:
        return None
    try:
        return float(normalized)
    except ValueError:
        return None

def extract_amount_from_text(text: str):
    raw = (text or "").strip()
    if not raw:
        return None

    import re
    each_pattern = re.search(r"(\d+(?:\.\d+)?)\s+[a-zA-Z][a-zA-Z\s-]{0,30}?\s+(?:for|at)\s+(\d+(?:\.\d+)?)\s*(?:each|per\s+piece|per\s+item)?\b", raw, re.I)
    if each_pattern:
        quantity = float(each_pattern.group(1))
        unit_amount = float(each_pattern.group(2))
        if quantity > 0 and unit_amount > 0:
            return round(quantity * unit_amount, 2)

    multiply_pattern = re.search(r"(\d+(?:\.\d+)?)\s*(?:x|\*|×)\s*(\d+(?:\.\d+)?)", raw, re.I)
    if multiply_pattern:
        left = float(multiply_pattern.group(1))
        right = float(multiply_pattern.group(2))
        if left > 0 and right > 0:
            return round(left * right, 2)

    cue_pattern = re.search(r"(?:spent|for|cost|paid|amount|worth)\s*(?:rs\.?|inr|₹)?\s*(\d[\d,]*(?:\.\d+)?)", raw, re.I)
    if cue_pattern:
        amount = parse_loose_number(cue_pattern.group(1))
        if amount and amount > 0:
            return amount

    numbers = re.findall(r"\d[\d,]*(?:\.\d+)?", raw)
    parsed = [parse_loose_number(n) for n in numbers if parse_loose_number(n)]
    return max(parsed) if parsed else None

def extract_description_from_text(text: str):
    raw = (text or "").strip()
    if not raw:
        return None
    import re
    normalized = re.sub(r"\s+", " ", raw)

    patterns = [
        r"^(?:bought|brought|ordered|purchased|paid(?:\s+for)?|got)\s+(.+?)(?:\s+(?:for|at|with)\s+\d|\s+today\b|\s+yesterday\b|\s+this\s+morning\b|\s+this\s+evening\b|\s+tonight\b|\s+on\b|\.|,|$)",
        r"^(.+?)\s+(?:for|at|with)\s+\d[\d,]*(?:\.\d+)?(?:\s+each|\s+per\s+(?:item|piece))?(?:\s+today|\s+yesterday|\.|,|$)",
        r"^(?:spent|spend|spent on)\s+\d[\d,]*(?:\.\d+)?\s+on\s+(.+?)(?:\s+today\b|\s+yesterday\b|\.|,|$)",
        r"\bon\s+(.+?)(?:\s+today\b|\s+yesterday\b|\.|,|$)",
    ]

    for pattern in patterns:
        match = re.search(pattern, normalized, re.I)
        if match and match.group(1):
            candidate = match.group(1).strip()
            if candidate:
                return candidate

    fallback = re.sub(r"\b(today|yesterday|tonight|this morning|this evening)\b", "", normalized, flags=re.I)
    fallback = re.sub(r"\b(rs\.?|inr|₹)\b", "", fallback, flags=re.I)
    fallback = re.sub(r"\s+", " ", fallback).strip(" ,.-")
    return fallback or None

def parse_json_from_model_text(raw_text: str):
    if not raw_text:
        return None
    text = str(raw_text).strip()
    import re, json
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text, re.I)
    candidate = fenced.group(1).strip() if fenced else ""
    for c in (candidate, text):
        if not c:
            continue
        try:
            return json.loads(c)
        except json.JSONDecodeError:
            pass
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            return None
    return None

def suggest_category_from_keywords(description: str):
    text = (description or "").lower()
    if not text:
        return {"category": None, "source": "fallback"}

    travel_terms = ["uber", "ola", "taxi", "cab", "bus", "metro", "train", "flight", "petrol", "fuel", "diesel", "toll", "parking", "commute", "auto", "rickshaw"]
    food_terms = ["food", "lunch", "dinner", "breakfast", "snack", "coffee", "tea", "pizza", "burger", "restaurant", "zomato", "swiggy", "cafe", "grocery", "groceries"]
    shopping_terms = ["shirt", "jeans", "shoes", "amazon", "flipkart", "mall", "shop", "shopping", "clothes", "electronics", "headphones", "phone", "laptop", "watch"]

    def has_any(terms):
        return any(term in text for term in terms)

    if has_any(travel_terms):
        return {"category": "Travel/Commute", "source": "fallback"}
    if has_any(food_terms):
        return {"category": "Food/Beverage", "source": "fallback"}
    if has_any(shopping_terms):
        return {"category": "Shopping", "source": "fallback"}
    return {"category": None, "source": "fallback"}

# ----------------------------
# Rate limiting (in-memory)
# ----------------------------
auth_rate_map = {}
ai_rate_map = {}

def auth_rate_limit(request: Request):
    window_ms = 10 * 60 * 1000
    max_requests = 30
    now = int(datetime.utcnow().timestamp() * 1000)
    key = f"{request.client.host}:{request.url.path}"
    current = auth_rate_map.get(key)
    if not current or now - current["start"] > window_ms:
        auth_rate_map[key] = {"start": now, "count": 1}
        return
    current["count"] += 1
    if current["count"] > max_requests:
        raise HTTPException(status_code=429, detail="Too many auth attempts. Please try again later.")

def ai_rate_limit(request: Request, user: dict):
    window_ms = 60 * 1000
    max_requests = 25
    now = int(datetime.utcnow().timestamp() * 1000)
    key = f"{user.get('id', request.client.host)}:{request.url.path}"
    current = ai_rate_map.get(key)
    if not current or now - current["start"] > window_ms:
        ai_rate_map[key] = {"start": now, "count": 1}
        return
    current["count"] += 1
    if current["count"] > max_requests:
        raise HTTPException(status_code=429, detail="Too many AI requests. Please wait a moment.")

# ----------------------------
# Pydantic models
# ----------------------------
class AuthPayload(BaseModel):
    username: str = Field(..., min_length=3, max_length=30)
    password: str
    passwordConfirm: Optional[str] = None

class ExpensePayload(BaseModel):
    amount: float
    description: str
    category: str
    date: str

class AiSuggestPayload(BaseModel):
    description: str

class AiParsePayload(BaseModel):
    text: str

# ----------------------------
# FastAPI app + routes
# ----------------------------
app = FastAPI()

@app.on_event("startup")
async def startup():
    await initialize_database()
    await revoke_expired_refresh_tokens()

@app.post("/api/auth/register")
async def register(payload: AuthPayload, response: Response, request: Request):
    auth_rate_limit(request)
    username = payload.username.strip()
    password = payload.password or ""
    password_confirm = payload.passwordConfirm or ""

    input_error = validate_auth_input(username, password, password_confirm, True)
    if input_error:
        raise HTTPException(status_code=400, detail=input_error)

    existing = await get_one("SELECT id FROM users WHERE username = %s", (username,))
    if existing:
        raise HTTPException(status_code=409, detail="Username is already taken.")

    password_hash = pwd_context.hash(password)
    result = await run("INSERT INTO users (username, password_hash) VALUES (%s, %s) RETURNING id", (username, password_hash))
    access_token = await issue_session(result["id"], username, response)
    return {"user": {"id": result["id"], "username": username}, "accessToken": access_token}

@app.post("/api/auth/login")
async def login(payload: AuthPayload, response: Response, request: Request):
    auth_rate_limit(request)
    username = payload.username.strip()
    password = payload.password or ""

    input_error = validate_auth_input(username, password, "", False)
    if input_error:
        raise HTTPException(status_code=400, detail=input_error)

    row = await get_one("SELECT id, username, password_hash FROM users WHERE username = %s", (username,))
    if not row:
        raise HTTPException(status_code=401, detail="Enter valid username/password combination.")

    user_id, user_name, password_hash = row
    if not pwd_context.verify(password, password_hash):
        raise HTTPException(status_code=401, detail="Enter valid username/password combination.")

    access_token = await issue_session(user_id, user_name, response)
    return {"user": {"id": user_id, "username": user_name}, "accessToken": access_token}

@app.post("/api/auth/refresh")
async def refresh(response: Response, request: Request):
    auth_rate_limit(request)
    refresh_token = request.cookies.get(REFRESH_COOKIE_NAME)
    if not refresh_token:
        raise HTTPException(status_code=401, detail="Missing refresh token.")

    row = await get_one("""
        SELECT rt.id, rt.user_id, rt.token, rt.expires_at, u.username
        FROM refresh_tokens rt
        JOIN users u ON u.id = rt.user_id
        WHERE rt.token = %s
    """, (refresh_token,))
    if not row:
        clear_refresh_cookie(response)
        raise HTTPException(status_code=401, detail="Invalid refresh token.")

    _, user_id, _, expires_at, username = row
    try:
        expires_at_dt = datetime.fromisoformat(expires_at)
    except ValueError:
        await revoke_refresh_token(refresh_token)
        clear_refresh_cookie(response)
        raise HTTPException(status_code=401, detail="Refresh token expired.")

    if expires_at_dt <= datetime.utcnow():
        await revoke_refresh_token(refresh_token)
        clear_refresh_cookie(response)
        raise HTTPException(status_code=401, detail="Refresh token expired.")

    await revoke_refresh_token(refresh_token)
    access_token = await issue_session(user_id, username, response)
    return {"user": {"id": user_id, "username": username}, "accessToken": access_token}

@app.post("/api/auth/logout")
async def logout(response: Response, request: Request):
    refresh_token = request.cookies.get(REFRESH_COOKIE_NAME)
    try:
        await revoke_refresh_token(refresh_token)
    except Exception:
        pass
    clear_refresh_cookie(response)
    return {"success": True}

@app.get("/api/auth/me")
async def me(user=Depends(get_current_user)):
    row = await get_one("SELECT id, username FROM users WHERE id = %s", (user["id"],))
    if not row:
        raise HTTPException(status_code=404, detail="User not found.")
    return {"user": {"id": row[0], "username": row[1]}}

@app.post("/api/ai/suggest-category")
async def ai_suggest(payload: AiSuggestPayload, request: Request, user=Depends(get_current_user)):
    ai_rate_limit(request, user)
    description = payload.description.strip()
    if not description:
        raise HTTPException(status_code=400, detail="Description is required.")
    if len(description) > 240:
        raise HTTPException(status_code=400, detail="Description is too long.")

    if not GEMINI_API_KEY:
        return suggest_category_from_keywords(description)

    prompt = "\n".join([
        "Classify the expense description into one category.",
        f"Allowed categories: {', '.join(EXPENSE_CATEGORIES)}",
        "Return only JSON in this exact shape: {\"category\":\"<one allowed category or null>\"}.",
        f"Description: {description}",
    ])

    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}",
            headers={"Content-Type": "application/json"},
            json={
                "system_instruction": {"parts": [{"text": "You are a strict expense category classifier. Return JSON only."}]},
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
            },
        )

    if res.status_code != 200:
        return suggest_category_from_keywords(description)

    payload_json = res.json()
    content = payload_json.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text")
    parsed = parse_json_from_model_text(content)
    category = parse_model_category(parsed.get("category")) if parsed else None
    return {"category": category, "source": "gemini"} if category else suggest_category_from_keywords(description)

@app.post("/api/ai/parse-expense")
async def ai_parse(payload: AiParsePayload, request: Request, user=Depends(get_current_user)):
    ai_rate_limit(request, user)
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is required.")
    if len(text) > 500:
        raise HTTPException(status_code=400, detail="Text is too long.")

    if not GEMINI_API_KEY:
        raise HTTPException(status_code=400, detail="Gemini API key is missing.")

    today = datetime.utcnow().date().isoformat()
    prompt = "\n".join([
        "Extract expense details from this natural language input.",
        f"Allowed categories: {', '.join(EXPENSE_CATEGORIES)}",
        "Return only JSON in this exact shape:",
        "{\"amount\":<number or null>,\"category\":\"<one allowed category or null>\",\"date\":\"<YYYY-MM-DD or null>\",\"description\":\"<brief text or null>\"}",
        "Rules:",
        "- amount must be numeric only (no currency symbols)",
        f"- if date is missing, use {today}",
        "- category must be one of the allowed categories or null",
        "- description should be short and human-readable, and should briefly describe the expense",
        "",
        f"User input: {text}",
    ])

    async with httpx.AsyncClient() as client:
        res = await client.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}",
            headers={"Content-Type": "application/json"},
            json={
                "system_instruction": {"parts": [{"text": "You are a strict expense parser. Return JSON only."}]},
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
            },
        )

    if res.status_code != 200:
        detail = res.json().get("error", {}).get("message", "")
        suffix = f": {detail}" if detail else ""
        raise HTTPException(status_code=400, detail=f"Gemini request failed ({res.status_code}){suffix}")

    payload_json = res.json()
    content = payload_json.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text")
    parsed = parse_json_from_model_text(content)

    if not parsed:
        raise HTTPException(status_code=400, detail="Could not parse model response.")

    model_amount = parse_loose_number(parsed.get("amount"))
    fallback_amount = extract_amount_from_text(text)
    normalized_amount = model_amount if model_amount and model_amount > 0 else fallback_amount

    parsed_date = str(parsed.get("date") or "").strip()
    normalized_date = parsed_date if len(parsed_date) == 10 and parsed_date[4] == "-" else today

    normalized_description = str(parsed.get("description") or "").strip()
    fallback_description = extract_description_from_text(text)

    if not normalized_amount or normalized_amount <= 0:
        raise HTTPException(
            status_code=400,
            detail='Could not parse amount. Include a numeric amount like: "Spent 600 on groceries today".'
        )

    return {
        "amount": normalized_amount,
        "category": parse_model_category(parsed.get("category")),
        "date": normalized_date,
        "description": normalized_description or fallback_description or None,
    }

@app.get("/api/expenses")
async def list_expenses(user=Depends(get_current_user)):
    rows = await get_all("""
        SELECT id, amount, description, category, expense_date
        FROM expenses
        WHERE user_id = %s
        ORDER BY id DESC
    """, (user["id"],))
    return {"expenses": [normalize_expense(r) for r in rows]}

@app.post("/api/expenses")
async def create_expense(payload: ExpensePayload, user=Depends(get_current_user)):
    if payload.amount <= 0 or not payload.description or not payload.category or not payload.date:
        raise HTTPException(status_code=400, detail="Invalid expense payload.")

    result = await run("""
        INSERT INTO expenses (user_id, amount, description, category, expense_date)
        VALUES (%s, %s, %s, %s, %s)
        RETURNING id
    """, (user["id"], payload.amount, payload.description.strip(), payload.category.strip(), payload.date.strip()))

    row = await get_one("""
        SELECT id, amount, description, category, expense_date
        FROM expenses WHERE id = %s
    """, (result["id"],))
    return {"expense": normalize_expense(row)}

@app.put("/api/expenses/{expense_id}")
async def update_expense(expense_id: int, payload: ExpensePayload, user=Depends(get_current_user)):
    if payload.amount <= 0 or not payload.description or not payload.category or not payload.date:
        raise HTTPException(status_code=400, detail="Invalid expense payload.")

    result = await run("""
        UPDATE expenses
        SET amount = %s, description = %s, category = %s, expense_date = %s, updated_at = NOW()
        WHERE id = %s AND user_id = %s
    """, (payload.amount, payload.description.strip(), payload.category.strip(), payload.date.strip(), expense_id, user["id"]))

    if result["changes"] == 0:
        raise HTTPException(status_code=404, detail="Expense not found.")

    row = await get_one("""
        SELECT id, amount, description, category, expense_date
        FROM expenses
        WHERE id = %s AND user_id = %s
    """, (expense_id, user["id"]))
    return {"expense": normalize_expense(row)}

@app.delete("/api/expenses/{expense_id}")
async def delete_expense(expense_id: int, user=Depends(get_current_user)):
    result = await run("DELETE FROM expenses WHERE id = %s AND user_id = %s", (expense_id, user["id"]))
    if result["changes"] == 0:
        raise HTTPException(status_code=404, detail="Expense not found.")
    return {"success": True}

# ----------------------------
# Static file serving
# ----------------------------
@app.get("/")
async def serve_index():
    return FileResponse(BASE_DIR / "index.html")

app.mount("/", StaticFiles(directory=str(BASE_DIR), html=True), name="static")