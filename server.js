require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const sizeOf = require('image-size');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
const PORT = process.env.PORT || 3000;
const PIN = process.env.GALLERY_PIN || '1234'; // change-le sur Render (variable d'environnement)

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const FOLDERS_FILE = path.join(DATA_DIR, 'folders.json');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(META_FILE)) fs.writeFileSync(META_FILE, '[]');
if (!fs.existsSync(FOLDERS_FILE)) fs.writeFileSync(FOLDERS_FILE, '[]');

function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', (req, res) => {
  const { pin } = req.body;
  if (pin === PIN) res.json({ ok: true, token: PIN });
  else res.status(401).json({ ok: false, error: 'Code incorrect' });
});

function requireAuth(req, res, next) {
  if (req.header('x-pin') === PIN) return next();
  res.status(401).json({ error: 'Non autorisé' });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, id + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

function orientationOf(w, h) {
  if (w === h) return 'square';
  return w > h ? 'landscape' : 'portrait';
}

function getVideoInfo(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return resolve({ duration: 0, width: 1, height: 1 });
      const stream = (data.streams || []).find(s => s.width && s.height) || {};
      resolve({
        duration: (data.format && data.format.duration) || 0,
        width: stream.width || 1,
        height: stream.height || 1
      });
    });
  });
}

function matchesFolder(rec, folder) {
  if (folder.orient !== 'any' && rec.orientation !== folder.orient) return false;
  if (rec.type === 'video' && folder.dur !== 'any') {
    const isShort = rec.duration < 30;
    if (folder.dur === 'short' && !isShort) return false;
    if (folder.dur === 'long' && isShort) return false;
  }
  return true;
}

app.post('/api/upload', requireAuth, upload.array('files', 30), async (req, res) => {
  const meta = readJSON(META_FILE);
  const folders = readJSON(FOLDERS_FILE);
  const newRecords = [];

  for (const file of req.files) {
    const isVideo = file.mimetype.startsWith('video');
    let width = 1, height = 1, duration = 0;
    try {
      if (isVideo) {
        const info = await getVideoInfo(file.path);
        width = info.width; height = info.height; duration = info.duration;
      } else {
        const dims = sizeOf(file.path);
        width = dims.width; height = dims.height;
      }
    } catch (e) { /* si l'analyse échoue, on garde les valeurs par défaut */ }

    const record = {
      id: path.parse(file.filename).name,
      name: file.originalname,
      type: isVideo ? 'video' : 'image',
      mime: file.mimetype,
      url: '/uploads/' + file.filename,
      duration, width, height,
      orientation: orientationOf(width, height),
      folderId: null,
      addedAt: Date.now()
    };
    meta.push(record);
    newRecords.push(record);
  }

  newRecords.forEach(rec => {
    const match = folders.find(fo => matchesFolder(rec, fo));
    if (match) rec.folderId = match.id;
  });

  writeJSON(META_FILE, meta);
  res.json({ ok: true, files: newRecords });
});

app.get('/api/files', requireAuth, (req, res) => {
  res.json(readJSON(META_FILE));
});

app.delete('/api/files/:id', requireAuth, (req, res) => {
  let meta = readJSON(META_FILE);
  const rec = meta.find(f => f.id === req.params.id);
  if (rec) {
    const filePath = path.join(UPLOAD_DIR, path.basename(rec.url));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  meta = meta.filter(f => f.id !== req.params.id);
  writeJSON(META_FILE, meta);
  res.json({ ok: true });
});

app.get('/api/folders', requireAuth, (req, res) => {
  res.json(readJSON(FOLDERS_FILE));
});

app.post('/api/folders', requireAuth, (req, res) => {
  const { name, orient, dur } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  const folders = readJSON(FOLDERS_FILE);
  const folder = { id: 'd' + Date.now(), name, orient: orient || 'any', dur: dur || 'any' };
  folders.push(folder);
  writeJSON(FOLDERS_FILE, folders);
  res.json({ ok: true, folder });
});

app.delete('/api/folders/:id', requireAuth, (req, res) => {
  let folders = readJSON(FOLDERS_FILE);
  folders = folders.filter(f => f.id !== req.params.id);
  writeJSON(FOLDERS_FILE, folders);
  let meta = readJSON(META_FILE);
  meta.forEach(f => { if (f.folderId === req.params.id) f.folderId = null; });
  writeJSON(META_FILE, meta);
  res.json({ ok: true });
});

app.post('/api/sort', requireAuth, (req, res) => {
  const meta = readJSON(META_FILE);
  const folders = readJSON(FOLDERS_FILE);
  let moved = 0;
  meta.forEach(rec => {
    if (!rec.folderId) {
      const match = folders.find(fo => matchesFolder(rec, fo));
      if (match) { rec.folderId = match.id; moved++; }
    }
  });
  writeJSON(META_FILE, meta);
  res.json({ ok: true, moved, files: meta });
});

app.listen(PORT, () => console.log('Galerie privée lancée sur le port ' + PORT));
