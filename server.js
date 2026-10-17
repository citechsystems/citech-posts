const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3010;
const SQLITE_FILE = process.env.SQLITE_FILE || path.join(__dirname, 'data', 'posts.sqlite');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const SESSION_DAYS = 30;

fs.mkdirSync(path.dirname(SQLITE_FILE), { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new Database(SQLITE_FILE);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template TEXT NOT NULL,
    product_name TEXT,
    filename TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
`);

// Seed an initial admin user on first boot so there's always a way in.
const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (userCount === 0) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
  console.log('========================================');
  console.log('Usuário inicial criado:');
  console.log('  usuário:', username);
  if (!process.env.ADMIN_PASSWORD) {
    console.log('  senha:', password, '(gerada automaticamente — troque depois criando outro usuário)');
  } else {
    console.log('  senha: a definida em ADMIN_PASSWORD');
  }
  console.log('========================================');
}

const VALID_TEMPLATES = new Set(['novidade', 'promocao', 'produtos']);

// ---- cookies (minimal, no extra dependency) ----
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}
function setSessionCookie(res, token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const parts = [
    `session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Max-Age=0');
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return token;
}
function getUserFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies.session;
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return db.prepare('SELECT id, username FROM users WHERE id = ?').get(session.user_id);
}

const PUBLIC_PAGES = new Set(['/login.html']);
const PUBLIC_API_PREFIXES = ['/api/login', '/api/health'];

function requireAuthPage(req, res, next) {
  if (PUBLIC_PAGES.has(req.path)) return next();
  const user = getUserFromRequest(req);
  if (!user) return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl));
  req.user = user;
  next();
}
function requireAuthApi(req, res, next) {
  if (PUBLIC_API_PREFIXES.some(p => req.path.startsWith(p))) return next();
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'não autenticado' });
  req.user = user;
  next();
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const id = crypto.randomBytes(8).toString('hex');
    cb(null, `${Date.now()}-${id}.jpg`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype === 'image/jpeg' || file.mimetype === 'image/png');
  },
});

const app = express();
app.use(express.json());

// --- auth endpoints (public) ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'usuário e senha obrigatórios' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'usuário ou senha inválidos' });
  }
  const token = createSession(user.id);
  setSessionCookie(res, token);
  res.json({ ok: true, username: user.username });
});

app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.session) db.prepare('DELETE FROM sessions WHERE token = ?').run(cookies.session);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'não autenticado' });
  res.json({ username: user.username });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// --- protect everything below this line ---
// '/api' is locked down first so an expired/missing session on an API call
// always gets a clean 401 JSON, never the HTML redirect meant for pages.
app.use('/uploads', requireAuthApi, express.static(UPLOADS_DIR, { maxAge: '30d' }));
app.use('/api', requireAuthApi);
app.use(requireAuthPage, express.static(path.join(__dirname, 'public')));

app.post('/api/posts', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'imagem ausente ou inválida' });
  const template = VALID_TEMPLATES.has(req.body.template) ? req.body.template : 'novidade';
  const productName = typeof req.body.product_name === 'string' ? req.body.product_name.slice(0, 200) : null;

  const stmt = db.prepare(
    'INSERT INTO posts (template, product_name, filename) VALUES (?, ?, ?)'
  );
  const info = stmt.run(template, productName, req.file.filename);

  res.status(201).json({
    id: info.lastInsertRowid,
    template,
    product_name: productName,
    filename: req.file.filename,
    url: `/uploads/${req.file.filename}`,
  });
});

app.get('/api/posts', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  const cursor = parseInt(req.query.cursor, 10) || 0;
  const template = VALID_TEMPLATES.has(req.query.template) ? req.query.template : null;

  let rows;
  if (template) {
    rows = db
      .prepare('SELECT * FROM posts WHERE template = ? AND id < COALESCE(NULLIF(?,0), 999999999) ORDER BY id DESC LIMIT ?')
      .all(template, cursor, limit + 1);
  } else {
    rows = db
      .prepare('SELECT * FROM posts WHERE id < COALESCE(NULLIF(?,0), 999999999) ORDER BY id DESC LIMIT ?')
      .all(cursor, limit + 1);
  }

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(r => ({ ...r, url: `/uploads/${r.filename}` }));
  res.json({
    items: page,
    next_cursor: hasMore ? page[page.length - 1].id : null,
  });
});

app.delete('/api/posts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'não encontrado' });
  db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
  fs.unlink(path.join(UPLOADS_DIR, row.filename), () => {});
  res.json({ ok: true });
});

// --- user management (any logged-in user can add/remove teammates) ---
app.get('/api/users', (req, res) => {
  const users = db.prepare('SELECT id, username, created_at FROM users ORDER BY id').all();
  res.json({ items: users });
});

app.post('/api/users', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 4) {
    return res.status(400).json({ error: 'usuário e senha (mín. 4 caracteres) obrigatórios' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'usuário já existe' });
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
  res.status(201).json({ id: info.lastInsertRowid, username });
});

app.delete('/api/users/:id', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (total <= 1) return res.status(400).json({ error: 'não é possível remover o último usuário' });
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'não é possível remover o próprio usuário logado' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`citech-posts rodando na porta ${PORT}`);
});
