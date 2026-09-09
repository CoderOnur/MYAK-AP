import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { AkinatorClient, Languages, Themes } from 'akinator-client';

// ==========================================
// 1. SUPABASE BAGLANTISI
// ==========================================
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://intlxvlmtjbxryvxketo.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImludGx4dmxtdGpieHJ5dnhrZXRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzNzQ1NDQsImV4cCI6MjEwMzk1MDU0NH0.26Dl6FzSWGlol8e_Hf9oSCi3LgSoncwSVfqkB03A2Lc';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ==========================================
// 2. EXPRESS SUNUCU AYARLARI
// ==========================================
const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ana sayfada index.html dokümantasyonunu göster
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// 3. API ENDPOINT: /api/start
// ==========================================
app.post('/api/start', async (req, res) => {
  try {
    const { userId, language = 'TR' } = req.body || {};

    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId gerekli' });
    }

    const lang = String(language).toUpperCase();
    const languageMap = { TR: Languages.Turkish, EN: Languages.English };
    const selectedLanguage = languageMap[lang];

    if (!selectedLanguage) {
      return res.status(400).json({ success: false, error: 'Desteklenen diller: TR, EN' });
    }

    // Kullanıcının aktif oyunu var mı kontrol et
    const { data: existingSession, error: checkError } = await supabase
      .from('akinator_sessions')
      .select('id')
      .eq('user_id', userId)
      .limit(1);

    if (checkError) throw checkError;

    if (existingSession && existingSession.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'Bu kullanıcı zaten bir oyunda',
        sessionId: existingSession[0].id
      });
    }

    // Oyunu Başlat
    const aki = new AkinatorClient({
      language: selectedLanguage,
      theme: Themes.Character
    });

    const result = await aki.start();
    const sessionId = randomUUID();

    // Supabase'e Kaydet
    const { error: insertError } = await supabase
      .from('akinator_sessions')
      .insert({
        id: sessionId,
        user_id: userId,
        session_data: aki.toJSON()
      });

    if (insertError) throw insertError;

    return res.status(200).json({
      success: true,
      sessionId,
      userId,
      language: lang,
      question: result.question,
      answers: result.answers,
      step: result.step,
      progression: result.progression
    });

  } catch (error) {
    console.error('Start Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 4. API ENDPOINT: /api/answer
// ==========================================
app.post('/api/answer', async (req, res) => {
  try {
    const { userId, sessionId, answer } = req.body || {};

    if (!userId || !sessionId || answer === undefined) {
      return res.status(400).json({
        success: false,
        error: 'userId, sessionId ve answer gerekli'
      });
    }

    const answerNumber = Number(answer);
    if (!Number.isInteger(answerNumber) || answerNumber < 0 || answerNumber > 4) {
      return res.status(400).json({
        success: false,
        error: 'answer 0 ile 4 arasında olmalı'
      });
    }

    // Oturumu Çek
    const { data, error } = await supabase
      .from('akinator_sessions')
      .select('session_data')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return res.status(404).json({
        success: false,
        error: 'Oturum bulunamadı veya bu kullanıcıya ait değil'
      });
    }

    const aki = AkinatorClient.fromJSON(data.session_data);
    let result;

    try {
      result = await aki.answer(answerNumber);
    } catch (err) {
      if (err.message && err.message.toLowerCase().includes('already gave up')) {
        result = await aki.continue();
      } else {
        throw err;
      }
    }

    if (aki.ko) {
      result = await aki.continue();
    }

    // Karakter Bildiyse (Won)
    if (aki.won || result.won) {
      const winResult = aki.winResult || null;

      // Oturumu Sil
      const { error: deleteError } = await supabase
        .from('akinator_sessions')
        .delete()
        .eq('id', sessionId)
        .eq('user_id', userId);

      if (deleteError) throw deleteError;

      return res.status(200).json({
        success: true,
        sessionId,
        userId,
        won: true,
        result: winResult
      });
    }

    // Oyun Devam Ediyorsa Oturumu Güncelle
    const { error: updateError } = await supabase
      .from('akinator_sessions')
      .update({
        session_data: aki.toJSON(),
        updated_at: new Date().toISOString()
      })
      .eq('id', sessionId)
      .eq('user_id', userId);

    if (updateError) throw updateError;

    return res.status(200).json({
      success: true,
      sessionId,
      userId,
      won: false,
      question: result.question,
      answers: result.answers,
      step: result.step,
      progression: result.progression
    });

  } catch (error) {
    console.error('Answer Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 5. API ENDPOINT: /api/cancel
// ==========================================
app.post('/api/cancel', async (req, res) => {
  try {
    const { userId, sessionId } = req.body || {};

    if (!userId || !sessionId) {
      return res.status(400).json({
        success: false,
        error: 'userId ve sessionId gerekli'
      });
    }

    const { data, error } = await supabase
      .from('akinator_sessions')
      .delete()
      .eq('id', sessionId)
      .eq('user_id', userId)
      .select();

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Aktif oyun bulunamadı'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Oyun iptal edildi',
      sessionId,
      userId
    });

  } catch (error) {
    console.error('Cancel Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Oyun iptal edilirken hata oluştu'
    });
  }
});

// ==========================================
// 6. SUNUCUYU BAŞLAT
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Akinator API ${PORT} portunda başarıyla başlatıldı!`);
});
  
