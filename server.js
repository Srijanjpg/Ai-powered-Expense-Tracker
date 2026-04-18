require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_only_change_this_secret';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_DAYS = 7;
const REFRESH_COOKIE_NAME = 'refresh_token';
const EXPENSE_CATEGORIES = ['Food/Beverage', 'Travel/Commute', 'Shopping'];

const dbPath = path.join(__dirname, 'expense_tracker.db');
const db = new sqlite3.Database(dbPath);

app.use(express.json());
app.use(cookieParser());
app.use(express.static(__dirname));

function run(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function(err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(query, params = []) {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function initializeDatabase() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      expense_date TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
}

function generateAccessToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL_SECONDS }
  );
}

function setRefreshCookie(res, token) {
  const isProduction = process.env.NODE_ENV === 'production';

  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: '/'
  });
}

function clearRefreshCookie(res) {
  const isProduction = process.env.NODE_ENV === 'production';

  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/'
  });
}

async function createRefreshToken(userId) {
  const token = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  await run(
    'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
    [userId, token, expiresAt]
  );

  return token;
}

async function revokeRefreshToken(token) {
  if (!token) return;
  await run('DELETE FROM refresh_tokens WHERE token = ?', [token]);
}

async function revokeExpiredRefreshTokens() {
  await run('DELETE FROM refresh_tokens WHERE expires_at <= datetime("now")');
}

async function issueSession(user, res) {
  const accessToken = generateAccessToken(user);
  const refreshToken = await createRefreshToken(user.id);
  setRefreshCookie(res, refreshToken);
  return accessToken;
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!token) {
    return res.status(401).json({ error: 'Missing authentication token.' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

function isStrongPassword(password) {
  return (
    password.length >= 8 &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

function validateAuthInput(username, password, passwordConfirm, isRegister = false) {
  if (!username || !password) return 'Username and password are required.';
  if (username.length < 3 || username.length > 30) return 'Username must be 3-30 characters.';
  if (isRegister && !isStrongPassword(password)) {
    return 'Password must be 8+ chars with upper, lower, number, and symbol.';
  }
  if (isRegister && password !== passwordConfirm) return 'Passwords do not match.';
  return '';
}

function normalizeExpense(row) {
  return {
    id: row.id,
    amount: Number(row.amount),
    description: row.description,
    category: row.category,
    date: row.expense_date
  };
}

function suggestCategoryFromKeywords(description) {
  const text = String(description || '').toLowerCase();

  if (!text) {
    return { category: null, source: 'fallback' };
  }

  const travelTerms = [
    'uber', 'ola', 'taxi', 'cab', 'bus', 'metro', 'train', 'flight', 'petrol',
    'fuel', 'diesel', 'toll', 'parking', 'commute', 'auto', 'rickshaw'
  ];
  const foodTerms = [
    'food', 'lunch', 'dinner', 'breakfast', 'snack', 'coffee', 'tea', 'pizza',
    'burger', 'restaurant', 'zomato', 'swiggy', 'cafe', 'grocery', 'groceries'
  ];
  const shoppingTerms = [
    'shirt', 'jeans', 'shoes', 'amazon', 'flipkart', 'mall', 'shop', 'shopping',
    'clothes', 'electronics', 'headphones', 'phone', 'laptop', 'watch'
  ];

  const hasAny = (terms) => terms.some((term) => text.includes(term));

  if (hasAny(travelTerms)) {
    return { category: 'Travel/Commute', source: 'fallback' };
  }

  if (hasAny(foodTerms)) {
    return { category: 'Food/Beverage', source: 'fallback' };
  }

  if (hasAny(shoppingTerms)) {
    return { category: 'Shopping', source: 'fallback' };
  }

  return { category: null, source: 'fallback' };
}

function parseModelCategory(rawCategory) {
  if (!rawCategory) return null;

  const normalized = String(rawCategory).trim().toLowerCase();
  if (normalized === 'food/beverage' || normalized === 'food' || normalized === 'beverage') {
    return 'Food/Beverage';
  }
  if (normalized === 'travel/commute' || normalized === 'travel' || normalized === 'commute') {
    return 'Travel/Commute';
  }
  if (normalized === 'shopping') {
    return 'Shopping';
  }
  return null;
}

function parseLooseNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value
    .replace(/,/g, '')
    .replace(/(?:rs\.?|inr|₹)/gi, '')
    .trim();

  if (!normalized) {
    return null;
  }

  const amount = Number.parseFloat(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function extractAmountFromText(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;

  const eachPattern = /(\d+(?:\.\d+)?)\s+[a-zA-Z][a-zA-Z\s-]{0,30}?\s+(?:for|at)\s+(\d+(?:\.\d+)?)\s*(?:each|per\s+piece|per\s+item)?\b/i;
  const eachMatch = raw.match(eachPattern);
  if (eachMatch) {
    const quantity = Number.parseFloat(eachMatch[1]);
    const unitAmount = Number.parseFloat(eachMatch[2]);
    if (Number.isFinite(quantity) && quantity > 0 && Number.isFinite(unitAmount) && unitAmount > 0) {
      return Number((quantity * unitAmount).toFixed(2));
    }
  }

  const multiplyPattern = /(\d+(?:\.\d+)?)\s*(?:x|\*|×)\s*(\d+(?:\.\d+)?)/i;
  const multiplyMatch = raw.match(multiplyPattern);
  if (multiplyMatch) {
    const left = Number.parseFloat(multiplyMatch[1]);
    const right = Number.parseFloat(multiplyMatch[2]);
    if (Number.isFinite(left) && left > 0 && Number.isFinite(right) && right > 0) {
      return Number((left * right).toFixed(2));
    }
  }

  const cuePattern = /(?:spent|for|cost|paid|amount|worth)\s*(?:rs\.?|inr|₹)?\s*(\d[\d,]*(?:\.\d+)?)/i;
  const cueMatch = raw.match(cuePattern);
  if (cueMatch) {
    const amount = parseLooseNumber(cueMatch[1]);
    if (amount && amount > 0) {
      return amount;
    }
  }

  const numbers = raw.match(/\d[\d,]*(?:\.\d+)?/g) || [];
  const parsedNumbers = numbers
    .map(parseLooseNumber)
    .filter((n) => Number.isFinite(n) && n > 0);

  if (!parsedNumbers.length) {
    return null;
  }

  return Math.max(...parsedNumbers);
}

function extractDescriptionFromText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const normalized = raw.replace(/\s+/g, ' ');

  const actionPatterns = [
    /^(?:bought|brought|ordered|purchased|paid(?:\s+for)?|got)\s+(.+?)(?:\s+(?:for|at|with)\s+\d|\s+today\b|\s+yesterday\b|\s+this\s+morning\b|\s+this\s+evening\b|\s+tonight\b|\s+on\b|\.|,|$)/i,
    /^(.+?)\s+(?:for|at|with)\s+\d[\d,]*(?:\.\d+)?(?:\s+each|\s+per\s+(?:item|piece))?(?:\s+today|\s+yesterday|\.|,|$)/i,
    /^(?:spent|spend|spent on)\s+\d[\d,]*(?:\.\d+)?\s+on\s+(.+?)(?:\s+today\b|\s+yesterday\b|\.|,|$)/i,
    /\bon\s+(.+?)(?:\s+today\b|\s+yesterday\b|\.|,|$)/i
  ];

  for (const pattern of actionPatterns) {
    const match = normalized.match(pattern);
    if (match && match[1]) {
      const candidate = match[1].trim();
      if (candidate) return candidate;
    }
  }

  const fallback = normalized
    .replace(/\b(today|yesterday|tonight|this morning|this evening)\b/ig, '')
    .replace(/\b(rs\.?|inr|₹)\b/ig, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s,.-]+$/g, '')
    .trim();

  return fallback || null;
}

function parseJsonFromModelText(rawText) {
  if (!rawText) return null;

  const text = String(rawText).trim();

  // Prefer fenced JSON if model wraps output in markdown.
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const fencedCandidate = fencedMatch ? fencedMatch[1].trim() : '';

  const tryParse = (candidate) => {
    if (!candidate) return null;
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  };

  let parsed = tryParse(fencedCandidate) || tryParse(text);
  if (parsed) return parsed;

  // Last fallback: parse substring between first "{" and last "}".
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const jsonSlice = text.slice(firstBrace, lastBrace + 1);
    return tryParse(jsonSlice);
  }

  return null;
}

async function suggestCategoryWithGemini(description) {
  if (!GEMINI_API_KEY) return null;

  const prompt = [
    'Classify the expense description into one category.',
    `Allowed categories: ${EXPENSE_CATEGORIES.join(', ')}`,
    'Return only JSON in this exact shape: {"category":"<one allowed category or null>"}.',
    `Description: ${description}`
  ].join('\n');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [
            {
              text: 'You are a strict expense category classifier. Return JSON only.'
            }
          ]
        },
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json'
        }
      })
    }
  );

  if (!response.ok) {
    let errorMessage = '';
    try {
      const errorPayload = await response.json();
      errorMessage = errorPayload?.error?.message || '';
    } catch {
      errorMessage = '';
    }
    const detail = errorMessage ? `: ${errorMessage}` : '';
    throw new Error(`Gemini request failed (${response.status})${detail}`);
  }

  const payload = await response.json();
  const content = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) return null;

  const parsed = parseJsonFromModelText(content);
  if (!parsed) return null;

  return parseModelCategory(parsed.category);
}

async function parseExpenseFromNaturalLanguage(text) {
  if (!GEMINI_API_KEY) return null;

  const today = new Date().toISOString().split('T')[0];
  const prompt = [
    'Extract expense details from this natural language input.',
    `Allowed categories: ${EXPENSE_CATEGORIES.join(', ')}`,
    'Return only JSON in this exact shape:',
    '{"amount":<number or null>,"category":"<one allowed category or null>","date":"<YYYY-MM-DD or null>","description":"<brief text or null>"}',
    'Rules:',
    '- amount must be numeric only (no currency symbols)',
    `- if date is missing, use ${today}`,
    '- category must be one of the allowed categories or null',
    '- description should be short and human-readable, and should breifly very briefly describe the expense, not repeat the whole sentence',
    '',
    `User input: ${text}`
  ].join('\n');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [
            {
              text: 'You are a strict expense parser. Return JSON only.'
            }
          ]
        },
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json'
        }
      })
    }
  );

  if (!response.ok) {
    let errorMessage = '';
    try {
      const errorPayload = await response.json();
      errorMessage = errorPayload?.error?.message || '';
    } catch {
      errorMessage = '';
    }
    const detail = errorMessage ? `: ${errorMessage}` : '';
    throw new Error(`Gemini request failed (${response.status})${detail}`);
  }

  const payload = await response.json();
  const content = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) return null;

  const parsed = parseJsonFromModelText(content);
  if (!parsed) return null;

  const modelAmount = parseLooseNumber(parsed.amount);
  const fallbackAmount = extractAmountFromText(text);
  const normalizedAmount = Number.isFinite(modelAmount) && modelAmount > 0 ? modelAmount : fallbackAmount;

  const parsedDate = String(parsed.date || '').trim();
  const normalizedDate = /^\d{4}-\d{2}-\d{2}$/.test(parsedDate) ? parsedDate : today;

  const normalizedDescription = String(parsed.description || '').trim();
  const fallbackDescription = extractDescriptionFromText(text);

  return {
    amount: normalizedAmount,
    category: parseModelCategory(parsed.category),
    date: normalizedDate,
    description: normalizedDescription || fallbackDescription || null
  };
}

/* Basic in-memory rate limit for auth routes */
const authRateMap = new Map();
function authRateLimit(req, res, next) {
  const windowMs = 10 * 60 * 1000;
  const maxRequests = 30;
  const now = Date.now();
  const key = `${req.ip}:${req.path}`;
  const current = authRateMap.get(key);

  if (!current || now - current.start > windowMs) {
    authRateMap.set(key, { start: now, count: 1 });
    return next();
  }

  current.count += 1;
  if (current.count > maxRequests) {
    return res.status(429).json({ error: 'Too many auth attempts. Please try again later.' });
  }

  return next();
}

const aiRateMap = new Map();
function aiRateLimit(req, res, next) {
  const windowMs = 60 * 1000;
  const maxRequests = 25;
  const now = Date.now();
  const key = `${req.user?.id || req.ip}:${req.path}`;
  const current = aiRateMap.get(key);

  if (!current || now - current.start > windowMs) {
    aiRateMap.set(key, { start: now, count: 1 });
    return next();
  }

  current.count += 1;
  if (current.count > maxRequests) {
    return res.status(429).json({ error: 'Too many AI requests. Please wait a moment.' });
  }

  return next();
}

app.post('/api/auth/register', authRateLimit, async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const passwordConfirm = req.body.passwordConfirm || '';

  const inputError = validateAuthInput(username, password, passwordConfirm, true);
  if (inputError) return res.status(400).json({ error: inputError });

  try {
    const existing = await get('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) {
      return res.status(409).json({ error: 'Username is already taken.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await run(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      [username, passwordHash]
    );

    const user = { id: result.id, username };
    const accessToken = await issueSession(user, res);

    res.status(201).json({ user, accessToken });
  } catch {
    res.status(500).json({ error: 'Failed to create account.' });
  }
});

app.post('/api/auth/login', authRateLimit, async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';

  const inputError = validateAuthInput(username, password, '', false);
  if (inputError) return res.status(400).json({ error: inputError });

  try {
    const userRow = await get(
      'SELECT id, username, password_hash FROM users WHERE username = ?',
      [username]
    );

    if (!userRow) {
      return res.status(401).json({ error: 'Enter valid username/password combination.' });
    }

    const isMatch = await bcrypt.compare(password, userRow.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Enter valid username/password combination.' });
    }

    const user = { id: userRow.id, username: userRow.username };
    const accessToken = await issueSession(user, res);

    res.json({ user, accessToken });
  } catch {
    res.status(500).json({ error: 'Failed to sign in.' });
  }
});

app.post('/api/auth/refresh', authRateLimit, async (req, res) => {
  const refreshToken = req.cookies[REFRESH_COOKIE_NAME];
  if (!refreshToken) {
    return res.status(401).json({ error: 'Missing refresh token.' });
  }

  try {
    const tokenRow = await get(
      `SELECT rt.id, rt.user_id, rt.token, rt.expires_at, u.username
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token = ?`,
      [refreshToken]
    );

    if (!tokenRow) {
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Invalid refresh token.' });
    }

    const expiresAtMs = new Date(tokenRow.expires_at).getTime();
    if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
      await revokeRefreshToken(refreshToken);
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Refresh token expired.' });
    }

    await revokeRefreshToken(refreshToken);

    const user = { id: tokenRow.user_id, username: tokenRow.username };
    const accessToken = await issueSession(user, res);

    res.json({ user, accessToken });
  } catch {
    res.status(500).json({ error: 'Failed to refresh session.' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const refreshToken = req.cookies[REFRESH_COOKIE_NAME];
  try {
    await revokeRefreshToken(refreshToken);
  } catch {
    // Ignore DB errors on logout.
  }

  clearRefreshCookie(res);
  res.json({ success: true });
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await get('SELECT id, username FROM users WHERE id = ?', [req.user.id]);

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json({ user });
  } catch {
    res.status(500).json({ error: 'Failed to fetch user profile.' });
  }
});

app.post('/api/ai/suggest-category', authMiddleware, aiRateLimit, async (req, res) => {
  const description = (req.body.description || '').trim();

  if (!description) {
    return res.status(400).json({ error: 'Description is required.' });
  }

  if (description.length > 240) {
    return res.status(400).json({ error: 'Description is too long.' });
  }

  try {
    const aiCategory = await suggestCategoryWithGemini(description);
    if (aiCategory) {
      return res.json({ category: aiCategory, source: 'gemini' });
    }

    const fallback = suggestCategoryFromKeywords(description);
    return res.json(fallback);
  } catch {
    const fallback = suggestCategoryFromKeywords(description);
    return res.json(fallback);
  }
});

app.post('/api/ai/parse-expense', authMiddleware, aiRateLimit, async (req, res) => {
  const text = (req.body.text || '').trim();

  if (!text) {
    return res.status(400).json({ error: 'Text is required.' });
  }

  if (text.length > 500) {
    return res.status(400).json({ error: 'Text is too long.' });
  }

  try {
    const parsed = await parseExpenseFromNaturalLanguage(text);

    if (!parsed || !Number.isFinite(parsed.amount) || parsed.amount <= 0) {
      return res.status(400).json({
        error: 'Could not parse amount. Include a numeric amount like: "Spent 600 on groceries today".'
      });
    }

    return res.json(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown parsing error.';
    return res.status(400).json({
      error: message
    });
  }
});

app.get('/api/expenses', authMiddleware, async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, amount, description, category, expense_date
       FROM expenses
       WHERE user_id = ?
       ORDER BY id DESC`,
      [req.user.id]
    );

    res.json({ expenses: rows.map(normalizeExpense) });
  } catch {
    res.status(500).json({ error: 'Failed to fetch expenses.' });
  }
});

app.post('/api/expenses', authMiddleware, async (req, res) => {
  const amount = Number(req.body.amount);
  const description = (req.body.description || '').trim();
  const category = (req.body.category || '').trim();
  const date = (req.body.date || '').trim();

  if (!Number.isFinite(amount) || amount <= 0 || !description || !category || !date) {
    return res.status(400).json({ error: 'Invalid expense payload.' });
  }

  try {
    const result = await run(
      `INSERT INTO expenses (user_id, amount, description, category, expense_date)
       VALUES (?, ?, ?, ?, ?)`,
      [req.user.id, amount, description, category, date]
    );

    const row = await get(
      'SELECT id, amount, description, category, expense_date FROM expenses WHERE id = ?',
      [result.id]
    );

    res.status(201).json({ expense: normalizeExpense(row) });
  } catch {
    res.status(500).json({ error: 'Failed to create expense.' });
  }
});

app.put('/api/expenses/:id', authMiddleware, async (req, res) => {
  const expenseId = Number.parseInt(req.params.id, 10);
  const amount = Number(req.body.amount);
  const description = (req.body.description || '').trim();
  const category = (req.body.category || '').trim();
  const date = (req.body.date || '').trim();

  if (Number.isNaN(expenseId)) {
    return res.status(400).json({ error: 'Invalid expense id.' });
  }

  if (!Number.isFinite(amount) || amount <= 0 || !description || !category || !date) {
    return res.status(400).json({ error: 'Invalid expense payload.' });
  }

  try {
    const result = await run(
      `UPDATE expenses
       SET amount = ?, description = ?, category = ?, expense_date = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [amount, description, category, date, expenseId, req.user.id]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Expense not found.' });
    }

    const row = await get(
      'SELECT id, amount, description, category, expense_date FROM expenses WHERE id = ? AND user_id = ?',
      [expenseId, req.user.id]
    );

    res.json({ expense: normalizeExpense(row) });
  } catch {
    res.status(500).json({ error: 'Failed to update expense.' });
  }
});

app.delete('/api/expenses/:id', authMiddleware, async (req, res) => {
  const expenseId = Number.parseInt(req.params.id, 10);

  if (Number.isNaN(expenseId)) {
    return res.status(400).json({ error: 'Invalid expense id.' });
  }

  try {
    const result = await run(
      'DELETE FROM expenses WHERE id = ? AND user_id = ?',
      [expenseId, req.user.id]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Expense not found.' });
    }

    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to delete expense.' });
  }
});

app.get('*', (req, res) => {
  const filePath = path.join(__dirname, 'index.html');
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('index.html not found');
  }
  res.sendFile(filePath);
});

initializeDatabase()
  .then(async () => {
    await revokeExpiredRefreshTokens();

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Database initialization failed:', error);
    process.exit(1);
  });
