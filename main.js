import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import pkg from 'silent-akinator-pro';

const Akinator = pkg.default || pkg.Akinator || pkg;

// ==========================================
// 1. AYARLAR
// ==========================================
const REGIONS = { TR: 'tr', EN: 'en' };
const ANSWER_LABELS = ['Evet', 'Hayır', 'Bilmiyorum', 'Muhtemelen', 'Muhtemelen Hayır'];
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 dk hareketsiz oyun silinir

// sessionId -> { userId, aki, updatedAt }
const sessions = new Map();

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.status(200).json({ ok: true, activeGames: sessions.size }));

// ==========================================
// 2. YARDIMCILAR
// ==========================================
async function startWithRetry(region, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const aki = new Akinator({ region, childMode: false });
      await aki.start();
      return aki;
    } catch (err) {
      lastErr = err;
      console.error(`Akinator start ${i}/${tries} başarısız:`, err.message);
      if (i < tries) await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw lastErr;
}

function findUserSession(userId) {
  for (const [id, s] of sessions) if (s.userId === userId) return id;
  return null;
}

// ==========================================
// 3. /api/start
// ==========================================
app.post('/api/start', async (req, res) => {
  try {
    const { userId, language = 'TR' } = req.body || {};
    if (!userId) return res.status(400).json({ success: false, error: 'userId gerekli' });

    const lang = String(language).toUpperCase();
    const region = REGIONS[lang];
    if (!region) return res.status(400).json({ success: false, error: 'Desteklenen diller: TR, EN' });

    const existing = findUserSession(userId);
    if (existing) {
      return res.status(409).json({ success: false, error: 'Bu kullanıcı zaten bir oyunda', sessionId: existing });
    }

    const aki = await startWithRetry(region);
    const sessionId = randomUUID();
    sessions.set(sessionId, { userId, aki, updatedAt: Date.now() });

    return res.status(200).json({
      success: true,
      sessionId,
      userId,
      language: lang,
      question: aki.question,
      answers: ANSWER_LABELS,
      step: aki.step,
      progression: aki.progression
    });
  } catch (error) {
    console.error('Start Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 4. /api/answer
// ==========================================
app.post('/api/answer', async (req, res) => {
  try {
    const { userId, sessionId, answer } = req.body || {};
    if (!userId || !sessionId || answer === undefined) {
      return res.status(400).json({ success: false, error: 'userId, sessionId ve answer gerekli' });
    }

    const answerNumber = Number(answer);
    if (!Number.isInteger(answerNumber) || answerNumber < 0 || answerNumber > 4) {
      return res.status(400).json({ success: false, error: 'answer 0 ile 4 arasında olmalı' });
    }

    const s = sessions.get(sessionId);
    if (!s || s.userId !== userId) {
      return res.status(404).json({ success: false, error: 'Oturum bulunamadı veya bu kullanıcıya ait değil' });
    }

    const { aki } = s;
    const result = await aki.answer(answerNumber);
    s.updatedAt = Date.now();

    // Akinator tahmin ettiyse oyunu bitir
    if (aki.guessed) {
      const winResult = aki.guess || null;
      sessions.delete(sessionId);
      return res.status(200).json({ success: true, sessionId, userId, won: true, result: winResult });
    }

    return res.status(200).json({
      success: true,
      sessionId,
      userId,
      won: false,
      question: result?.question ?? aki.question,
      answers: ANSWER_LABELS,
      step: aki.step,
      progression: result?.progression ?? aki.progression
    });
  } catch (error) {
    console.error('Answer Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 5. /api/cancel
// ==========================================
app.post('/api/cancel', (req, res) => {
  const { userId, sessionId } = req.body || {};
  if (!userId || !sessionId) {
    return res.status(400).json({ success: false, error: 'userId ve sessionId gerekli' });
  }
  const s = sessions.get(sessionId);
  if (!s || s.userId !== userId) {
    return res.status(404).json({ success: false, error: 'Aktif oyun bulunamadı' });
  }
  sessions.delete(sessionId);
  return res.status(200).json({ success: true, message: 'Oyun iptal edildi', sessionId, userId });
});

// ==========================================
// 6. TEMİZLİK + BAŞLAT
// ==========================================
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.updatedAt > SESSION_TTL_MS) sessions.delete(id);
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Akinator API ${PORT} portunda başlatıldı!`));
