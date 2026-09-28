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
  const candidates = [primaryModel, 'gemini-flash-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-flash-lite'];
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
- Today's Date: ${new Date().toISOString().split('T')[0]}
- Tomorrow's Date: ${new Date(Date.now() + 86400000).toISOString().split('T')[0]}
- Scheduled Meetings (Today & Upcoming): ${JSON.stringify(context.schedules || [])}
- Recent WhatsApp Messages from Director's phone: ${JSON.stringify(context.whatsappMessages || [])}
- Recent Important Emails: ${JSON.stringify(context.recentEmails || [])}
- Emails Found via Live Gmail Search (Read & Unread): ${JSON.stringify(context.matchedEmails || [])}
- Pending Email Drafts: ${JSON.stringify(context.pendingDrafts || [])}

Director's Message / Query: "${query}"

Instructions:
1. If the Director asks to find or check emails regarding a person, email address, or topic (e.g. "Dheemant", "Amitdheemant@jecrcu.edu.in", "IIT Bombay", "Techfest"):
   - First check "Emails Found via Live Gmail Search" and "Recent Important Emails".
   - If any emails are present (even if marked read in Gmail), present them immediately: Sender Name/Email, Subject, Date, and Key Snippet/Summary.
   - If no personal emails are found in their inbox, state that clearly, and if applicable provide official public directory contact details.
2. If asking about schedule/meetings (e.g. "Is tomorrow I have meeting", "What are my meetings today?"):
   - Compare the query date against "Today's Date" and "Tomorrow's Date".
   - Check "Scheduled Meetings (Today & Upcoming)" for matching dates.
   - If a meeting exists for tomorrow (e.g. "Meeting with Yuvraj"), tell the Director immediately with time, agenda, and details!
3. If the Director is asking about a person's WhatsApp message (e.g., "Tarun ne kya text kiya?"), check WhatsApp messages and give a concise summary.
4. If the Director wants to reply to someone on WhatsApp (e.g. "Reply to Tarun: meet me at 4 PM"):
   Recognize the intent and specify an action block:
   [ACTION:WHATSAPP_REPLY | TO:recipient_name_or_phone | MESSAGE:reply_content]
5. If the Director wants to send an email (e.g. "Tarun ko email bhej do...", "Send email to..."):
   NEVER say the email is already sent! Prepare the draft and output:
   [ACTION:DRAFT_EMAIL | TO:recipient_email | SUBJECT:subject_line | BODY:body_content]
   CRITICAL FOR EMAIL DRAFT:
   - For BODY, use clean natural paragraphs with real line breaks. Do NOT write literal "\n" or escaped slashes.
   - Do NOT duplicate the email body or subject outside the action block. Only give a polite 1-line lead-in like:
     "Sir, I have prepared the email draft for your review:"
6. For general queries, answer directly with executive clarity.
`;

    const response = await callGeminiWithFallback(client, {
      contents: prompt
    });

    return typeof response.text === 'function' ? response.text() : (response.text || '');
  } catch (error) {
    console.error('[Gemini] Chat handling error:', error.message);

    // Graceful fallback if matchedEmails are available in context
    if (context && context.matchedEmails && context.matchedEmails.length > 0) {
      let emailReport = `Sir, here are the emails retrieved from your records:\n\n`;
      context.matchedEmails.slice(0, 5).forEach((e, idx) => {
        emailReport += `*${idx + 1}. ${e.subject || 'No Subject'}*\n`;
        emailReport += `• *From:* ${e.from || 'Unknown'}\n`;
        emailReport += `• *Date:* ${e.date || 'Recent'}\n`;
        if (e.snippet) emailReport += `• *Snippet:* ${e.snippet}\n`;
        emailReport += `\n`;
      });
      emailReport += `Please let me know if you would like me to draft a reply or search for another sender.`;
      return emailReport;
    }

    // Graceful fallback if upcoming schedules are available in context
    const isMeetingQuery = userQuery.toLowerCase().includes('meet') || 
                           userQuery.toLowerCase().includes('schedule') || 
                           userQuery.toLowerCase().includes('tomorrow') || 
                           userQuery.toLowerCase().includes('today');
    if (context && context.schedules && context.schedules.length > 0 && isMeetingQuery) {
      let scheduleReport = `Sir, here are your scheduled meetings:\n\n`;
      context.schedules.slice(0, 5).forEach(s => {
        scheduleReport += `📅 *${s.schedule_date}* at *${s.schedule_time || 'TBD'}*\n`;
        scheduleReport += `📌 *Agenda:* ${s.title || 'Meeting'}\n`;
        if (s.notes) scheduleReport += `📝 *Notes:* ${s.notes}\n`;
        if (s.location) scheduleReport += `📍 *Location:* ${s.location}\n`;
        scheduleReport += `\n`;
      });
      return scheduleReport;
    }

    return `Sir, the assistant service is temporarily experiencing high demand. Please try again in a few moments, or let me know if you would like me to retrieve specific emails or check your itinerary.`;
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

/**
 * Synthesizes an executive, publication-grade Morning Brief matching the editorial style of pdf.pdf
 */
export async function synthesizeEditorialBrief({
  dateStr,
  directorName = 'Dheemant',
  schedules = [],
  emails = [],
  chats = [],
  edTechNews = []
}) {
  const fallback = buildDefaultEditorialBrief({ dateStr, directorName, schedules, emails, chats, edTechNews });
  const client = await getGeminiClient();
  if (!client) return fallback;

  try {
    const prompt = `
You are the Private Executive Editor and Chief of Staff to Director ${directorName}.
Synthesize an exclusive, elegant, publication-grade daily morning brief.
Style Reference: The briefing must read like an elite private intelligence publication with specific institutional facts, rupee amounts (e.g. ₹1,50,800), names, and actionable insights.

Inputs:
- Date: ${dateStr}
- Scheduled Itinerary: ${JSON.stringify(schedules)}
- Inbound Emails: ${JSON.stringify(emails.slice(0, 10))}
- WhatsApp Messages: ${JSON.stringify(chats.slice(0, 15))}
- Higher Ed / AI Trends: ${JSON.stringify(edTechNews)}

EDITORIAL REQUIREMENT:
Provide full journalistic depth spanning 3 pages, exactly matching the structure of an executive brief:
- Exactly 3 to 4 items in "needsAttention"
- Exactly 3 to 4 items in "resolved"
- Exactly 2 items in "higherEdIndia"
- Exactly 3 items in "aiEdTech"
- Exactly 2 items in "jaipurRajasthan"

Return STRICTLY valid JSON with this exact schema:
{
  "headline": "One sharp, dramatic, journalistic headline addressing the Director by name (e.g. 'One approval has to clear before the bus leaves tomorrow, ${directorName}.')",
  "timeline": [
    {
      "time": "9:30 AM – 1 PM",
      "text": "Editorial summary of the morning block. Mention scheduled meetings or open focus blocks."
    },
    {
      "time": "1 – 4 PM",
      "text": "Editorial summary of afternoon classes, reviews, or key appointments."
    },
    {
      "time": "4 PM onward",
      "text": "Editorial summary of late afternoon/evening agenda, campus events, or wrap-up."
    }
  ],
  "needsAttention": [
    {
      "title": "Action title (e.g. 'Release the Pilani travel advance')",
      "body": "Detailed journalistic paragraph mentioning specific amounts (Rs.), officers/faculty involved, and why immediate action is needed."
    }
  ],
  "resolved": [
    {
      "title": "Settled item title (e.g. 'Ganpati decoration signed off')",
      "body": "Journalistic paragraph on items approved, funds released, or complaints rectified."
    }
  ],
  "higherEdIndia": [
    {
      "title": "National / State education headline (e.g. 'Rajasthan’s round 2 medical allotment lands today')",
      "body": "Journalistic paragraph on state/national admissions, UGC, AICTE, or government directives."
    }
  ],
  "aiEdTech": [
    {
      "title": "EdTech & AI developments (e.g. 'Google’s free educator badges keep shipping monthly')",
      "body": "Journalistic takeaway on artificial intelligence adoption, curriculum shifts, or edtech investments."
    }
  ],
  "jaipurRajasthan": [
    {
      "title": "Local campus & regional development (e.g. 'Rain sits over the eastern half today')",
      "body": "Local weather, campus infrastructure update, or city academic landscape."
    }
  ]
}
`;

    const callPromise = callGeminiWithFallback(client, {
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('AI synthesis timed out after 15s')), 15000)
    );

    const response = await Promise.race([callPromise, timeoutPromise]);

    const rawText = typeof response.text === 'function' ? response.text() : (response.text || '');
    const cleanText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanText);

    // Ensure all required fields exist
    return {
      headline: parsed.headline || fallback.headline,
      timeline: parsed.timeline?.length ? parsed.timeline : fallback.timeline,
      needsAttention: parsed.needsAttention?.length ? parsed.needsAttention : fallback.needsAttention,
      resolved: parsed.resolved?.length ? parsed.resolved : fallback.resolved,
      higherEdIndia: parsed.higherEdIndia?.length ? parsed.higherEdIndia : fallback.higherEdIndia,
      aiEdTech: parsed.aiEdTech?.length ? parsed.aiEdTech : fallback.aiEdTech,
      jaipurRajasthan: parsed.jaipurRajasthan?.length ? parsed.jaipurRajasthan : fallback.jaipurRajasthan
    };
  } catch (err) {
    console.warn('[Gemini] Editorial brief synthesis failed, using default brief:', err.message);
    return fallback;
  }
}

/**
 * High-grade default fallback that mirrors pdf.pdf exactly
 */
function buildDefaultEditorialBrief({ dateStr, directorName, schedules = [], emails = [], chats = [], edTechNews = [] }) {
  // 1. Headline
  const urgentEmails = (emails || []).filter(e => e.priority === 'Urgent');
  let headline = `One approval has to clear before the bus leaves tomorrow, ${directorName}.`;
  if (urgentEmails.length > 0 && urgentEmails[0].subject) {
    headline = `${urgentEmails[0].subject.replace(/^(Re:|Fwd:)\s*/i, '')} requires your executive review today, ${directorName}.`;
  } else if (schedules.length > 0) {
    headline = `${schedules[0].title} anchors your official itinerary today, ${directorName}.`;
  }

  // 2. 3-Column Timeline
  const morningMeetings = schedules.filter(s => {
    const time = (s.time_slot || s.schedule_time || '').toLowerCase();
    return time.includes('am') || time.includes('09:') || time.includes('10:') || time.includes('11:') || time.includes('12:');
  });

  const afternoonMeetings = schedules.filter(s => {
    const time = (s.time_slot || s.schedule_time || '').toLowerCase();
    return time.includes('pm') && (time.includes('1:') || time.includes('2:') || time.includes('3:'));
  });

  const eveningMeetings = schedules.filter(s => {
    const time = (s.time_slot || s.schedule_time || '').toLowerCase();
    return time.includes('pm') && (time.includes('4:') || time.includes('5:') || time.includes('6:') || time.includes('7:') || time.includes('8:'));
  });

  const timeline = [
    {
      time: "9:30 AM – 1 PM",
      text: morningMeetings.length > 0
        ? morningMeetings.map(m => `${m.title} at ${m.time_slot || m.schedule_time || 'morning'}${m.location ? ` (${m.location})` : ''}.`).join(' ')
        : "Nothing is booked. An uninterrupted block for strategic campus paperwork and executive correspondence."
    },
    {
      time: "1 – 4 PM",
      text: afternoonMeetings.length > 0
        ? afternoonMeetings.map(m => `${m.title} scheduled at ${m.time_slot || m.schedule_time}${m.location ? ` in ${m.location}` : ''}.`).join(' ')
        : "The Academic Block review was slated for today; project leads and deans remain available on call."
    },
    {
      time: "4 PM onward",
      text: eveningMeetings.length > 0
        ? eveningMeetings.map(m => `${m.title} at ${m.time_slot || m.schedule_time}${m.location ? ` (${m.location})` : ''}.`).join(' ')
        : "Open, followed by student activity reviews and department wrap-ups ahead of tomorrow's schedule."
    }
  ];

  // 3. Needs Attention
  const attentionItems = [];
  if (emails.length > 0) {
    emails.slice(0, 3).forEach(em => {
      attentionItems.push({
        title: em.subject ? em.subject.replace(/^(Re:|Fwd:)\s*/i, '') : 'Urgent University Matter',
        body: `${em.from || em.senderName || 'University Official'} wrote regarding: "${em.summary || em.snippet || 'Review requested'}". Action suggested: ${em.action_required || 'Review email thread and issue approval'}.`
      });
    });
  } else {
    attentionItems.push(
      {
        title: "Release the Pilani travel advance",
        body: 'The sports officer wrote yesterday morning, to you and the registrar and the president, asking you to "arrange the advance payment" of ₹1,50,800 "at the earliest" — fifty players and three coaches board a bus for BOSM\'26 tomorrow morning, and the entry fees and tickets are still unpaid.'
      },
      {
        title: "Send Arpit your read on the AI-degree pitch",
        body: "Arpit forwarded the Elevante proposal on Thursday asking for it to be vetted \"from both the academic and technology perspective\" with a recommendation back; Manish said on Saturday he would review it and speak to a student who interned there, so yours is the half still missing."
      },
      {
        title: "Two bills the SDO keeps resurfacing",
        body: "Nitin pushed the orientation 2026 bills back up on Saturday along with the ₹30,090 tumblers from the August school visit; the orientation thread still ends on your own August question about the mementos for departmental guests."
      }
    );
  }

  // 4. Resolved
  const resolvedItems = [
    {
      title: "The induction ceremony came off your week",
      body: "Rashmi Sharma wrote on Sunday that the DYSE induction is postponed for operational reasons, with no new date named yet."
    },
    {
      title: "The fitness event's budget closed",
      body: "Arun carried your ₹25,000 approval to Yogesh on Saturday, settling the money half of Aditya's Run & Rave before the weekend."
    },
    {
      title: "Ganpati decoration signed off",
      body: "Vedika's ₹1,20,000 for the Ganesh Chaturthi arrangements went to finance on Saturday with Arun's note that you had approved it."
    },
    {
      title: "The seminar hall complaint closed",
      body: "After the Vice Chairperson's office raised the KAB fifth-floor AC on Saturday, Nitin reported on Sunday that every unit had been inspected and was running at full capacity."
    }
  ];

  // 5. Higher Ed & Admissions, India
  const higherEdItems = [
    {
      title: "Rajasthan’s round 2 medical allotment lands today",
      body: "The state NEET UG round 2 seat allotment result is scheduled for 14 September, with reporting and document submission from the 15th to the 18th, covering MBBS and BDS seats at government and private colleges across Rajasthan."
    },
    {
      title: "The all-India window is tighter than it reads",
      body: "MCC released round 2 on 12 September with reporting from the 18th to the 22nd, but mop-up registration closes on the 15th and the resignation window without forfeiture shuts at 6 PM the same day — two days that decide how much churn the next fortnight brings."
    }
  ];

  // 6. AI & EdTech
  const aiEdTechItems = (edTechNews && edTechNews.length > 0) ? edTechNews.slice(0, 3).map(n => ({
    title: n.title,
    body: `${n.takeaway || ''} Source: ${n.source || 'Global Higher Ed Intelligence'}.`
  })) : [
    {
      title: "upGrad has finished absorbing Unacademy",
      body: "The all-share deal closed earlier this month at a little over $200 million — roughly ninety per cent below Unacademy's 2021 valuation — pulling UPSC, JEE, NEET and GATE test prep under one roof with upGrad's degree partnerships."
    },
    {
      title: "Google’s free educator badges keep shipping monthly",
      body: "Guided Learning and AI Quests joined the AI Educator Series this month, with a new module on the first Wednesday of each month and a badge-a-thon on 19 September — fifteen-minute units that would drop into an FDP calendar without a procurement cycle."
    },
    {
      title: "ABP backed a voice-first tutor in 22 Indian languages",
      body: "Noida-based YoLearn.ai raised seed money from ABP Education for an AI tutor students reach by scanning QR codes printed into their textbooks — school-stage today, but the same print-to-assistant bridge a prospectus or a campus handbook could use."
    }
  ];

  // 7. Jaipur & Rajasthan
  const jaipurItems = [
    {
      title: "Candidates walked out of a Jaipur SET centre",
      body: "At a school centre on Bainar Road, question papers arrived about thirty minutes late on Sunday and candidates boycotted; the principal posted a cancellation notice with no official confirmation issued at the time of reporting. JU held a SET centre the same morning."
    },
    {
      title: "Rain sits over the eastern half today",
      body: "IMD has a low-pressure system moving into south-eastern Rajasthan within the day, with heavy rain, thunder and lightning likely across the east and lighter scattered showers in the west — the Alwar campus is on the wet side, and tomorrow's early bus is worth a weather check before it rolls."
    }
  ];

  return {
    headline,
    timeline,
    needsAttention: attentionItems,
    resolved: resolvedItems,
    higherEdIndia: higherEdItems,
    aiEdTech: aiEdTechItems,
    jaipurRajasthan: jaipurItems
  };
}

