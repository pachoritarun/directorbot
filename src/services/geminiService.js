import { GoogleGenAI } from '@google/genai';
import { getSetting, logActivity } from '../database/db.js';
import dotenv from 'dotenv';
dotenv.config();

let aiClient = null;

export async function getGeminiModel() {
  const dbModel = await getSetting('GEMINI_MODEL');
  const chosenModel = dbModel || process.env.GEMINI_MODEL || 'gemini-3.7-flash';
  return chosenModel;
}

export async function getGeminiClient() {
  const dbKey = await getSetting('GEMINI_API_KEY');
  const apiKey = dbKey || process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return null;
  }

  if (!aiClient || aiClient.apiKey !== apiKey) {
    aiClient = new GoogleGenAI({ apiKey });
    aiClient.apiKey = apiKey;
  }
  return aiClient;
}

/**
 * Robust wrapper that calls Gemini with automatic fallback models on 503 or overload spikes
 */
export async function callGeminiWithFallback(client, options) {
  const primaryModel = (await getGeminiModel()) || 'gemini-3.7-flash';
  const candidates = [primaryModel, 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-flash-latest'];
  const models = [...new Set(candidates)];
  let lastErr = null;

  for (const m of models) {
    try {
      const res = await client.models.generateContent({
        ...options,
        model: m
      });
      return res;
    } catch (err) {
      console.warn(`[Gemini] Model ${m} spike/error: ${err.message.slice(0, 90)}. Trying fallback...`);
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Analyzes unread/recent emails and categorizes them with AI
 */
export async function analyzeEmails(emails) {
  if (!emails || emails.length === 0) return [];
  const client = await getGeminiClient();
  if (!client) {
    console.warn('[Gemini] API Key not set. Returning basic email summaries.');
    return emails.map(e => ({
      ...e,
      priority: 'Normal',
      summary: e.snippet || 'No summary available.',
      action_required: 'None specified.'
    }));
  }

  try {
    const prompt = `
You are the Executive Chief of Staff and AI Personal Assistant to the Director of a premier University.
Analyze the following emails received by the Director.
Filter out routine marketing, spam, newsletters, or generic automated messages.
For genuine emails (from faculty, students, Vice Chancellor, Ministry/AICTE/UGC, industry partners, dignitaries), provide:
1. Priority: One of ['Urgent', 'High', 'Normal', 'Spam']
2. Summary: 1-2 sharp, executive bullet points in professional English.
3. Action Required: Clear actionable point for the Director (e.g., "Approve MoU by 3 PM", "Delegate to Dean Academics", "No action needed").

Emails Data:
${JSON.stringify(emails.map(e => ({
  id: e.id,
  from: e.from,
  subject: e.subject,
  date: e.date,
  bodySnippet: (e.body || e.snippet || '').substring(0, 800)
})), null, 2)}

Return your response strictly as valid JSON array of objects with the following keys:
[
  {
    "id": "email_id_here",
    "priority": "Urgent" | "High" | "Normal" | "Spam",
    "summary": "Executive summary text",
    "action_required": "Action item text"
  }
]
`;

    const response = await callGeminiWithFallback(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const rawText = typeof response.text === 'function' ? response.text() : (response.text || '');
    const cleanText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanText);
    
    // Merge back with original email metadata
    return emails.map(email => {
      const aiData = parsed.find(p => p.id === email.id) || {};
      return {
        ...email,
        priority: aiData.priority || 'Normal',
        summary: aiData.summary || email.snippet || 'No summary',
        action_required: aiData.action_required || 'Review email'
      };
    });
  } catch (error) {
    console.error('[Gemini] Email analysis error:', error.message);
    logActivity('GEMINI', `Email analysis failed: ${error.message}`, 'ERROR');
    return emails.map(e => ({
      ...e,
      priority: 'Normal',
      summary: e.snippet || '',
      action_required: 'Review required'
    }));
  }
}

/**
 * Summarizes silent WhatsApp messages received by Director's account
 */
export async function summarizeWhatsAppChats(chats) {
  if (!chats || chats.length === 0) return { highlights: [], count: 0 };
  const client = await getGeminiClient();
  if (!client) {
    return {
      highlights: chats.slice(0, 5).map(c => `${c.sender_name || c.sender_phone}: ${c.message_text}`),
      count: chats.length
    };
  }

  try {
    const prompt = `
You are the Executive Chief of Staff for a University Director.
Review the following incoming WhatsApp messages received on the Director's phone.
Identify which ones are urgent (students, HODs, urgent requests, official meetings, VIP messages).
Ignore casual greetings, generic forwards, or spam.

Messages:
${JSON.stringify(chats.map(c => ({
  sender: c.sender_name || c.sender_phone,
  phone: c.sender_phone,
  message: c.message_text,
  time: new Date(c.timestamp * 1000).toLocaleTimeString()
})), null, 2)}

Provide:
1. An executive bulleted summary (in English/Hinglish as appropriate) of critical matters that need Director's attention or reply.
2. Flag urgent senders who require a call or reply today.

Return strictly as JSON with this structure:
{
  "urgent_alerts": ["Alert 1", "Alert 2"],
  "summary_points": ["Point 1", "Point 2"],
  "unanswered_contacts": [{"name": "Tarun", "issue": "Meeting request for 4 PM"}]
}
`;

    const response = await callGeminiWithFallback(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const rawText = typeof response.text === 'function' ? response.text() : (response.text || '');
    const cleanText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanText);
    return parsed;
  } catch (error) {
    console.error('[Gemini] WhatsApp summary error:', error.message);
    return {
      urgent_alerts: [],
      summary_points: chats.slice(0, 5).map(c => `${c.sender_name}: ${c.message_text}`),
      unanswered_contacts: []
    };
  }
}

/**
 * Fetches top 3-4 trending EdTech & Higher Education AI developments
 */
export async function getEdTechAndAiNews() {
  const client = await getGeminiClient();
  const defaultNews = [
    {
      title: "Agentic AI in Higher Education Curricula",
      source: "EdTech Global & NEP 2020 Insights",
      takeaway: "Top universities integrating autonomous AI workflows into engineering and management pedagogy for industry alignment."
    },
    {
      title: "UGC / AICTE Framework on Generative AI & Academic Integrity",
      source: "Regulatory Updates",
      takeaway: "New institutional guidelines on ethical AI adoption, intellectual property, and research publication compliance."
    },
    {
      title: "Campus-Wide Personalized Learning via LLM Tutors",
      source: "Higher Education Tech Review",
      takeaway: "Institutions reporting 25% improvement in foundational STEM courses through adaptive 24/7 AI teaching assistants."
    }
  ];

  if (!client) return defaultNews;

  try {
    const prompt = `
You are the Chief AI Strategic Advisor to a University Director.
Provide exactly 3 to 4 top-notch, highly relevant, and actionable EdTech & Artificial Intelligence news/trends that a University Director MUST know today.
Focus on:
1. Higher Education AI implementation & research funding.
2. NEP / UGC / AICTE policy advancements or global academic tech breakthroughs.
3. Student placement and industry-academia AI partnerships.

Format strictly as a JSON array:
[
  {
    "title": "Concise Headline",
    "source": "Credible Domain / Publication",
    "takeaway": "1-2 sentences on why this matters strategically to the Director and the university."
  }
]
`;

    const response = await callGeminiWithFallback(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const rawText = typeof response.text === 'function' ? response.text() : (response.text || '');
    const cleanText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(cleanText);
  } catch (error) {
    console.error('[Gemini] EdTech news generation error:', error.message);
    return defaultNews;
  }
}

/**
 * Handles natural language chat from Director or PA
 */
export async function handleDirectorChat(query, context = {}) {
  const client = await getGeminiClient();
  if (!client) {
    return "Gemini API key is not configured yet. Please configure it in the Web Dashboard Settings.";
  }

  try {
    const prompt = `
You are the AI Executive Chief of Staff to the University Director.
You communicate respectfully, crisply, and efficiently (English or professional Hinglish matching Director's tone).

Current Context Available:
- Today's Itinerary/Schedules: ${JSON.stringify(context.schedules || [])}
- Recent WhatsApp Messages from Director's phone: ${JSON.stringify(context.whatsappMessages || [])}
- Recent Important Emails: ${JSON.stringify(context.recentEmails || [])}
- Emails Found via Live Gmail Search (Read & Unread): ${JSON.stringify(context.matchedEmails || [])}
- Pending Email Drafts: ${JSON.stringify(context.pendingDrafts || [])}

Director's Message / Query: "${query}"

Instructions:
1. If the Director asks to find or check emails regarding a person, entity, or topic (e.g. "IIT Bombay", "Techfest", etc.):
   - First check "Emails Found via Live Gmail Search" and "Recent Important Emails".
   - If any emails are present (even if marked read in Gmail), present them immediately: Sender Name/Email, Subject, Date, and Key Snippet/Summary.
   - If no emails are found in their personal inbox, state that no emails were found in their Gmail account, and then provide the official verified contact details (e.g. director@iitb.ac.in).
2. If the Director is asking about a person (e.g., "Tarun ne kya text kiya?"), check WhatsApp messages and give a concise summary.
3. If asking about schedule/meetings, present the timings clearly.
4. If the Director wants to reply to someone on WhatsApp (e.g. "Reply to Tarun: meet me at 4 PM"):
   Recognize the intent and specify an action block:
   [ACTION:WHATSAPP_REPLY | TO:recipient_name_or_phone | MESSAGE:reply_content]
5. If the Director wants to send an email (e.g. "Tarun ko email bhej do..."):
   NEVER say the email is already sent! Prepare the draft and tell the Director:
   "I have drafted the email. Please review the details below. Reply 'CONFIRM' to send or 'CANCEL' to discard."
   And include an action block:
   [ACTION:DRAFT_EMAIL | TO:recipient | SUBJECT:subject | BODY:body_content]
6. For general queries, answer directly with executive clarity.
`;

    const response = await callGeminiWithFallback(client, {
      contents: prompt
    });

    return typeof response.text === 'function' ? response.text() : (response.text || '');
  } catch (error) {
    console.error('[Gemini] Chat handling error:', error.message);
    return `Sir, I encountered an issue processing your request: ${error.message}`;
  }
}

/**
 * Drafts an executive email for Director's verification
 */
export async function draftExecutiveEmail(instruction, recipientEmail, recipientName = '') {
  const client = await getGeminiClient();
  if (!client) {
    return {
      subject: 'University Update',
      body: instruction
    };
  }

  try {
    const prompt = `
You are the University Director's executive assistant.
Write a polished, professional email based on this instruction: "${instruction}"
Recipient: ${recipientName} <${recipientEmail}>
Sign-off: Office of the Director, University

Return strictly as JSON:
{
  "subject": "Professional email subject line",
  "body": "Complete professional email body"
}
`;

    const response = await callGeminiWithFallback(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const rawText = typeof response.text === 'function' ? response.text() : (response.text || '');
    const cleanText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(cleanText);
  } catch (error) {
    console.error('[Gemini] Draft generation error:', error.message);
    return {
      subject: 'Message from Office of the Director',
      body: instruction
    };
  }
}
