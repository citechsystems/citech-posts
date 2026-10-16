const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3010;
const SQLITE_FILE = process.env.SQLITE_FILE || path.join(__dirname, 'data', 'posts.sqlite');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');

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
  )
`);

const VALID_TEMPLATES = new Set(['novidade', 'promocao', 'produtos']);

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
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public')));

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

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`citech-posts rodando na porta ${PORT}`);
});
