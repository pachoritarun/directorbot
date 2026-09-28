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
import { fetchUnreadEmails, sendVerifiedEmail, searchGmail } from '../services/gmailService.js';
import { getSchedulesByDate, parseScheduleFromText, parseScheduleIntentWithAI, addSchedule, getUpcomingSchedules } from '../services/scheduleService.js';
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
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith('@broadcast')) continue;

      const text = msg.message.conversation ||
                   msg.message.extendedTextMessage?.text ||
                   msg.message.imageMessage?.caption ||
                   msg.message.videoMessage?.caption ||
                   '';
      if (!text.trim()) continue;

      let senderPhone = '';
      if (msg.key.participant) {
        senderPhone = msg.key.participant.split('@')[0];
      } else if (msg.key.remoteJidAlt && msg.key.remoteJidAlt.includes('@s.whatsapp.net')) {
        senderPhone = msg.key.remoteJidAlt.split('@')[0];
      } else {
        senderPhone = jid.split('@')[0];
      }

      console.log(`[Bot WhatsApp] Inbound text from ${senderPhone} (${jid}): "${text}"`);
      await handleBotIncomingMessage(jid, senderPhone, text);
    }
  });
}

/**
 * Handles incoming interactions on the Executive Bot number
 */
async function handleBotIncomingMessage(jid, senderPhone, text) {
  try {
    const directorPhone = (await getSetting('DIRECTOR_PHONE')) || process.env.DIRECTOR_PHONE || '';
    const paPhone = (await getSetting('PA_PHONE')) || process.env.PA_PHONE || '';

    const cleanPhone = (p) => p ? p.replace(/[^0-9]/g, '') : '';
    const cleanSender = cleanPhone(senderPhone);
    const cleanDir = cleanPhone(directorPhone);
    const cleanPa = cleanPhone(paPhone);

    // Robust phone matcher: checks equality, endsWith, or last 10 digits
    const matchPhone = (a, b) => {
      if (!a || !b) return false;
      if (a === b || a.endsWith(b) || b.endsWith(a)) return true;
      if (a.length >= 10 && b.length >= 10 && a.slice(-10) === b.slice(-10)) return true;
      return false;
    };

    const isDirector = matchPhone(cleanSender, cleanDir);
    const isPA = matchPhone(cleanSender, cleanPa);

    // --- STRICT ACCESS CONTROL / SECURITY FIREWALL ---
    // If the sender is NEITHER Director NOR PA, reply with an authorization alert
    if (!isDirector && !isPA) {
      console.warn(`[Bot Security] Blocked unauthorized text from: ${senderPhone}. Configured Director: "${cleanDir || 'NONE'}", PA: "${cleanPa || 'NONE'}"`);
      await logActivity('SECURITY', `Inbound text from unrecognized number ${senderPhone}: "${text.slice(0, 50)}"`, 'WARN');

      await botSock.sendMessage(jid, {
        text: `🔒 *Executive AI Assistant (Access Notice)*\n\nHello! Your WhatsApp number (*+${senderPhone}*) is not yet recognized as an authorized Executive.\n\n🛠️ *To authorize this number:*\n1. Open your Web Dashboard > *Settings & Keys*\n2. Enter *${senderPhone}* in *Director's Phone Number* (or PA's Phone Number)\n3. Click *Save Configuration*\n\nOnce saved, you can query the AI anytime for emails, meetings, drafts, and university briefings!`
      });
      return;
    }

    // --- PA Commands & Natural AI Schedule Handling ---
    if (isPA && !isDirector) {
      // 1. Check legacy prefix if PA typed "!schedule"
      if (text.startsWith('!schedule')) {
        const added = await parseScheduleFromText(text);
        await botSock.sendMessage(jid, {
          text: `✅ *Schedule Updated by PA:*\nAdded ${added.length} meeting(s) to Director's calendar for today.`
        });
        return;
      }

      // 2. Intelligent AI Parsing for Natural PA messages (e.g. "Thoolle meeting tomorrow at 7 pm")
      const parsedIntent = await parseScheduleIntentWithAI(text);
      if (parsedIntent) {
        if (parsedIntent.intent === 'ADD_MEETING' && parsedIntent.meeting) {
          const m = parsedIntent.meeting;
          const id = await addSchedule({
            date: m.date || new Date().toISOString().split('T')[0],
            time_slot: m.time_slot || 'TBD',
            title: m.title || 'Scheduled Discussion',
            description: m.description || '',
            location: m.location || "Director's Office",
            priority: m.priority || 'Normal',
            created_by: 'PA via WhatsApp'
          });

          await botSock.sendMessage(jid, {
            text: `✅ *Meeting Scheduled in Director's Calendar!*\n\n📅 *Date:* ${m.date}\n⏰ *Time:* ${m.time_slot}\n📌 *Agenda:* ${m.title}\n${m.description ? `📝 *Notes:* ${m.description}\n` : ''}⚠️ *Priority:* ${m.priority || 'Normal'}\n📍 *Location:* ${m.location || "Director's Office"}\n\n_Director's itinerary has been successfully updated!_`
          });
          return;
        }

        if (parsedIntent.intent === 'VIEW_SCHEDULE') {
          const targetDate = parsedIntent.viewDate || new Date().toISOString().split('T')[0];
          const schedules = await getSchedulesByDate(targetDate);
          const list = schedules.length > 0
            ? schedules.map(s => `• *${s.time_slot}*: ${s.title} (${s.location}) [${s.priority}]`).join('\n')
            : `No meetings scheduled for ${targetDate}.`;

          await botSock.sendMessage(jid, {
            text: `📅 *Director's Schedule (${targetDate}):*\n\n${list}\n\n_To add a meeting, simply text details naturally (e.g., "Meeting tomorrow at 7 PM with Thoolle")_`
          });
          return;
        }

        if (parsedIntent.intent === 'GENERAL_QUERY' && parsedIntent.message) {
          await botSock.sendMessage(jid, {
            text: parsedIntent.message
          });
          return;
        }
      }

      // Fallback if AI was unavailable
      const todayStr = new Date().toISOString().split('T')[0];
      const schedules = await getSchedulesByDate(todayStr);
      const list = schedules.length > 0
        ? schedules.map(s => `• *${s.time_slot}*: ${s.title} (${s.location})`).join('\n')
        : 'No meetings scheduled for today.';
      await botSock.sendMessage(jid, {
        text: `📅 *Director's Schedule for Today (${todayStr}):*\n\n${list}\n\n_To add a meeting, text naturally (e.g. "Meeting tomorrow at 7 PM with Thoolle") or !schedule 10:30 AM - Title_`
      });
      return;
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
    // 1. Gather Context (Both today and upcoming schedules)
    const todayStr = new Date().toISOString().split('T')[0];
    const schedules = await getUpcomingSchedules();

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

    // Live search Gmail if user query inquires about emails, people, or entities
    let matchedEmails = [];
    const lowerText = text.toLowerCase();
    const isEmailSearch = lowerText.includes('email') || 
                          lowerText.includes('mail') || 
                          lowerText.includes('find') || 
                          lowerText.includes('search') || 
                          lowerText.includes('check') || 
                          lowerText.includes('iit') || 
                          lowerText.includes('techfest') || 
                          lowerText.includes('bombay') || 
                          lowerText.includes('dheemant') || 
                          lowerText.includes('workshop') ||
                          lowerText.includes('@') ||
                          lowerText.includes('.com') ||
                          lowerText.includes('.edu');

    if (isEmailSearch) {
      // 1. Check if user typed an explicit email address (e.g. Amitdheemant@jecrcu.edu.in)
      const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i;
      const emailMatch = text.match(emailRegex);

      let queryTerm = '';
      if (emailMatch) {
        const addr = emailMatch[1].toLowerCase();
        queryTerm = `from:${addr} OR to:${addr} OR "${addr}"`;
      } else {
        // 2. Check if user is asking for emails from a specific person
        const fromMatch = lowerText.match(/(?:from|sent by|bheja|send)\s+([a-zA-Z0-9_-]+)/i);
        if (fromMatch && fromMatch[1] && fromMatch[1].length > 2) {
          const person = fromMatch[1].trim();
          queryTerm = `from:${person} OR "${person}"`;
        } else {
          // 3. Clean keywords (remove stop/filler words while preserving dots and hyphens)
          const stopWords = /\b(find|search|check|look for|show me|give me|get me|the|email|mail|emails|mails|inbox|gmail|latest|recent|recently|today|yesterday|last|new|old|regarding|about|related to|of|from|to|for|with|bheja|aaya|kya|hai|tha|thi|the|se|ko|ka|ki|ke|kuch|koi|bhi|wala|wali|wale|me|mein|please|plz|sir|assistant|is|are|any)\b/gi;
          const cleanKeyword = text
            .replace(stopWords, ' ')
            .replace(/[?!,;'"()[\]{}<>*#~]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          queryTerm = cleanKeyword.length > 1 ? cleanKeyword : text;
        }
      }

      console.log(`[Director Query] Searching live Gmail inbox for: "${queryTerm}"...`);
      
      try {
        const liveFound = await searchGmail(queryTerm, 20);
        if (liveFound && liveFound.length > 0) {
          matchedEmails.push(...liveFound);
          // Auto-index into MySQL cache so it is permanently remembered
          for (const em of liveFound) {
            try {
              await query(
                `INSERT INTO email_summaries (gmail_id, sender_email, sender_name, subject, snippet, date_received, priority, summary, action_required)
                 VALUES (?, ?, ?, ?, ?, ?, 'Normal', ?, 'Informational')
                 ON DUPLICATE KEY UPDATE summary = VALUES(summary)`,
                [em.id, em.senderEmail, em.senderName, em.subject, em.snippet, em.date || '', em.snippet]
              );
            } catch(e) {}
          }
        }
      } catch (searchErr) {
        console.warn('[Director Query] Gmail search failed:', searchErr.message);
      }
    }

    const aiReply = await handleDirectorChat(text, {
      schedules,
      whatsappMessages: recentChats,
      recentEmails,
      matchedEmails,
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
    const emailDraftMatch = aiReply.match(/\[ACTION:DRAFT_EMAIL\s*\|\s*TO:([^|]+)\|\s*SUBJECT:([^|]+)\|\s*BODY:([\s\S]*?)\]/i) ||
      aiReply.match(/\[ACTION:DRAFT_EMAIL\s*\|\s*TO:([^|]+)\|\s*SUBJECT:([^|]+)\|\s*BODY:([^\]]+)\]/i);

    if (emailDraftMatch) {
      const to = emailDraftMatch[1].trim();
      const subject = emailDraftMatch[2].trim();
      let rawBody = emailDraftMatch[3].trim();

      // Clean up any literal escaped \n, \r\n, \t or stray backslashes
      const cleanBody = rawBody
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '')
        .replace(/\\t/g, '  ')
        .trim();

      // Save draft in MySQL with clean real newlines
      await query(
        `INSERT INTO email_drafts (recipient_email, recipient_name, subject, body, status)
         VALUES (?, ?, ?, ?, 'PENDING_VERIFICATION')`,
        [to, to, subject, cleanBody]
      );

      let cleanReply = aiReply.replace(emailDraftMatch[0], '')
        .replace(/\\r\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .trim();

      // If cleanReply already provided the full draft preview, don't duplicate the card
      let reviewMessage = '';
      if (cleanReply && cleanReply.toLowerCase().includes('*body:*')) {
        reviewMessage = cleanReply;
        if (!reviewMessage.toUpperCase().includes('CONFIRM')) {
          reviewMessage += `\n\n━━━━━━━━━━━━━━━━━━━━\n⚠️ *Reply "CONFIRM" to dispatch this email, or "CANCEL" to discard.*`;
        }
      } else {
        const intro = cleanReply || 'Sir, I have drafted the email for your review:';
        reviewMessage = `${intro}\n\n━━━━━━━━━━━━━━━━━━━━\n📝 *DRAFT EMAIL READY FOR REVIEW:*\n*To:* ${to}\n*Subject:* ${subject}\n\n*Body:*\n${cleanBody}\n━━━━━━━━━━━━━━━━━━━━\n⚠️ *Reply "CONFIRM" to dispatch this email, or "CANCEL" to discard.*`;
      }

      await botSock.sendMessage(jid, { text: reviewMessage });
      return;
    }

    // Regular AI response
    await botSock.sendMessage(jid, { text: aiReply });
  } catch (err) {
    console.error('[Bot Error]:', err);
    await logActivity('BOT_ERROR', `Error processing query from ${senderPhone}: ${err.message}`, 'ERROR');
    try {
      await botSock.sendMessage(jid, {
        text: `⚠️ *Executive Assistant Alert*\n\nI encountered an error processing your query: ${err.message}`
      });
    } catch (e) {}
  }
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

export async function sendTestPing(targetPhone) {
  if (!botSock) throw new Error('Executive Bot WhatsApp is not connected yet. Please scan QR.');
  const clean = targetPhone.replace(/[^0-9]/g, '');
  const jid = `${clean}@s.whatsapp.net`;
  await botSock.sendMessage(jid, {
    text: `🧪 *EXECUTIVE ASSISTANT DIAGNOSTIC PING*\n\n✅ Test message from Executive AI Command Hub.\n🕒 Time: ${new Date().toLocaleTimeString()}\n📡 Status: WhatsApp & Baileys Pipeline Operational.`
  });
  return true;
}
