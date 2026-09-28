import { google } from 'googleapis';
import { query, getSetting, setSetting, logActivity } from '../database/db.js';
import dotenv from 'dotenv';
dotenv.config();

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

export async function getOAuth2Client() {
  const clientId = (await getSetting('GOOGLE_CLIENT_ID')) || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = (await getSetting('GOOGLE_CLIENT_SECRET')) || process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = (await getSetting('GOOGLE_REDIRECT_URI')) || process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

  if (!clientId || !clientSecret) {
    return null;
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Generates the Google Sign-In / OAuth consent URL for the Director
 */
export async function getAuthUrl() {
  const oauth2Client = await getOAuth2Client();
  if (!oauth2Client) {
    throw new Error('Google OAuth credentials (Client ID and Secret) are not configured.');
  }

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
  });
}

/**
 * Handles the OAuth2 code callback, stores refresh token in MySQL
 */
export async function handleOAuthCallback(code) {
  const oauth2Client = await getOAuth2Client();
  if (!oauth2Client) throw new Error('OAuth2 client not initialized');

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // Get user's email address
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const userInfo = await oauth2.userinfo.get();
  const directorEmail = userInfo.data.email;

  // Save tokens in MySQL
  await query(
    `INSERT INTO google_tokens (email, refresh_token, access_token, expiry_date, scope)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       refresh_token = COALESCE(VALUES(refresh_token), refresh_token),
       access_token = VALUES(access_token),
       expiry_date = VALUES(expiry_date),
       scope = VALUES(scope),
       updated_at = CURRENT_TIMESTAMP`,
    [
      directorEmail,
      tokens.refresh_token || null,
      tokens.access_token,
      tokens.expiry_date || 0,
      tokens.scope || SCOPES.join(' ')
    ]
  );

  await setSetting('DIRECTOR_EMAIL', directorEmail);
  await logActivity('GMAIL', `Director Gmail connected successfully: ${directorEmail}`, 'INFO');
  return { email: directorEmail, success: true };
}

/**
 * Retrieves authenticated Gmail instance using stored tokens
 */
export async function getAuthenticatedGmail() {
  const oauth2Client = await getOAuth2Client();
  if (!oauth2Client) return null;

  const rows = await query('SELECT * FROM google_tokens ORDER BY id DESC LIMIT 1');
  if (rows.length === 0) return null;

  const tokenRecord = rows[0];
  oauth2Client.setCredentials({
    refresh_token: tokenRecord.refresh_token,
    access_token: tokenRecord.access_token,
    expiry_date: tokenRecord.expiry_date
  });

  // Listen for refresh token events to update MySQL automatically
  oauth2Client.on('tokens', async (newTokens) => {
    if (newTokens.access_token) {
      await query(
        `UPDATE google_tokens SET access_token = ?, expiry_date = ? WHERE id = ?`,
        [newTokens.access_token, newTokens.expiry_date || 0, tokenRecord.id]
      );
    }
  });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

/**
 * Fetches recent emails from Director's inbox (both unread and recently read)
 */
export async function fetchUnreadEmails(limit = 15, unreadOnly = false) {
  const gmail = await getAuthenticatedGmail();
  if (!gmail) {
    return [];
  }

  try {
    const queryFilter = unreadOnly 
      ? 'is:unread -category:promotions -category:social' 
      : '-category:promotions -category:social';

    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: queryFilter,
      maxResults: limit
    });

    const messages = listRes.data.messages || [];
    return await parseGmailMessageList(gmail, messages);
  } catch (error) {
    console.error('[Gmail Service] Failed to fetch emails:', error.message);
    logActivity('GMAIL', `Failed to fetch emails: ${error.message}`, 'ERROR');
    return [];
  }
}

/**
 * Searches Gmail directly with a keyword query across ALL messages (read and unread)
 */
export async function searchGmail(searchQuery, limit = 10) {
  const gmail = await getAuthenticatedGmail();
  if (!gmail || !searchQuery) {
    return [];
  }

  try {
    console.log(`[Gmail API] Searching inbox for: "${searchQuery}"...`);
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: searchQuery,
      maxResults: limit
    });

    const messages = listRes.data.messages || [];
    const results = await parseGmailMessageList(gmail, messages);
    console.log(`[Gmail API] Search for "${searchQuery}" returned ${results.length} email(s)`);
    return results;
  } catch (error) {
    console.error('[Gmail Service] Search error:', error.message);
    return [];
  }
}

/**
 * Helper to fetch full details for a list of Gmail message IDs
 */
async function parseGmailMessageList(gmail, messages) {
  const parsedEmails = [];

  for (const msg of messages) {
    try {
      const details = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full'
      });

      const headers = details.data.payload?.headers || [];
      const getHeader = (name) => {
        const found = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
        return found ? found.value : '';
      };

      const from = getHeader('From');
      const subject = getHeader('Subject') || '(No Subject)';
      const date = getHeader('Date');
      const snippet = details.data.snippet || '';

      // Extract sender name and clean email
      let senderName = from;
      let senderEmail = from;
      const match = from.match(/(.*)<(.*)>/);
      if (match) {
        senderName = match[1].replace(/["']/g, '').trim();
        senderEmail = match[2].trim();
      }

      parsedEmails.push({
        id: msg.id,
        threadId: details.data.threadId,
        from: senderName || senderEmail,
        senderEmail,
        senderName,
        subject,
        snippet,
        date
      });
    } catch (e) {
      console.warn(`[Gmail Service] Could not fetch message ${msg.id}:`, e.message);
    }
  }

  return parsedEmails;
}

/**
 * Sends an email on Director's behalf after verification
 */
export async function sendVerifiedEmail({ to, subject, body, draftId = null }) {
  const gmail = await getAuthenticatedGmail();
  if (!gmail) {
    throw new Error('Director Gmail is not connected. Cannot send email.');
  }

  const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const messageParts = [
    `To: ${to}`,
    `Subject: ${utf8Subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    body
  ];
  const rawMessage = messageParts.join('\r\n');
  const encodedMessage = Buffer.from(rawMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedMessage
    }
  });

  if (draftId) {
    await query(
      `UPDATE email_drafts SET status = 'VERIFIED_SENT', sent_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [draftId]
    );
  }

  await logActivity('GMAIL', `Verified email sent to ${to}: "${subject}"`, 'INFO', { to, subject });
  return res.data;
}

/**
 * Gets Gmail Connector status
 */
export async function getGmailStatus() {
  const rows = await query('SELECT email, updated_at FROM google_tokens ORDER BY id DESC LIMIT 1');
  if (rows.length > 0) {
    return {
      connected: true,
      email: rows[0].email,
      lastSync: rows[0].updated_at
    };
  }
  return {
    connected: false,
    email: null,
    lastSync: null
  };
}

export async function disconnectGmail() {
  await query('DELETE FROM google_tokens');
  await query('DELETE FROM system_settings WHERE key_name = "DIRECTOR_EMAIL"');
  await logActivity('GMAIL', 'Director Gmail disconnected/unlinked via Dashboard', 'WARN');
  return true;
}
