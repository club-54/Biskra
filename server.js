import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5000;

const MENU_FILE         = path.join(__dirname, 'data', 'menu.json');
const OVERRIDES_FILE    = path.join(__dirname, 'data', 'menu-overrides.json');
const PROMOS_FILE       = path.join(__dirname, 'data', 'promo-codes.json');
const SUPPLEMENTS_FILE  = path.join(__dirname, 'data', 'supplements.json');
const JSONBIN_KEY    = process.env.JSONBIN_MASTER_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const ADMIN_PASSWORD        = process.env.ADMIN_PASSWORD;
const ADMIN_PASSWORD_BACKUP = process.env.ADMIN_PASSWORD_BACKUP;

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'club54-fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));

// ---------- admin auth ----------
function requireAdmin(req, res, next) {
  if (req.session.adminAuth) return next();
  res.redirect('/admin/login');
}

app.get('/admin/login', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin', 'login.html'))
);

app.post('/admin/login', async (req, res) => {
  const pw = (req.body.password || '');
  const primaryOk  = ADMIN_PASSWORD && pw === ADMIN_PASSWORD;
  const backupOk   = !primaryOk && ADMIN_PASSWORD_BACKUP
                     && await bcrypt.compare(pw, ADMIN_PASSWORD_BACKUP);
  if (primaryOk || backupOk) {
    req.session.adminAuth = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// Protect all /admin routes (except login)
app.use('/admin', (req, res, next) => {
  if (req.path === '/login') return next();
  requireAdmin(req, res, next);
});

// ---------- local helpers ----------
function readMenu() {
  return JSON.parse(fs.readFileSync(MENU_FILE, 'utf8'));
}
function readOverridesLocal() {
  if (!fs.existsSync(OVERRIDES_FILE))
    return { items: {}, newItems: [], deletedIds: [], customCategories: [] };
  const raw = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
  return { items: {}, newItems: [], deletedIds: [], customCategories: [], ...raw };
}
function writeOverridesLocal(data) {
  fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(data, null, 2));
}

// ---------- JSONBin helpers ----------
let cache = null; // in-memory overrides cache

async function getOverrides() {
  if (cache) return cache;
  if (JSONBIN_KEY && JSONBIN_BIN_ID) {
    try {
      const res = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
        headers: { 'X-Master-Key': JSONBIN_KEY }
      });
      const json = await res.json();
      cache = { items: {}, newItems: [], deletedIds: [], customCategories: [], ...json.record };
      return cache;
    } catch (e) {
      console.error('[JSONBin] fetch error:', e.message);
    }
  }
  cache = readOverridesLocal();
  return cache;
}

async function saveOverrides(data) {
  cache = data;
  writeOverridesLocal(data); // local backup always
  if (JSONBIN_KEY && JSONBIN_BIN_ID) {
    try {
      await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY },
        body: JSON.stringify(data)
      });
    } catch (e) {
      console.error('[JSONBin] save error:', e.message);
    }
  }
}

// ---------- API ----------

// GET full merged menu
app.get('/api/menu', async (req, res) => {
  try {
    const base = readMenu();
    const ov   = await getOverrides();
    const merged = base.items
      .filter(i => !ov.deletedIds?.includes(i.id))
      .map(i => ({ ...i, ...(ov.items?.[i.id] || {}) }));
    res.json({
      categories: [...base.categories, ...(ov.customCategories || [])],
      items: [...merged, ...(ov.newItems || [])]
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET base menu (no overrides)
app.get('/api/menu/base', (req, res) => res.json(readMenu()));

// POST full overrides replace
app.post('/api/menu/overrides', async (req, res) => {
  try { await saveOverrides(req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH single item
app.patch('/api/menu/item/:id', async (req, res) => {
  try {
    const ov = await getOverrides();
    if (!ov.items) ov.items = {};
    ov.items[req.params.id] = { ...(ov.items[req.params.id] || {}), ...req.body };
    await saveOverrides(ov);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST add item
app.post('/api/menu/item', async (req, res) => {
  try {
    const ov = await getOverrides();
    if (!ov.newItems) ov.newItems = [];
    const item = { ...req.body, id: req.body.id || `custom-${Date.now()}` };
    ov.newItems.push(item);
    await saveOverrides(ov);
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE item
app.delete('/api/menu/item/:id', async (req, res) => {
  try {
    const ov = await getOverrides();
    const id = req.params.id;
    if (ov.newItems) ov.newItems = ov.newItems.filter(i => i.id !== id);
    const base = readMenu();
    if (base.items.find(i => i.id === id)) {
      if (!ov.deletedIds) ov.deletedIds = [];
      if (!ov.deletedIds.includes(id)) ov.deletedIds.push(id);
    }
    await saveOverrides(ov);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST add category
app.post('/api/categories', async (req, res) => {
  try {
    const ov = await getOverrides();
    if (!ov.customCategories) ov.customCategories = [];
    const slug = req.body.label.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const cat  = { id: `cat-${slug}-${Date.now()}`, label: req.body.label, labelAr: req.body.labelAr || '' };
    ov.customCategories.push(cat);
    await saveOverrides(ov);
    res.json({ ok: true, cat });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE category
app.delete('/api/categories/:id', async (req, res) => {
  try {
    const ov = await getOverrides();
    ov.customCategories = (ov.customCategories || []).filter(c => c.id !== req.params.id);
    if (ov.newItems) ov.newItems = ov.newItems.filter(i => i.cat !== req.params.id);
    await saveOverrides(ov);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Supplements ----------
function readSupplements() {
  if (!fs.existsSync(SUPPLEMENTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(SUPPLEMENTS_FILE, 'utf8'));
}
function writeSupplements(data) {
  fs.writeFileSync(SUPPLEMENTS_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/supplements', (req, res) => {
  try { res.json(readSupplements()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/supplements', (req, res) => {
  try {
    const sups = readSupplements();
    const item = { ...req.body, id: req.body.id || `sup-${Date.now()}` };
    sups.push(item);
    writeSupplements(sups);
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/supplements/:id', (req, res) => {
  try {
    const sups = readSupplements();
    const idx = sups.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    sups[idx] = { ...sups[idx], ...req.body };
    writeSupplements(sups);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/supplements/:id', (req, res) => {
  try {
    let sups = readSupplements();
    sups = sups.filter(s => s.id !== req.params.id);
    writeSupplements(sups);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Promo Codes ----------

function generatePromos(count = 15) {
  const codes = [];
  const seen  = new Set();
  while (codes.length < count) {
    const code = 'CLUB54-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push({
      code,
      discount: Math.floor(Math.random() * 16) + 10, // 10–25 %
      used: false,
      usedAt: null,
      createdAt: new Date().toISOString()
    });
  }
  return codes;
}

function readPromos() {
  if (!fs.existsSync(PROMOS_FILE)) return [];
  return JSON.parse(fs.readFileSync(PROMOS_FILE, 'utf8'));
}
function writePromos(data) {
  fs.writeFileSync(PROMOS_FILE, JSON.stringify(data, null, 2));
}

/** If every code has been used, silently replace the list with 15 fresh ones. */
function autoRenewIfExhausted(promos) {
  if (promos.length > 0 && promos.every(p => p.used)) {
    const fresh = generatePromos(15);
    writePromos(fresh);
    console.log('[Promos] All codes used — generated 15 new codes automatically.');
    return fresh;
  }
  return promos;
}

// GET all promo codes (admin view)
app.get('/api/promos', (req, res) => {
  try {
    const promos = autoRenewIfExhausted(readPromos());
    res.json(promos);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST validate a promo code (check without consuming)
app.post('/api/promos/validate', (req, res) => {
  try {
    const { code } = req.body;
    const promos = readPromos();
    const promo = promos.find(p => p.code === (code || '').trim().toUpperCase());
    if (!promo)      return res.status(404).json({ valid: false, error: 'الكود غير موجود' });
    if (promo.used)  return res.status(410).json({ valid: false, error: 'الكود مستخدم مسبقاً' });
    res.json({ valid: true, discount: promo.discount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST redeem a promo code (consume it — one-time use)
app.post('/api/promos/redeem', (req, res) => {
  try {
    const { code } = req.body;
    let promos = readPromos();
    const idx = promos.findIndex(p => p.code === (code || '').trim().toUpperCase());
    if (idx === -1)         return res.status(404).json({ ok: false, error: 'الكود غير موجود' });
    if (promos[idx].used)  return res.status(410).json({ ok: false, error: 'الكود مستخدم مسبقاً' });
    promos[idx].used   = true;
    promos[idx].usedAt = new Date().toISOString();
    writePromos(promos);
    // After saving, check if all are now exhausted and pre-generate for next batch
    autoRenewIfExhausted(promos);
    res.json({ ok: true, discount: promos[idx].discount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- static ----------
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',          // cache images/assets for 7 days
  etag: true,
  lastModified: true,
}));
app.get('/{*path}', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, '0.0.0.0', () => console.log(`Club 54 Food running on port ${PORT}`));
