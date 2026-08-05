'use strict';

require('dotenv').config();

const http         = require('http');
const crypto       = require('crypto');
const path         = require('path');
const { execFile } = require('child_process');
const WebSocket    = require('ws');
const express      = require('express');
const cors         = require('cors');
const bcrypt       = require('bcrypt');
const jwt          = require('jsonwebtoken');
const db           = require('./db/db_index');
const handlers     = require('./handlers/handlers_index');
const { upload, uploadToCloud, UPLOAD_DIR } = require('./upload');
const { socketMap, addSocket, removeSocket, countSockets, socketSend } = require('./middleware/socketMap');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const JWT_SECRET  = process.env.JWT_SECRET;
const MASTER_KEY  = process.env.MASTER_KEY;
const SALT_ROUNDS = 10;

if (!JWT_SECRET || !MASTER_KEY) {
  console.error('[BOOT] JWT_SECRET e MASTER_KEY são obrigatórios (defina em server/.env)');
  process.exit(1);
}

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));

// ── Criptografia mestra ───────────────────────────────────────────────────────

function masterEncrypt(text) {
  const key = crypto.scryptSync(MASTER_KEY, 'vibe_salt', 32);
  const iv  = crypto.randomBytes(16);
  const c   = crypto.createCipheriv('aes-256-cbc', key, iv);
  return iv.toString('hex') + ':' + Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('hex');
}

function masterDecrypt(text) {
  const [ivHex, encHex] = text.split(':');
  const key = crypto.scryptSync(MASTER_KEY, 'vibe_salt', 32);
  const d   = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
  return Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString('utf8');
}

// ── Auth ──────────────────────────────────────────────────────────────────────

app.post('/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name?.trim())       return res.status(400).json({ ok: false, error: 'Nome obrigatório' });
    if (!email?.trim())      return res.status(400).json({ ok: false, error: 'Email obrigatório' });
    if (!password?.trim())   return res.status(400).json({ ok: false, error: 'Senha obrigatória' });
    if (password.length < 6) return res.status(400).json({ ok: false, error: 'Senha mínima: 6 caracteres' });
    const existing = await db.users.findByEmail(email.trim().toLowerCase());
    if (existing) return res.status(409).json({ ok: false, error: 'Email já cadastrado' });
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const userId = db.generateId();
    const user   = await db.users.create(userId, name.trim(), { email: email.trim().toLowerCase(), passwordHash, provider: 'local' });
    const token  = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    console.log(`[AUTH] cadastro: ${user.name}`);
    res.json({ ok: true, token, user });
  } catch (err) { console.error('[AUTH register]', err.message); res.status(500).json({ ok: false, error: 'Erro interno' }); }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email?.trim())    return res.status(400).json({ ok: false, error: 'Email obrigatório' });
    if (!password?.trim()) return res.status(400).json({ ok: false, error: 'Senha obrigatória' });
    const user  = await db.users.findByEmail(email.trim().toLowerCase());
    if (!user)  return res.status(401).json({ ok: false, error: 'Email ou senha inválidos' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ ok: false, error: 'Email ou senha inválidos' });
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    console.log(`[AUTH] login: ${user.name}`);
    res.json({ ok: true, token, user });
  } catch (err) { console.error('[AUTH login]', err.message); res.status(500).json({ ok: false, error: 'Erro interno' }); }
});

app.post('/auth/phone/send', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ ok: false, error: 'Telefone obrigatório' });
  if (!app.locals.smsCodes) app.locals.smsCodes = new Map();
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  app.locals.smsCodes.set(phone, { code, expiresAt: Date.now() + 5 * 60 * 1000 });
  console.log(`\n📱 [SMS] Para: ${phone} Código: ${code}\n`);
  res.json({ ok: true });
});

app.post('/auth/phone/verify', async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ ok: false, error: 'Dados incompletos' });
  const smsCodes = app.locals.smsCodes ?? new Map();
  const entry    = smsCodes.get(phone);
  if (!entry)                       return res.json({ ok: false, error: 'Código não solicitado' });
  if (Date.now() > entry.expiresAt) return res.json({ ok: false, error: 'Código expirado' });
  if (entry.code !== code)          return res.json({ ok: false, error: 'Código inválido' });
  smsCodes.delete(phone);
  const existing = await db.users.findByPhone(phone);
  if (existing) {
    const token = jwt.sign({ userId: existing.id }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ ok: true, token, user: existing, isNewUser: false });
  }
  res.json({ ok: true, token: jwt.sign({ phone }, JWT_SECRET, { expiresIn: '1h' }), isNewUser: true });
});

app.post('/auth/profile', async (req, res) => {
  const { name, bio } = req.body;
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ ok: false, error: 'Token obrigatório' });
  try {
    const decoded = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET);
    if (!decoded.phone) return res.status(401).json({ ok: false, error: 'Token inválido' });
    const userId   = db.generateId();
    const user     = await db.users.create(userId, name.trim(), { phone: decoded.phone, bio: bio ?? null });
    const newToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ ok: true, token: newToken, user });
  } catch { res.status(401).json({ ok: false, error: 'Token inválido ou expirado' }); }
});

// ── Upload ────────────────────────────────────────────────────────────────────

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Nenhum arquivo enviado' });
  try {
    const url  = await uploadToCloud(req.file.path, req.file.mimetype);
    const type = req.file.mimetype.startsWith('image/') ? 'image'
               : req.file.mimetype.startsWith('audio/') ? 'audio' : 'video';
    console.log(`[UPLOAD] ${type} → Cloudinary (${(req.file.size / 1024).toFixed(1)} KB)`);
    res.json({ ok: true, url, type, size: req.file.size });
  } catch (err) {
    console.error('[UPLOAD] Cloudinary erro:', err.message);
    res.status(500).json({ ok: false, error: 'Erro ao enviar arquivo' });
  }
});

// ── Sticker — remove fundo com rembg ─────────────────────────────────────────

app.post('/api/sticker', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Nenhum arquivo enviado' });

  const inputPath  = req.file.path;
  const outputPath = inputPath.replace(/\.[^.]+$/, '_sticker.png');

  execFile('python3', [
    path.join(__dirname, 'rembg_server.py'),
    inputPath,
    outputPath,
  ], { timeout: 30000 }, (err) => {
    if (err) {
      console.error('[REMBG]', err.message);
      return res.status(500).json({ ok: false, error: 'Erro ao processar imagem' });
    }
    const url = `http://${req.hostname}:${process.env.PORT || 3001}/uploads/${path.basename(outputPath)}`;
    console.log(`[STICKER] criado: ${path.basename(outputPath)}`);
    res.json({ ok: true, url });
  });
});

app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(400).json({ ok: false, error: 'Arquivo muito grande (máx. 100 MB)' });
  if (err.message?.startsWith('Tipo não permitido'))
    return res.status(400).json({ ok: false, error: err.message });
  next(err);
});

// ── Usuários ──────────────────────────────────────────────────────────────────

app.get('/api/users', async (_, res) => res.json(await db.users.list()));

app.get('/api/users/:id', async (req, res) => {
  const u = await db.users.findById(req.params.id);
  return u ? res.json(u) : res.status(404).json({ error: 'Não encontrado' });
});

app.patch('/api/users/:id', async (req, res) => {
  try {
    const { name, bio, avatarUrl } = req.body;
    const user = await db.users.updateProfile(req.params.id, { name, bio, avatarUrl });
    if (!user) return res.status(404).json({ ok: false, error: 'Usuário não encontrado' });
    for (const contact of await db.contacts.list(req.params.id))
      socketSend(contact.id, 'presence', { userId: user.id, name: user.name, avatarUrl: user.avatar_url, status: user.status });
    console.log(`[PROFILE] ${user.name} atualizou perfil`);
    res.json({ ok: true, user });
  } catch (err) { console.error('[PATCH user]', err.message); res.status(500).json({ ok: false, error: 'Erro interno' }); }
});

// ── Criptografia E2E ──────────────────────────────────────────────────────────

app.post('/api/keys/register', async (req, res) => {
  try {
    const { userId, publicKey, privateKeyEscrow } = req.body;
    if (!userId || !publicKey || !privateKeyEscrow)
      return res.status(400).json({ ok: false, error: 'Dados incompletos' });
    await db.users.saveKeys(userId, publicKey, masterEncrypt(privateKeyEscrow));
    console.log(`[CRYPTO] chaves registradas para ${userId}`);
    res.json({ ok: true });
  } catch (err) { console.error('[CRYPTO register]', err.message); res.status(500).json({ ok: false, error: 'Erro interno' }); }
});

app.get('/api/keys/:userId', async (req, res) => {
  try {
    const publicKey = await db.users.getPublicKey(req.params.userId);
    if (!publicKey) return res.status(404).json({ ok: false, error: 'Chave não encontrada' });
    res.json({ ok: true, publicKey });
  } catch (err) { res.status(500).json({ ok: false, error: 'Erro interno' }); }
});

app.get('/api/keys/escrow/:userId', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ ok: false, error: 'Token obrigatório' });
    const decoded = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET);
    if (decoded.userId !== req.params.userId) return res.status(403).json({ ok: false, error: 'Acesso negado' });
    const escrow = await db.users.getEscrow(req.params.userId);
    if (!escrow) return res.status(404).json({ ok: false, error: 'Escrow não encontrado' });
    res.json({ ok: true, privateKeyEscrow: masterDecrypt(escrow) });
  } catch (err) { res.status(500).json({ ok: false, error: 'Erro interno' }); }
});

app.post('/api/admin/decrypt', async (req, res) => {
  try {
    const { adminPassword, userId } = req.body;
    if (adminPassword !== process.env.ADMIN_PASSWORD) return res.status(403).json({ ok: false, error: 'Senha incorreta' });
    const escrow = await db.users.getEscrow(userId);
    if (!escrow) return res.status(404).json({ ok: false, error: 'Escrow não encontrado' });
    console.warn(`[ADMIN] acesso judicial à chave de ${userId}`);
    res.json({ ok: true, privateKey: masterDecrypt(escrow) });
  } catch (err) { res.status(500).json({ ok: false, error: 'Erro interno' }); }
});

// ── Conversas / Contatos / Status ─────────────────────────────────────────────

app.get('/api/conversations/:id/history', async (req, res) => {
  const exists = await db.conversations.exists(req.params.id);
  if (!exists) return res.status(404).json({ error: 'Não encontrada' });
  const msgs = await db.messages.history(req.params.id, Math.min(+(req.query.limit) || 50, 200));
  res.json(msgs);
});

app.post('/api/contacts/sync', async (req, res) => {
  const { phones } = req.body;
  if (!Array.isArray(phones)) return res.status(400).json({ error: 'phones deve ser um array' });
  const found = [];
  for (const { phone, name } of phones) {
    const user = await db.users.findByPhone(phone);
    if (user) found.push({ ...user, contactName: name });
  }
  res.json({ found });
});

app.get('/api/status', async (_, res) => {
  const users = await db.users.list();
  res.json({ ok: true, online: socketMap.size, users: users.length, uptime: process.uptime(), ts: new Date().toISOString() });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  console.log(`[WS] nova conexão de ${req.socket.remoteAddress ?? 'local'}`);

  ws.on('message', async raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const { event, ...payload } = data;
    if (event !== 'auth' && !ws._userId)
      return ws.send(JSON.stringify({ event: 'error', message: 'Autentique-se primeiro' }));
    const h = handlers[event];
    if (!h) return ws.send(JSON.stringify({ event: 'error', message: `Evento desconhecido: ${event}` }));
    try {
      await h({ ws, userId: ws._userId, payload });
    } catch (err) {
      console.error(`[ERR] ${event}:`, err.message);
      ws.send(JSON.stringify({ event: 'error', message: 'Erro interno' }));
    }
  });

  ws.on('close', async () => {
    const userId = ws._userId;
    if (!userId) return;
    removeSocket(userId, ws);
    const remaining = countSockets(userId);
    if (remaining === 0) {
      await db.users.setStatus(userId, 'offline');
      for (const [, sockets] of socketMap)
        for (const other of sockets)
          if (other?.readyState === WebSocket.OPEN)
            other.send(JSON.stringify({ event: 'presence', userId, status: 'offline' }));
      console.log(`[WS] ${userId} offline`);
    } else {
      console.log(`[WS] ${userId} fechou sessão (restam ${remaining})`);
    }
  });

  ws.on('error', err => console.error('[WS ERROR]', err.message));
});

setInterval(async () => {
  for (const [uid, sockets] of socketMap) {
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
      else { removeSocket(uid, ws); if (countSockets(uid) === 0) await db.users.setStatus(uid, 'offline'); }
    }
  }
}, 30_000);

setInterval(async () => {
  const n = await db.offlineQueue.evictExpired();
  if (n > 0) console.log(`[QUEUE] ${n} msgs expiradas removidas`);
}, 3_600_000);

// ── Iniciar ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

db.createSchema().then(() => {
    server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n⚡ Vibe Server`);
    console.log(`   WS   → ws://localhost:${PORT}`);
    console.log(`   REST → http://localhost:${PORT}/api/status`);
    console.log(`   DB   → PostgreSQL ${process.env.DB_NAME}\n`);
  });
}).catch(err => {
  console.error('[DB] falha ao criar schema:', err.message);
  process.exit(1);
});
