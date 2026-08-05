'use strict';

const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const cloudinary = require('cloudinary').v2;

// ── Configura Cloudinary ──────────────────────────────────────────────────────

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Pasta temporária local (para o multer salvar antes de enviar) ─────────────

const UPLOAD_DIR = path.join(__dirname, '../../uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Tipos permitidos ──────────────────────────────────────────────────────────

const ALLOWED = {
  'image/jpeg': 'image',
  'image/png':  'image',
  'image/gif':  'image',
  'image/webp': 'image',
  'audio/mpeg': 'audio',
  'audio/ogg':  'audio',
  'audio/wav':  'audio',
  'audio/webm': 'audio',
  'audio/m4a':  'audio',
  'audio/mp4':  'audio',
  'video/mp4':  'video',
  'video/webm': 'video',
  'video/ogg':  'video',
};

// ── Multer — salva temporariamente em disco ───────────────────────────────────

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase() || '.bin';
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, name);
  },
});

const fileFilter = (req, file, cb) => {
  if (ALLOWED[file.mimetype]) cb(null, true);
  else cb(new Error(`Tipo não permitido: ${file.mimetype}`), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

// ── Envia arquivo para Cloudinary e remove o temp ─────────────────────────────
// Retorna a URL pública do Cloudinary

async function uploadToCloud(filePath, mimetype) {
  const resourceType = mimetype.startsWith('image/') ? 'image'
                   : mimetype.startsWith('video/') ? 'video'
                   : 'video'; // audio também vai como video no Cloudinary

  try {
    const result = await cloudinary.uploader.upload(filePath, {
      resource_type: resourceType,
      folder:        'vibe',
    });

    // Remove arquivo temporário
    fs.unlink(filePath, () => {});

    return result.secure_url;
  } catch (err) {
    // Remove arquivo temporário mesmo em caso de erro
    fs.unlink(filePath, () => {});
    throw err;
  }
}

module.exports = { upload, uploadToCloud, UPLOAD_DIR, ALLOWED };
