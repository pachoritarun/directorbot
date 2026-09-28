import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { query, getSetting, logActivity } from '../database/db.js';
import { handleDirectorChat, draftExecutiveEmail, analyzeEmails, summarizeWhatsAppChats, getEdTechAndAiNews } from '../services/geminiService.js';
import { fetchUnreadEmails, sendVerifiedEmail } from '../services/gmailService.js';
import { getSchedulesByDate, parseScheduleFromText } from '../services/scheduleService.js';
import { generateExecutiveBriefingPdf } from '../services/pdfService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Session State
let directorSock = null;
let botSock = null;

let directorQR = null;
let botQR = null;

let directorStatus = 'DISCONNECTED';
let botStatus = 'DISCONNECTED';

let ioInstance = null;

export function setSocketIO(io) {
  ioInstance = io;
}

function emitStatus() {
  if (ioInstance) {
    ioInstance.emit('status_update', {
      director: { status: directorStatus, qr: directorQR },
      bot: { status: botStatus, qr: botQR }
    });
  }
}

/**
 * -------------------------------------------------------------
 * 1. DIRECTOR SESSION (Silent Reader & Action Agent)
 * -------------------------------------------------------------
 */
export async function startDirectorSession() {
  const authDir = path.join(__dirname, '../../storage/auth_director');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  directorSock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['Executive Listener', 'Chrome', '1.0.0']
  });

  directorSock.ev.on('creds.update', saveCreds);

  directorSock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      directorQR = await QRCode.toDataURL(qr);
      directorStatus = 'SCAN_QR';
      emitStatus();
    }

    if (connection === 'open') {
      directorQR = null;
      directorStatus = 'CONNECTED';
      emitStatus();
      await logActivity('DIRECTOR_WA', 'Director WhatsApp connected successfully (Silent Mode Active)', 'INFO');
      console.log('[Director WhatsApp] Connected successfully.');
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      directorStatus = 'DISCONNECTED';
      emitStatus();
      if (shouldReconnect) {
        setTimeout(startDirectorSession, 5000);
      }
    }
  });

  // Listen to incoming messages SILENTLY without marking them as read!
  directorSock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      const jid = msg.key.remoteJid;
      if (jid === 'status@broadcast') continue; // Ignore WhatsApp Status

      const isFromMe = msg.key.fromMe || false;
      const senderName = msg.pushName || (isFromMe ? 'Director' : jid.split('@')[0]);
      const senderPhone = jid.split('@')[0];
      const timestamp = msg.messageTimestamp;

      // Extract message text
      const text = msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';

      if (!text.trim()) continue;

      // NOTE: WE DO NOT CALL directorSock.readMessages([msg.key])!
      // This leaves the message as UNREAD on Director's phone.

      // Store in MySQL
      try {
        await query(
          `INSERT INTO whatsapp_chats (msg_id, chat_jid, sender_name, sender_phone, message_text, timestamp, is_from_me)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE message_text = VALUES(message_text)`,
          [msg.key.id, jid, senderName, senderPhone, text, timestamp, isFromMe]
        );
      } catch (err) {
        // duplicate or error ignored
      }
    }
  });
}

/**
 * -------------------------------------------------------------
 * 2. EXECUTIVE BOT SESSION (Assistant Number)
 * -------------------------------------------------------------
 */
export async function startBotSession() {
  const authDir = path.join(__dirname, '../../storage/auth_bot');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  botSock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['Executive Assistant Bot', 'Chrome', '1.0.0']
  });

  botSock.ev.on('creds.update', saveCreds);

  botSock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      botQR = await QRCode.toDataURL(qr);
      botStatus = 'SCAN_QR';
      emitStatus();
    }

    if (connection === 'open') {
      botQR = null;
      botStatus = 'CONNECTED';
      emitStatus();
      await logActivity('BOT_WA', 'Executive Bot WhatsApp connected successfully', 'INFO');
      console.log('[Bot WhatsApp] Connected successfully.');
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      botStatus = 'DISCONNECTED';
      emitStatus();
      if (shouldReconnect) {
        setTimeout(startBotSession, 5000);
      }
    }
  });

  // Handle incoming messages to Bot
  botSock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      if (!text.trim()) continue;

      const senderPhone = jid.split('@')[0];
      await handleBotIncomingMessage(jid, senderPhone, text);
    }
  });
}

/**
 * Handles incoming interactions on the Executive Bot number
 */
async function handleBotIncomingMessage(jid, senderPhone, text) {
  const directorPhone = (await getSetting('DIRECTOR_PHONE')) || process.env.DIRECTOR_PHONE || '';
  const paPhone = (await getSetting('PA_PHONE')) || process.env.PA_PHONE || '';

  const cleanPhone = (p) => p ? p.replace(/[^0-9]/g, '') : '';
  const cleanSender = cleanPhone(senderPhone);
  const cleanDir = cleanPhone(directorPhone);
  const cleanPa = cleanPhone(paPhone);

  const isDirector = cleanDir && (cleanSender.endsWith(cleanDir) || cleanDir.endsWith(cleanSender));
  const isPA = cleanPa && (cleanSender.endsWith(cleanPa) || cleanPa.endsWith(cleanSender));

  // --- STRICT ACCESS CONTROL / SECURITY FIREWALL ---
  // If the sender is NEITHER the Director NOR the authorized PA, completely ignore the message.
  // The bot will NEVER reply to any student, faculty, stranger, or spammer.
  if (!isDirector && !isPA) {
    console.log(`[Bot Security] Blocked & Ignored unauthorized text from: ${senderPhone}`);
    return;
  }

  // --- PA Commands & Authorization ---
  if (isPA && !isDirector) {
    if (text.startsWith('!schedule')) {
      const added = await parseScheduleFromText(text);
      await botSock.sendMessage(jid, {
        text: `✅ *Schedule Updated by PA:*\nAdded ${added.length} meeting(s) to Director's calendar for today.`
      });
      return;
    } else {
      // PA can check today's schedule
      if (text.toLowerCase().includes('schedule') || text.toLowerCase().includes('meeting')) {
        const todayStr = new Date().toISOString().split('T')[0];
        const schedules = await getSchedulesByDate(todayStr);
        const list = schedules.length > 0
          ? schedules.map(s => `• *${s.time_slot}*: ${s.title} (${s.location})`).join('\n')
          : 'No meetings scheduled for today.';
        await botSock.sendMessage(jid, {
          text: `📅 *Director's Schedule for Today (${todayStr}):*\n\n${list}\n\n_To add a meeting, send: !schedule Time - Meeting Title_`
        });
        return;
      }
      // For any other text from PA, guide them
      await botSock.sendMessage(jid, {
        text: `Hello PA. You can manage Director's schedule by texting:\n\`!schedule 10:30 AM - HOD Meeting; 02:00 PM - AI Review\``
      });
      return;
    }
  }

  // --- Briefing on Demand Command ---
  if (text.toLowerCase().trim() === '!briefing') {
    await botSock.sendMessage(jid, { text: `⏳ Generating Executive Daily Briefing PDF... Please wait a moment.` });
    await triggerDailyBriefing(jid);
    return;
  }

  // --- Check if Director is confirming a pending email draft ---
  const normalizedText = text.trim().toUpperCase();
  if (normalizedText === 'CONFIRM' || normalizedText === 'YES' || normalizedText === 'SEND') {
    const pendingDrafts = await query(
      `SELECT * FROM email_drafts WHERE status = 'PENDING_VERIFICATION' ORDER BY id DESC LIMIT 1`
    );

    if (pendingDrafts.length > 0) {
      const draft = pendingDrafts[0];
      try {
        await sendVerifiedEmail({
          to: draft.recipient_email,
          subject: draft.subject,
          body: draft.body,
          draftId: draft.id
        });
        await botSock.sendMessage(jid, {
          text: `🚀 *Email Sent Successfully!*\n\n*To:* ${draft.recipient_email}\n*Subject:* ${draft.subject}\n*Status:* Dispatched via Official Gmail.`
        });
        return;
      } catch (err) {
        await botSock.sendMessage(jid, {
          text: `❌ *Failed to send email:* ${err.message}`
        });
        return;
      }
    }
  }

  if (normalizedText === 'CANCEL' || normalizedText === 'DISCARD') {
    await query(`UPDATE email_drafts SET status = 'CANCELLED' WHERE status = 'PENDING_VERIFICATION'`);
    await botSock.sendMessage(jid, {
      text: `🛑 *Pending email draft has been cancelled.*`
    });
    return;
  }

  // --- Natural AI Conversation with Context ---
  // 1. Gather Context
  const todayStr = new Date().toISOString().split('T')[0];
  const schedules = await getSchedulesByDate(todayStr);

  const recentChats = await query(
    `SELECT sender_name, sender_phone, message_text, timestamp FROM whatsapp_chats 
     WHERE is_from_me = FALSE ORDER BY id DESC LIMIT 20`
  );

  const recentEmails = await query(
    `SELECT sender_name, subject, summary, priority, action_required FROM email_summaries 
     ORDER BY id DESC LIMIT 10`
  );

  const pendingDrafts = await query(
    `SELECT * FROM email_drafts WHERE status = 'PENDING_VERIFICATION' LIMIT 1`
  );

  const aiReply = await handleDirectorChat(text, {
    schedules,
    whatsappMessages: recentChats,
    recentEmails,
    pendingDrafts
  });

  // Check if AI generated an action block
  // Format: [ACTION:WHATSAPP_REPLY | TO:recipient | MESSAGE:text]
  const replyMatch = aiReply.match(/\[ACTION:WHATSAPP_REPLY\s*\|\s*TO:([^|]+)\|\s*MESSAGE:([^\]]+)\]/i);
  if (replyMatch) {
    const targetRecipient = replyMatch[1].trim();
    const messageToSend = replyMatch[2].trim();

    // Find recipient JID from database or phone
    let targetJid = null;
    if (targetRecipient.includes('@s.whatsapp.net')) {
      targetJid = targetRecipient;
    } else {
      const found = await query(
        `SELECT chat_jid, sender_name FROM whatsapp_chats 
         WHERE sender_name LIKE ? OR sender_phone LIKE ? ORDER BY id DESC LIMIT 1`,
        [`%${targetRecipient}%`, `%${targetRecipient}%`]
      );
      if (found.length > 0) {
        targetJid = found[0].chat_jid;
      }
    }

    if (targetJid && directorSock) {
      await directorSock.sendMessage(targetJid, { text: messageToSend });
      const cleanReply = aiReply.replace(replyMatch[0], '').trim();
      await botSock.sendMessage(jid, {
        text: `${cleanReply}\n\n✅ *Message sent to ${targetRecipient} from your Director WhatsApp account:* "${messageToSend}"`
      });
      return;
    } else {
      await botSock.sendMessage(jid, {
        text: `⚠️ Could not find WhatsApp contact for "${targetRecipient}". Please provide their exact phone number.`
      });
      return;
    }
  }

  // Format: [ACTION:DRAFT_EMAIL | TO:recipient | SUBJECT:subject | BODY:body]
  const emailDraftMatch = aiReply.match(/\[ACTION:DRAFT_EMAIL\s*\|\s*TO:([^|]+)\|\s*SUBJECT:([^|]+)\|\s*BODY:([^\]]+)\]/i);
  if (emailDraftMatch) {
    const to = emailDraftMatch[1].trim();
    const subject = emailDraftMatch[2].trim();
    const body = emailDraftMatch[3].trim();

    // Save draft in MySQL
    await query(
      `INSERT INTO email_drafts (recipient_email, recipient_name, subject, body, status)
       VALUES (?, ?, ?, ?, 'PENDING_VERIFICATION')`,
      [to, to, subject, body]
    );

    const cleanReply = aiReply.replace(emailDraftMatch[0], '').trim();
    await botSock.sendMessage(jid, {
      text: `${cleanReply}\n\n━━━━━━━━━━━━━━━━━━━━\n📝 *DRAFT EMAIL READY FOR REVIEW:*\n*To:* ${to}\n*Subject:* ${subject}\n\n*Body:*\n${body}\n━━━━━━━━━━━━━━━━━━━━\n⚠️ *Reply "CONFIRM" to dispatch this email, or "CANCEL" to discard.*`
    });
    return;
  }

  // Regular AI response
  await botSock.sendMessage(jid, { text: aiReply });
}

/**
 * Triggers the Executive Daily Briefing (PDF + Highlights)
 */
export async function triggerDailyBriefing(targetJid = null) {
  const todayStr = new Date().toISOString().split('T')[0];
  const directorPhone = (await getSetting('DIRECTOR_PHONE')) || process.env.DIRECTOR_PHONE;
  const recipientJid = targetJid || (directorPhone ? `${directorPhone.replace(/[^0-9]/g, '')}@s.whatsapp.net` : null);

  if (!recipientJid && !targetJid) {
    console.warn('[Briefing] Director phone number is not configured in settings.');
    return { success: false, error: 'Director phone number missing' };
  }

  try {
    // 1. Fetch Today's Schedules
    const schedules = await getSchedulesByDate(todayStr);

    // 2. Fetch & Analyze Unread Emails
    const rawEmails = await fetchUnreadEmails(12);
    const analyzedEmails = await analyzeEmails(rawEmails);

    // Store analyzed emails in MySQL
    for (const em of analyzedEmails) {
      try {
        await query(
          `INSERT INTO email_summaries (gmail_id, sender_email, sender_name, subject, snippet, date_received, priority, summary, action_required)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE priority = VALUES(priority), summary = VALUES(summary), action_required = VALUES(action_required)`,
          [em.id, em.senderEmail || '', em.senderName || '', em.subject || '', em.snippet || '', em.date || '', em.priority, em.summary, em.action_required]
        );
      } catch (err) {}
    }

    // 3. Summarize silent WhatsApp chats
    const recentChats = await query(
      `SELECT sender_name, sender_phone, message_text, timestamp FROM whatsapp_chats 
       WHERE is_from_me = FALSE ORDER BY id DESC LIMIT 30`
    );
    const whatsappSummary = await summarizeWhatsAppChats(recentChats);

    // 4. Curate EdTech & AI News
    const edTechNews = await getEdTechAndAiNews();

    // 5. Generate PDF
    const orgName = (await getSetting('ORGANIZATION_NAME')) || process.env.ORGANIZATION_NAME || 'JECRC University';
    const directorTitle = (await getSetting('DIRECTOR_TITLE')) || process.env.DIRECTOR_TITLE || 'Office of the Director';

    const pdfPath = await generateExecutiveBriefingPdf({
      dateStr: todayStr,
      organizationName: orgName,
      directorTitle,
      schedules,
      emails: analyzedEmails,
      whatsappSummary,
      edTechNews
    });

    // 6. Send PDF document & Text Summary via Bot WhatsApp
    if (botSock) {
      // First send WhatsApp text briefing
      const urgentCount = analyzedEmails.filter(e => e.priority === 'Urgent').length;
      const textDigest = `🏛️ *OFFICIAL EXECUTIVE DAILY BRIEFING*\n📅 *Date:* ${todayStr}\n\n` +
        `📋 *Meetings Today:* ${schedules.length} scheduled\n` +
        `🚨 *Urgent Emails:* ${urgentCount} require attention\n` +
        `💬 *WhatsApp Alerts:* ${whatsappSummary.urgent_alerts?.length || 0} priority messages\n` +
        `🎓 *Top EdTech News:* ${edTechNews[0]?.title || 'AI Integration in Higher Ed'}\n\n` +
        `📎 *Attached:* Complete High-Resolution Executive PDF Report below.`;

      await botSock.sendMessage(recipientJid, { text: textDigest });

      // Send PDF file
      const pdfBuffer = fs.readFileSync(pdfPath);
      await botSock.sendMessage(recipientJid, {
        document: pdfBuffer,
        mimetype: 'application/pdf',
        fileName: `Executive_Briefing_${todayStr}.pdf`,
        caption: `Executive Daily Intelligence Briefing - ${todayStr}`
      });

      await logActivity('BRIEFING', `Daily briefing PDF generated and sent to Director (${recipientJid})`, 'INFO');
    }

    return { success: true, pdfPath };
  } catch (error) {
    console.error('[Briefing Error]:', error);
    await logActivity('BRIEFING', `Briefing generation failed: ${error.message}`, 'ERROR');
    return { success: false, error: error.message };
  }
}

export function getWhatsAppStatus() {
  return {
    director: { status: directorStatus, qr: directorQR },
    bot: { status: botStatus, qr: botQR }
  };
}
