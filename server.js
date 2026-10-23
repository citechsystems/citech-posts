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
  CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    layout_json TEXT NOT NULL,
    thumbnail_filename TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

// Seed the 3 original presets as starter templates for the free-form editor.
const templateCount = db.prepare('SELECT COUNT(*) AS n FROM templates').get().n;
if (templateCount === 0) {
  let uid = 0;
  const nextId = () => `l${++uid}`;
  const textLayer = (text, y, size, mode) => ({
    id: nextId(), type: 'text', x: 132, y, width: 820, height: size * 1.3, rotation: 0,
    text, fontKey: 'orbitron', weight: 800, size, align: 'left',
    mode, color: '#ffffff', strokeColor: 'rgb(36,163,228)',
  });
  const photoLayer = () => ({
    id: nextId(), type: 'image', x: 139, y: 428, width: 802, height: 1094, rotation: 0,
    role: 'product_photo', cornerRadius: 28,
  });
  const logoLayer = () => ({
    id: nextId(), type: 'image', x: 90, y: 1561, width: 900, height: 203, rotation: 0,
    role: 'fixed_asset', src: '/logo-citech.png', cornerRadius: 0,
  });
  const factoryTemplate = (name, line1, line2) => ({
    name,
    background: { type: 'image', src: '/bg-clean.jpg' },
    layers: [
      textLayer(line1, 165, 95, 'solid'),
      textLayer(line2, 270, 118, 'outline'),
      photoLayer(),
      logoLayer(),
    ],
  });

  const factoryTemplates = [
    factoryTemplate('Chegou Novidade', 'CHEGOU', 'NOVIDADE'),
    factoryTemplate('Tem Promoção', 'TEM', 'PROMOÇÃO'),
    factoryTemplate('Nossos Produtos', 'NOSSOS', 'PRODUTOS'),
  ];
  const insertTpl = db.prepare('INSERT INTO templates (name, layout_json) VALUES (?, ?)');
  factoryTemplates.forEach(t => insertTpl.run(t.name, JSON.stringify(t)));
  console.log(`${factoryTemplates.length} templates de fábrica criados.`);
}

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

const PUBLIC_PAGES = new Set([
  '/login.html',
  '/manifest.json',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/logo-citech.png',
]);
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
  const template = typeof req.body.template === 'string' && req.body.template.trim()
    ? req.body.template.trim().slice(0, 80)
    : 'Personalizado';
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
  const template = typeof req.query.template === 'string' && req.query.template.trim() ? req.query.template.trim() : null;

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

app.get('/api/post-template-names', (req, res) => {
  const rows = db.prepare('SELECT DISTINCT template FROM posts ORDER BY template').all();
  res.json({ items: rows.map(r => r.template) });
});

app.delete('/api/posts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'não encontrado' });
  db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
  fs.unlink(path.join(UPLOADS_DIR, row.filename), () => {});
  res.json({ ok: true });
});

// --- templates (saved editor layouts) ---
app.get('/api/templates', (req, res) => {
  const rows = db.prepare('SELECT id, name, thumbnail_filename, created_at, updated_at FROM templates ORDER BY id DESC').all();
  res.json({
    items: rows.map(r => ({
      id: r.id,
      name: r.name,
      thumbnail_url: r.thumbnail_filename ? `/uploads/${r.thumbnail_filename}` : null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
  });
});

app.get('/api/templates/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'não encontrado' });
  res.json({
    id: row.id,
    name: row.name,
    layout: JSON.parse(row.layout_json),
    thumbnail_url: row.thumbnail_filename ? `/uploads/${row.thumbnail_filename}` : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
});

app.post('/api/templates', upload.single('thumbnail'), (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
  if (!name) return res.status(400).json({ error: 'nome do template obrigatório' });
  let layout;
  try {
    layout = JSON.parse(req.body.layout_json);
  } catch {
    return res.status(400).json({ error: 'layout_json inválido' });
  }
  const thumbFilename = req.file ? req.file.filename : null;
  const info = db
    .prepare('INSERT INTO templates (name, layout_json, thumbnail_filename) VALUES (?, ?, ?)')
    .run(name, JSON.stringify(layout), thumbFilename);
  res.status(201).json({ id: info.lastInsertRowid, name });
});

app.put('/api/templates/:id', upload.single('thumbnail'), (req, res) => {
  const existing = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'não encontrado' });
  const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 120) : existing.name;
  let layout;
  try {
    layout = req.body.layout_json ? JSON.parse(req.body.layout_json) : JSON.parse(existing.layout_json);
  } catch {
    return res.status(400).json({ error: 'layout_json inválido' });
  }
  let thumbFilename = existing.thumbnail_filename;
  if (req.file) {
    if (existing.thumbnail_filename) fs.unlink(path.join(UPLOADS_DIR, existing.thumbnail_filename), () => {});
    thumbFilename = req.file.filename;
  }
  db.prepare("UPDATE templates SET name = ?, layout_json = ?, thumbnail_filename = ?, updated_at = datetime('now') WHERE id = ?")
    .run(name, JSON.stringify(layout), thumbFilename, req.params.id);
  res.json({ id: Number(req.params.id), name });
});

app.delete('/api/templates/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'não encontrado' });
  db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  if (row.thumbnail_filename) fs.unlink(path.join(UPLOADS_DIR, row.thumbnail_filename), () => {});
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
