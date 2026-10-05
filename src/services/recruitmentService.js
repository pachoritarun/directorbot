import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import { query, getSetting, getRecruitmentSetting, setRecruitmentSetting, getAllRecruitmentSettings, logActivity } from '../database/db.js';
import { getGeminiClient, callGeminiWithFallback } from './geminiService.js';
import dotenv from 'dotenv';
dotenv.config();

const RECRUITMENT_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

let isScanningActive = false;
let pollingIntervalHandle = null;

/**
 * Get OAuth2 client configured specifically for Recruitment Gmail
 * Uses the approved redirect URI configured in Google Cloud Console
 */
export async function getRecruitmentOAuth2Client() {
  const clientId = (await getSetting('GOOGLE_CLIENT_ID')) || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = (await getSetting('GOOGLE_CLIENT_SECRET')) || process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = (await getSetting('GOOGLE_REDIRECT_URI')) || process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

  if (!clientId || !clientSecret) {
    return null;
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Generate Google OAuth Consent URL for Recruitment Inbox
 * Uses state='recruitment' to route callbacks correctly without requiring new Google Cloud credentials
 */
export async function getRecruitmentAuthUrl() {
  const oauth2Client = await getRecruitmentOAuth2Client();
  if (!oauth2Client) {
    throw new Error('Google OAuth credentials (Client ID and Secret) are not configured.');
  }

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: RECRUITMENT_SCOPES,
    state: 'recruitment'
  });
}

/**
 * Handle Recruitment OAuth callback and store separate recruitment tokens
 */
export async function handleRecruitmentOAuthCallback(code) {
  const oauth2Client = await getRecruitmentOAuth2Client();
  if (!oauth2Client) throw new Error('Recruitment OAuth2 client not initialized');

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const userInfo = await oauth2.userinfo.get();
  const hiringEmail = userInfo.data.email;

  await query(
    `INSERT INTO recruitment_tokens (email, refresh_token, access_token, expiry_date, scope)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       refresh_token = COALESCE(VALUES(refresh_token), refresh_token),
       access_token = VALUES(access_token),
       expiry_date = VALUES(expiry_date),
       scope = VALUES(scope),
       updated_at = CURRENT_TIMESTAMP`,
    [
      hiringEmail,
      tokens.refresh_token || null,
      tokens.access_token,
      tokens.expiry_date || 0,
      tokens.scope || RECRUITMENT_SCOPES.join(' ')
    ]
  );

  await setRecruitmentSetting('RECRUITMENT_EMAIL', hiringEmail);
  await logActivity('RECRUITMENT', `Hiring Gmail connected successfully: ${hiringEmail}`, 'INFO');

  // Trigger initial scan
  setTimeout(() => {
    scanRecruitmentInbox().catch(e => console.warn('[Recruitment Scan Initial]', e.message));
  }, 3000);

  return { email: hiringEmail, success: true };
}

/**
 * Get authenticated Gmail client for Recruitment Inbox
 */
export async function getAuthenticatedRecruitmentGmailClient() {
  const rows = await query('SELECT * FROM recruitment_tokens ORDER BY updated_at DESC LIMIT 1');
  if (!rows || rows.length === 0) {
    return null;
  }

  const tokenRecord = rows[0];
  const oauth2Client = await getRecruitmentOAuth2Client();
  if (!oauth2Client) return null;

  oauth2Client.setCredentials({
    refresh_token: tokenRecord.refresh_token,
    access_token: tokenRecord.access_token,
    expiry_date: tokenRecord.expiry_date
  });

  oauth2Client.on('tokens', async (newTokens) => {
    try {
      await query(
        `UPDATE recruitment_tokens SET
          access_token = ?,
          expiry_date = ?,
          refresh_token = COALESCE(?, refresh_token),
          updated_at = CURRENT_TIMESTAMP
         WHERE email = ?`,
        [newTokens.access_token, newTokens.expiry_date || 0, newTokens.refresh_token || null, tokenRecord.email]
      );
    } catch (e) {
      console.error('[Recruitment] Token refresh DB update error:', e.message);
    }
  });

  return {
    gmail: google.gmail({ version: 'v1', auth: oauth2Client }),
    email: tokenRecord.email
  };
}

/**
 * Disconnect Recruitment Gmail account
 */
export async function disconnectRecruitmentGmail() {
  await query('DELETE FROM recruitment_tokens');
  await setRecruitmentSetting('RECRUITMENT_EMAIL', '');
  await logActivity('RECRUITMENT', 'Hiring Gmail account disconnected', 'INFO');
  return { success: true };
}

/**
 * Get overall recruitment status, mailbox connection, and stats
 */
export async function getRecruitmentStatus() {
  const tokenRows = await query('SELECT email, expiry_date, updated_at FROM recruitment_tokens ORDER BY updated_at DESC LIMIT 1');
  const isGmailConnected = tokenRows && tokenRows.length > 0;
  const hiringEmail = isGmailConnected ? tokenRows[0].email : null;

  const settings = await getAllRecruitmentSettings();

  // Application statistics
  const [totalApps] = await query('SELECT COUNT(*) as cnt FROM candidate_applications');
  const [sentCount] = await query("SELECT COUNT(*) as cnt FROM candidate_applications WHERE confirmation_status = 'SENT'");
  const [pendingCount] = await query("SELECT COUNT(*) as cnt FROM candidate_applications WHERE confirmation_status = 'PENDING'");
  const [failedCount] = await query("SELECT COUNT(*) as cnt FROM candidate_applications WHERE confirmation_status = 'FAILED'");

  return {
    gmailConnected: isGmailConnected,
    hiringEmail,
    tokenExpiry: isGmailConnected ? tokenRows[0].expiry_date : null,
    dispatchMethod: settings.dispatch_method || 'gmail',
    autoReplyEnabled: settings.auto_reply_enabled === 'true',
    smtpConfigured: !!(settings.smtp_host && settings.smtp_user),
    stats: {
      total: totalApps ? totalApps.cnt : 0,
      sent: sentCount ? sentCount.cnt : 0,
      pending: pendingCount ? pendingCount.cnt : 0,
      failed: failedCount ? failedCount.cnt : 0
    }
  };
}

/**
 * Test SMTP connection and optional test dispatch
 */
export async function testSmtpConnection({ host, port, secure, user, pass, fromEmail, fromName, testRecipient }) {
  if (!host || !user || !pass) {
    return { success: false, error: 'SMTP Host, User and Password are required' };
  }

  const isSecure = secure === true || secure === 'true' || parseInt(port) === 465;
  const transporter = nodemailer.createTransport({
    host: host.trim(),
    port: parseInt(port) || 587,
    secure: isSecure,
    auth: {
      user: user.trim(),
      pass: pass.trim()
    },
    tls: {
      rejectUnauthorized: false
    }
  });

  try {
    await transporter.verify();

    if (testRecipient && testRecipient.includes('@')) {
      const sender = `"${fromName || 'JECRC Recruitment Office'}" <${fromEmail || user}>`;
      await transporter.sendMail({
        from: sender,
        to: testRecipient.trim(),
        subject: 'JECRC Recruitment Automation - SMTP Connection Test Successful',
        text: `This is a test email sent from the JECRC Recruitment Automation Portal.\n\nYour SMTP configuration (${host}:${port}) is working perfectly!`
      });
    }

    return {
      success: true,
      message: 'SMTP server connection verified successfully! Ready for dynamic dispatch.'
    };
  } catch (err) {
    return {
      success: false,
      error: `SMTP Verification failed: ${err.message}`
    };
  }
}

/**
 * Send confirmation email via configured method (Gmail OAuth or Custom SMTP)
 */
export async function sendConfirmationEmail({ candidateEmail, candidateName, appliedPost, applicationId }) {
  const settings = await getAllRecruitmentSettings();
  const dispatchMethod = (settings.dispatch_method || 'gmail').toLowerCase();

  const formattedDate = new Date().toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });

  // Dynamic template tag substitution
  const replaceTags = (text) => {
    return (text || '')
      .replace(/{candidate_name}/gi, candidateName || 'Candidate')
      .replace(/{applied_post}/gi, appliedPost || 'Applicant')
      .replace(/{application_id}/gi, applicationId || 'JECRC-REC-001')
      .replace(/{received_date}/gi, formattedDate)
      .replace(/{university_name}/gi, 'JECRC University');
  };

  const subject = replaceTags(settings.email_subject_template);
  const bodyText = replaceTags(settings.email_body_template);

  if (dispatchMethod === 'smtp') {
    // === METHOD 1: DYNAMIC CUSTOM SMTP ===
    if (!settings.smtp_host || !settings.smtp_user || !settings.smtp_pass) {
      throw new Error('SMTP Dispatch is selected, but SMTP Host, Username or Password is not configured in settings.');
    }

    const isSecure = settings.smtp_secure === 'true' || parseInt(settings.smtp_port) === 465;
    const transporter = nodemailer.createTransport({
      host: settings.smtp_host.trim(),
      port: parseInt(settings.smtp_port) || 587,
      secure: isSecure,
      auth: {
        user: settings.smtp_user.trim(),
        pass: settings.smtp_pass.trim()
      },
      tls: {
        rejectUnauthorized: false
      }
    });

    const sender = `"${settings.smtp_from_name || 'JECRC Recruitment Office'}" <${settings.smtp_from_email || settings.smtp_user}>`;

    const info = await transporter.sendMail({
      from: sender,
      to: candidateEmail,
      subject,
      text: bodyText
    });

    await logActivity('RECRUITMENT', `Confirmation sent via SMTP to ${candidateEmail} for ${appliedPost}`, 'INFO', { messageId: info.messageId });
    return {
      success: true,
      method: 'SMTP',
      messageId: info.messageId,
      sentAt: new Date()
    };
  } else {
    // === METHOD 2: GOOGLE GMAIL OAUTH ===
    const authClient = await getAuthenticatedRecruitmentGmailClient();
    if (!authClient) {
      throw new Error('Gmail OAuth Dispatch is selected, but Recruitment Gmail account is not connected.');
    }

    const { gmail, email: senderEmail } = authClient;

    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
    const messageParts = [
      `From: "JECRC Recruitment Office" <${senderEmail}>`,
      `To: <${candidateEmail}>`,
      'Content-Type: text/plain; charset=utf-8',
      'MIME-Version: 1.0',
      `Subject: ${utf8Subject}`,
      '',
      bodyText
    ];
    const rawMessage = messageParts.join('\r\n');
    const encodedMessage = Buffer.from(rawMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedMessage }
    });

    await logActivity('RECRUITMENT', `Confirmation sent via Gmail OAuth to ${candidateEmail} for ${appliedPost}`, 'INFO', { messageId: res.data.id });
    return {
      success: true,
      method: 'GMAIL_OAUTH',
      messageId: res.data.id,
      sentAt: new Date()
    };
  }
}

/**
 * Use Gemini AI to parse incoming email and resume details
 */
async function parseCandidateDetailsWithGemini(emailData) {
  const { senderEmail, senderName, subject, snippet, bodyText, attachmentNames } = emailData;

  const fallbackResult = {
    is_job_application: false,
    candidate_name: senderName || senderEmail.split('@')[0],
    applied_post: extractPostHeuristic(subject, bodyText) || 'Faculty / Staff Applicant',
    candidate_phone: '',
    experience_years: '',
    skills: '',
    ai_summary: `Email from ${senderName || senderEmail}`
  };

  // Immediate negative check for bank statements, invoices, alerts
  const isBankOrFinance = /(bank|statement|e-statement|account\s+statement|invoice|receipt|pnb|hdfc|sbi|icici|axis|kotak|rbi|otp\b|credit\s+card|transaction)/i.test(`${senderEmail} ${subject} ${attachmentNames.join(' ')}`);
  if (isBankOrFinance) {
    return { ...fallbackResult, is_job_application: false };
  }

  const client = await getGeminiClient();
  if (!client) {
    return fallbackResult;
  }

  const prompt = `You are an AI Recruitment Officer for JECRC University.
Analyze the following incoming email and its attachments to extract candidate application data.

CRITICAL INSTRUCTIONS:
- If this email is a bank statement, financial alert, e-statement, bill, invoice, OTP, newsletter, receipt, or any personal non-hiring email, you MUST respond with "is_job_application": false.
- ONLY mark "is_job_application": true if the sender is legitimately applying for a job, faculty position, teaching role, research fellowship, staff vacancy, or submitting their personal resume/CV for employment.

Email Sender: ${senderName} <${senderEmail}>
Email Subject: ${subject}
Attachment Filenames: ${attachmentNames.join(', ') || 'None'}
Email Snippet: ${snippet}
Email Body (Excerpt):
${(bodyText || snippet || '').substring(0, 1500)}

Determine:
1. Is this a legitimate job application / CV submission for university employment? (true or false)
2. Candidate's full name.
3. The specific post / position / department applied for (e.g., "Assistant Professor - CSE", "Professor - Mechanical", "Lab Assistant", "Research Fellow", etc.). If not explicitly stated, infer from subject/body or default to "Faculty / Staff Applicant".
4. Contact phone number if present.
5. Years of experience if mentioned.
6. Key skills or core qualifications (comma-separated, max 6 items).
7. A concise 1-2 sentence executive summary of the candidate's application.

Respond ONLY with valid JSON in this exact structure:
{
  "is_job_application": false,
  "candidate_name": "Full Name",
  "applied_post": "Position Title",
  "candidate_phone": "Phone or empty",
  "experience_years": "Experience or empty",
  "skills": "Skill 1, Skill 2, Skill 3",
  "ai_summary": "1-2 sentence summary"
}`;

  try {
    const response = await callGeminiWithFallback(client, {
      contents: prompt,
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1
      }
    });

    const raw = typeof response.text === 'function' ? response.text() : (response.text || '');
    const cleanJson = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanJson);

    return {
      is_job_application: parsed.is_job_application === true,
      candidate_name: parsed.candidate_name || fallbackResult.candidate_name,
      applied_post: parsed.applied_post || fallbackResult.applied_post,
      candidate_phone: parsed.candidate_phone || '',
      experience_years: parsed.experience_years || '',
      skills: parsed.skills || '',
      ai_summary: parsed.ai_summary || fallbackResult.ai_summary
    };
  } catch (err) {
    console.warn('[Recruitment Gemini] Parsing exception, using fallback:', err.message);
    return fallbackResult;
  }
}

function extractPostHeuristic(subject = '', body = '') {
  const combined = `${subject} ${body}`.toLowerCase();
  if (combined.includes('assistant professor')) return 'Assistant Professor';
  if (combined.includes('associate professor')) return 'Associate Professor';
  if (combined.includes('professor')) return 'Professor';
  if (combined.includes('lecturer')) return 'Lecturer';
  if (combined.includes('lab assistant') || combined.includes('lab technician')) return 'Lab Assistant';
  if (combined.includes('research fellow') || combined.includes('jrf')) return 'Junior Research Fellow (JRF)';
  if (combined.includes('software engineer') || combined.includes('developer')) return 'Software Developer / IT';
  if (combined.includes('trainer') || combined.includes('instructor')) return 'Technical Trainer';
  if (combined.includes('data analyst')) return 'Data Analyst';
  if (combined.includes('accountant') || combined.includes('finance')) return 'Accounts & Finance Officer';
  if (combined.includes('hr') || combined.includes('human resource')) return 'HR Executive';
  return '';
}

/**
 * Scan recruitment Gmail inbox for new incoming resumes/CVs
 */
export async function scanRecruitmentInbox() {
  if (isScanningActive) {
    return { status: 'busy', message: 'A scan is already in progress.' };
  }

  const authClient = await getAuthenticatedRecruitmentGmailClient();
  if (!authClient) {
    return { status: 'not_connected', message: 'Hiring Gmail account is not connected.' };
  }

  isScanningActive = true;
  const { gmail } = authClient;
  const myConnectedEmail = (authClient.email || '').toLowerCase().trim();
  let processedCount = 0;

  try {
    // Clean up any historical self-reply or bank statement entries
    await query(
      `DELETE FROM candidate_applications WHERE 
        candidate_email = ? OR 
        candidate_email LIKE '%pnb%' OR 
        candidate_email LIKE '%estatement%' OR 
        email_subject LIKE '%statement%' OR 
        email_subject LIKE '%bank%'`,
      [myConnectedEmail]
    );

    // Search recent unread messages or messages from past 2 days
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread OR newer_than:2d',
      maxResults: 35
    });

    const messages = listRes.data.messages || [];
    if (messages.length === 0) {
      isScanningActive = false;
      return { status: 'idle', count: 0, message: 'No new unread emails found in hiring mailbox.' };
    }

    const settings = await getAllRecruitmentSettings();
    const autoReply = settings.auto_reply_enabled === 'true';

    for (const msg of messages) {
      // 1. Check if already processed
      const existing = await query('SELECT id FROM candidate_applications WHERE gmail_message_id = ? LIMIT 1', [msg.id]);
      if (existing && existing.length > 0) {
        continue;
      }

      // 2. Fetch full message
      const msgRes = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full'
      });

      const messageData = msgRes.data;
      const labelIds = messageData.labelIds || [];

      // STRICT CHECK: Skip our own sent messages and drafts
      if (labelIds.includes('SENT') || labelIds.includes('DRAFT')) {
        continue;
      }

      const headers = messageData.payload?.headers || [];
      const fromHeader = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
      const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '(No Subject)';
      const dateHeader = headers.find(h => h.name.toLowerCase() === 'date')?.value || new Date().toISOString();

      // Extract sender name and clean email
      let senderEmail = '';
      let senderName = '';
      const emailMatch = fromHeader.match(/<([^>]+)>/);
      if (emailMatch) {
        senderEmail = emailMatch[1].trim().toLowerCase();
        senderName = fromHeader.replace(/<[^>]+>/, '').replace(/["']/g, '').trim();
      } else {
        senderEmail = fromHeader.trim().toLowerCase();
        senderName = senderEmail.split('@')[0];
      }

      // STRICT CHECK: NEVER process emails sent from our own address (prevent self-reply loops)
      if (senderEmail === myConnectedEmail || fromHeader.toLowerCase().includes(myConnectedEmail)) {
        continue;
      }

      // STRICT CHECK: Exclude automated senders, bank statements, bills, receipts, OTPs
      const isAutomatedOrFinance = 
        /^(no-?reply|donotreply|statements?|estatements?|alert|notification|mailer-daemon|postmaster|billing|invoice|bank|promo|updates?|news(letter)?)@/i.test(senderEmail) ||
        /(pnb|hdfc|icici|sbi|axis|kotak|bank|statement|invoice|receipt|order|payment|transaction|bill)/i.test(senderEmail) ||
        /(statement|invoice|receipt|bill|account\s+statement|e-statement|credit\s+card|transaction\s+alert|otp\b|pnb|passbook)/i.test(subject);

      if (isAutomatedOrFinance) {
        continue;
      }

      // Inspect attachments & body
      const attachments = [];
      let bodyText = messageData.snippet || '';

      function parseParts(parts) {
        if (!parts) return;
        for (const part of parts) {
          if (part.filename && part.filename.length > 0) {
            attachments.push({
              filename: part.filename,
              mimeType: part.mimeType,
              attachmentId: part.body?.attachmentId,
              size: part.body?.size
            });
          }
          if (part.mimeType === 'text/plain' && part.body?.data) {
            bodyText += ' ' + Buffer.from(part.body.data, 'base64').toString('utf8');
          }
          if (part.parts) {
            parseParts(part.parts);
          }
        }
      }

      if (messageData.payload?.parts) {
        parseParts(messageData.payload.parts);
      }

      const attachmentNames = attachments.map(a => a.filename);
      const hasResumeExtension = attachmentNames.some(fn => /\.(pdf|doc|docx|rtf)$/i.test(fn));
      const filenameLooksLikeResume = attachmentNames.some(fn => /(resume|cv|biodata|bio-data|curriculum|application|profile)/i.test(fn));
      const textMentionsJob = /(resume|cv|curriculum\s+vitae|applying\s+for|application\s+for|job\s+application|faculty\s+position|assistant\s+professor|associate\s+professor|professor|lecturer|job\s+opening|vacancy|hiring|candidate)/i.test(`${subject} ${bodyText}`);

      // Must have resume attachment or mention job application in text
      if (!hasResumeExtension && !textMentionsJob) {
        continue;
      }

      // Parse with Gemini
      const candidateInfo = await parseCandidateDetailsWithGemini({
        senderEmail,
        senderName,
        subject,
        snippet: messageData.snippet || '',
        bodyText,
        attachmentNames
      });

      // STRICT: Must be confirmed as a job application by Gemini
      if (!candidateInfo.is_job_application) {
        continue;
      }

      // Generate unique application ID
      const appId = `JECRC-HR-${Date.now().toString().slice(-5)}${Math.floor(10 + Math.random() * 90)}`;

      // Check if candidate was already confirmed recently (within 7 days) to prevent spamming
      const alreadyConfirmed = await query(
        "SELECT id FROM candidate_applications WHERE candidate_email = ? AND confirmation_status = 'SENT' AND created_at > NOW() - INTERVAL 7 DAY LIMIT 1",
        [senderEmail]
      );
      const shouldDispatch = autoReply && (!alreadyConfirmed || alreadyConfirmed.length === 0);

      // Insert record
      await query(
        `INSERT INTO candidate_applications (
          application_id, gmail_message_id, candidate_email, candidate_name, candidate_phone,
          applied_post, experience_years, skills, ai_summary, has_resume_attachment,
          resume_filenames, confirmation_status, email_subject, email_snippet, email_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)
        ON DUPLICATE KEY UPDATE updated_at = NOW()`,
        [
          appId,
          msg.id,
          senderEmail,
          candidateInfo.candidate_name,
          candidateInfo.candidate_phone,
          candidateInfo.applied_post,
          candidateInfo.experience_years,
          candidateInfo.skills,
          candidateInfo.ai_summary,
          hasResumeExtension ? 1 : 0,
          attachmentNames.join(', '),
          subject,
          messageData.snippet || '',
          dateHeader
        ]
      );

      processedCount++;

      // Dispatch confirmation
      if (shouldDispatch) {
        try {
          const dispatchResult = await sendConfirmationEmail({
            candidateEmail: senderEmail,
            candidateName: candidateInfo.candidate_name,
            appliedPost: candidateInfo.applied_post,
            applicationId: appId
          });

          await query(
            `UPDATE candidate_applications SET
              confirmation_status = 'SENT',
              confirmation_method = ?,
              confirmation_sent_at = NOW(),
              confirmation_error = NULL
             WHERE application_id = ?`,
            [dispatchResult.method, appId]
          );
        } catch (dispatchErr) {
          console.error(`[Recruitment Dispatch Error] To ${senderEmail}:`, dispatchErr.message);
          await query(
            `UPDATE candidate_applications SET
              confirmation_status = 'FAILED',
              confirmation_error = ?
             WHERE application_id = ?`,
            [dispatchErr.message.substring(0, 500), appId]
          );
        }
      } else if (!autoReply) {
        // Auto-reply disabled in settings
      } else {
        // Confirmation skipped because already sent in last 7 days
        await query(
          `UPDATE candidate_applications SET
            confirmation_status = 'SKIPPED',
            confirmation_error = 'Duplicate application within 7 days. Confirmation already sent.'
           WHERE application_id = ?`,
          [appId]
        );
      }

      // Ensure the email remains UNREAD in Gmail
      try {
        await gmail.users.messages.modify({
          userId: 'me',
          id: msg.id,
          requestBody: {
            addLabelIds: ['UNREAD']
          }
        });
      } catch (labelErr) {}
    }

    return {
      status: 'success',
      count: processedCount,
      message: `Scan finished. Processed ${processedCount} new candidate application(s).`
    };
  } catch (err) {
    console.error('[Recruitment Scan Error]:', err.message);
    return { status: 'error', error: err.message };
  } finally {
    isScanningActive = false;
  }
}

/**
 * Start periodic inbox polling engine (every 60 seconds)
 */
export function startRecruitmentPollingEngine() {
  if (pollingIntervalHandle) {
    clearInterval(pollingIntervalHandle);
  }

  // Initial trigger after 10s
  setTimeout(() => {
    scanRecruitmentInbox().catch(err => console.warn('[Recruitment Poller Initial]', err.message));
  }, 10000);

  // Poll every 60 seconds (1 minute) for instant auto-detection of incoming emails
  pollingIntervalHandle = setInterval(() => {
    scanRecruitmentInbox().catch(err => console.warn('[Recruitment Poller Interval]', err.message));
  }, 60000);

  console.log('[Recruitment] Automated resume email scanner initialized (interval: 60s)');
}
