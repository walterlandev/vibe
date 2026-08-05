'use strict';

const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const db      = require('./db/db_index');

const SALT_ROUNDS = 10;
const SECRET      = process.env.JWT_SECRET;

async function register(req, res) {
  const { name, email, password } = req.body;

  if (!name?.trim())     return res.status(400).json({ ok: false, error: 'Nome obrigatório' });
  if (!email?.trim())    return res.status(400).json({ ok: false, error: 'Email obrigatório' });
  if (!password?.trim()) return res.status(400).json({ ok: false, error: 'Senha obrigatória' });
  if (password.length < 6) return res.status(400).json({ ok: false, error: 'Senha mínima: 6 caracteres' });

  const existing = await db.users.findByEmail(email.trim().toLowerCase());
  if (existing) return res.status(409).json({ ok: false, error: 'Email já cadastrado' });

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const userId       = db.generateId();
  const user         = await db.users.create(userId, name.trim(), {
    email:        email.trim().toLowerCase(),
    passwordHash,
    provider:     'local',
  });

  const token = jwt.sign({ userId: user.id }, SECRET, { expiresIn: '30d' });
  res.json({ ok: true, token, user });
}

async function login(req, res) {
  const { email, password } = req.body;

  if (!email?.trim())    return res.status(400).json({ ok: false, error: 'Email obrigatório' });
  if (!password?.trim()) return res.status(400).json({ ok: false, error: 'Senha obrigatória' });

  const user = await db.users.findByEmail(email.trim().toLowerCase());
  if (!user) return res.status(401).json({ ok: false, error: 'Email ou senha inválidos' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ ok: false, error: 'Email ou senha inválidos' });

  const token = jwt.sign({ userId: user.id }, SECRET, { expiresIn: '30d' });
  res.json({ ok: true, token, user });
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

module.exports = { register, login, verifyToken };
