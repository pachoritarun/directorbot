import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { initDatabase, query, getSetting, setSetting, logActivity, getDbStatus } from './src/database/db.js';
import { getAuthUrl, handleOAuthCallback, getGmailStatus, fetchUnreadEmails, sendVerifiedEmail, disconnectGmail } from './src/services/gmailService.js';
import { analyzeEmails, getGeminiClient, getGeminiModel } from './src/services/geminiService.js';
import { addSchedule, getSchedulesByDate, deleteSchedule, getUpcomingSchedules } from './src/services/scheduleService.js';
import {
  startDirectorSession,
  startBotSession,
  getWhatsAppStatus,
  setSocketIO,
  triggerDailyBriefing,
  sendTestPing
} from './src/whatsapp/baileysManager.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

setSocketIO(io);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'src/public')));
app.use('/storage', express.static(path.join(__dirname, 'storage')));

// --- Google OAuth2 Routes ---
app.get('/auth/google', async (req, res) => {
  try {
    const url = await getAuthUrl();
    res.redirect(url);
  } catch (err) {
    res.status(500).send(`<h3>Google OAuth Error</h3><p>${err.message}</p><p><a href="/">Back to Dashboard</a></p>`);
  }
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    return res.redirect(`/?auth=failed&msg=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return res.redirect('/?auth=failed&msg=Missing_authorization_code');
  }

  try {
    const result = await handleOAuthCallback(code);
    res.redirect(`/?auth=success&email=${encodeURIComponent(result.email)}`);
  } catch (err) {
    res.redirect(`/?auth=error&msg=${encodeURIComponent(err.message)}`);
  }
});

// Disconnect Google Account
app.post('/api/gmail/disconnect', async (req, res) => {
  try {
    await disconnectGmail();
    res.json({ success: true, message: 'Google account disconnected successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic / Test Endpoints
app.post('/api/test/gemini', async (req, res) => {
  try {
    const client = await getGeminiClient();
    if (!client) return res.status(400).json({ success: false, error: 'Gemini API key is not configured.' });
    const model = await getGeminiModel();
    const response = await client.models.generateContent({
      model,
      contents: 'Respond in 1 short sentence: "Executive AI Chief of Staff (Gemini 3.7 Flash) is operational."'
    });
    const text = typeof response.text === 'function' ? response.text() : (response.text || '');
    res.json({ success: true, model, response: text.trim() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/test/whatsapp-ping', async (req, res) => {
  try {
    const { target } = req.body; // 'director' or 'pa'
    const dirPhone = (await getSetting('DIRECTOR_PHONE')) || process.env.DIRECTOR_PHONE;
    const paPhone = (await getSetting('PA_PHONE')) || process.env.PA_PHONE;
    
    const phone = target === 'pa' ? paPhone : dirPhone;
    if (!phone) return res.status(400).json({ success: false, error: `${target === 'pa' ? 'PA' : 'Director'} phone number is not configured in Settings.` });

    await sendTestPing(phone);
    res.json({ success: true, message: `Test WhatsApp ping dispatched to ${phone}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- API Endpoints ---

// 1. Overall System Status
app.get('/api/status', async (req, res) => {
  try {
    const db = getDbStatus();
    const wa = getWhatsAppStatus();
    const gmail = await getGmailStatus();
    const geminiClient = await getGeminiClient();

    res.json({
      database: db,
      whatsapp: wa,
      gmail,
      gemini: { configured: !!geminiClient }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Dashboard Quick Stats
app.get('/api/stats', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const [emailStats] = await query(`SELECT COUNT(*) as total FROM email_summaries WHERE DATE(created_at) = ?`, [today]);
    const [chatStats] = await query(`SELECT COUNT(*) as total FROM whatsapp_chats WHERE DATE(created_at) = ?`, [today]);
    const [scheduleStats] = await query(`SELECT COUNT(*) as total FROM schedules WHERE date = ?`, [today]);
    const [pendingDrafts] = await query(`SELECT COUNT(*) as total FROM email_drafts WHERE status = 'PENDING_VERIFICATION'`);

    res.json({
      emailsToday: emailStats.total || 0,
      chatsToday: chatStats.total || 0,
      schedulesToday: scheduleStats.total || 0,
      pendingDrafts: pendingDrafts.total || 0
    });
  } catch (err) {
    res.json({ emailsToday: 0, chatsToday: 0, schedulesToday: 0, pendingDrafts: 0 });
  }
});

// 3. Schedules
app.get('/api/schedules', async (req, res) => {
  try {
    const today = req.query.date || new Date().toISOString().split('T')[0];
    const schedules = await getSchedulesByDate(today);
    const upcoming = await getUpcomingSchedules();
    res.json({ today: schedules, upcoming });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/schedules', async (req, res) => {
  try {
    const { date, time_slot, title, description, location, priority } = req.body;
    if (!time_slot || !title) {
      return res.status(400).json({ error: 'time_slot and title are required' });
    }
    const id = await addSchedule({
      date: date || new Date().toISOString().split('T')[0],
      time_slot,
      title,
      description,
      location,
      priority,
      created_by: 'Dashboard'
    });
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/schedules/:id', async (req, res) => {
  try {
    await deleteSchedule(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Emails Intelligence
app.get('/api/emails', async (req, res) => {
  try {
    const emails = await query(
      `SELECT * FROM email_summaries ORDER BY id DESC LIMIT 50`
    );
    res.json(emails);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/emails/sync', async (req, res) => {
  try {
    const raw = await fetchUnreadEmails(10);
    const analyzed = await analyzeEmails(raw);

    for (const em of analyzed) {
      try {
        await query(
          `INSERT INTO email_summaries (gmail_id, sender_email, sender_name, subject, snippet, date_received, priority, summary, action_required)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE priority = VALUES(priority), summary = VALUES(summary), action_required = VALUES(action_required)`,
          [em.id, em.senderEmail || '', em.senderName || '', em.subject || '', em.snippet || '', em.date || '', em.priority, em.summary, em.action_required]
        );
      } catch (e) {}
    }

    res.json({ success: true, count: analyzed.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Email Drafts (Verification Center)
app.get('/api/drafts', async (req, res) => {
  try {
    const drafts = await query('SELECT * FROM email_drafts ORDER BY id DESC LIMIT 20');
    res.json(drafts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/drafts/:id/confirm', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM email_drafts WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Draft not found' });
    const draft = rows[0];

    await sendVerifiedEmail({
      to: draft.recipient_email,
      subject: draft.subject,
      body: draft.body,
      draftId: draft.id
    });

    res.json({ success: true, message: 'Email sent successfully via Gmail API' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/drafts/:id/cancel', async (req, res) => {
  try {
    await query(`UPDATE email_drafts SET status = 'CANCELLED' WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. WhatsApp Chats (Silent View)
app.get('/api/whatsapp/chats', async (req, res) => {
  try {
    const chats = await query(
      `SELECT * FROM whatsapp_chats ORDER BY id DESC LIMIT 50`
    );
    res.json(chats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Executive Briefing Generation
app.post('/api/briefing/generate', async (req, res) => {
  try {
    const result = await triggerDailyBriefing();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/briefing/latest', (req, res) => {
  const dir = path.join(__dirname, 'storage/briefings');
  if (!fs.existsSync(dir)) return res.json({ available: false });

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.pdf'));
  if (files.length === 0) return res.json({ available: false });

  // Get most recent
  files.sort().reverse();
  const latestFile = files[0];
  res.json({
    available: true,
    filename: latestFile,
    url: `/storage/briefings/${latestFile}`
  });
});

// 8. Settings Management
app.get('/api/settings', async (req, res) => {
  try {
    const keys = [
      'GEMINI_API_KEY',
      'GEMINI_MODEL',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'DIRECTOR_PHONE',
      'PA_PHONE',
      'ORGANIZATION_NAME',
      'DIRECTOR_TITLE',
      'BRIEFING_TIME'
    ];

    const settings = {};
    for (const k of keys) {
      settings[k] = (await getSetting(k)) || process.env[k] || '';
    }

    // Mask sensitive keys for security in UI
    const masked = { ...settings };
    if (masked.GEMINI_API_KEY) masked.GEMINI_API_KEY = masked.GEMINI_API_KEY.slice(0, 6) + '••••••••' + masked.GEMINI_API_KEY.slice(-4);
    if (masked.GOOGLE_CLIENT_SECRET) masked.GOOGLE_CLIENT_SECRET = '••••••••••••';

    res.json({ settings: masked, rawConfigured: {
      hasGemini: !!settings.GEMINI_API_KEY,
      hasGoogleId: !!settings.GOOGLE_CLIENT_ID,
      hasGoogleSecret: !!settings.GOOGLE_CLIENT_SECRET
    }});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const allowed = [
      'GEMINI_API_KEY',
      'GEMINI_MODEL',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'DIRECTOR_PHONE',
      'PA_PHONE',
      'ORGANIZATION_NAME',
      'DIRECTOR_TITLE',
      'BRIEFING_TIME'
    ];

    for (const key of allowed) {
      if (req.body[key] !== undefined && req.body[key] !== null && !req.body[key].includes('••••')) {
        await setSetting(key, req.body[key]);
      }
    }

    await logActivity('SETTINGS', 'System settings updated via Web Dashboard', 'INFO');
    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Activity Logs Feed
app.get('/api/logs', async (req, res) => {
  try {
    const logs = await query('SELECT * FROM activity_logs ORDER BY id DESC LIMIT 40');
    res.json(logs);
  } catch (err) {
    res.json([]);
  }
});

// --- Scheduled Daily Morning Briefing Checker ---
let lastBriefingDate = '';
setInterval(async () => {
  try {
    const briefingTime = (await getSetting('BRIEFING_TIME')) || process.env.BRIEFING_TIME || '08:00';
    const now = new Date();
    const currentHours = String(now.getHours()).padStart(2, '0');
    const currentMinutes = String(now.getMinutes()).padStart(2, '0');
    const currentTimeStr = `${currentHours}:${currentMinutes}`;
    const todayStr = now.toISOString().split('T')[0];

    if (currentTimeStr === briefingTime && lastBriefingDate !== todayStr) {
      lastBriefingDate = todayStr;
      console.log(`[Auto-Briefing] Triggering daily morning briefing at ${currentTimeStr}...`);
      await triggerDailyBriefing();
    }
  } catch (e) {
    // ignore
  }
}, 60000);

// --- Server Startup ---
const PORT = process.env.PORT || 3000;

async function bootstrap() {
  console.log('--- Starting University Executive AI Assistant ---');
  
  // 1. Init Database
  await initDatabase();

  // 2. Start Dual Baileys WhatsApp Sessions
  console.log('[WhatsApp] Initializing Director & Bot WhatsApp instances...');
  startDirectorSession().catch(err => console.error('[Director WA Error]:', err.message));
  startBotSession().catch(err => console.error('[Bot WA Error]:', err.message));

  // 3. Start Web Server
  server.listen(PORT, () => {
    console.log(`[Server] Executive Dashboard is live at: http://localhost:${PORT}`);
    console.log(`[Server] Google OAuth Redirect URI: http://localhost:${PORT}/auth/google/callback`);
  });
}

bootstrap();
