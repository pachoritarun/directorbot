# 🏛️ University Executive AI Assistant & Command Hub

An autonomous, multi-agent Executive Chief of Staff built with **Baileys (Dual WhatsApp WebSocket Sessions)**, **Google Gemini 2.5 AI**, **Gmail API Connector**, and **MySQL**.

Built specifically for University Leadership (Director, Vice Chancellor) to eliminate communication overload, automate daily executive briefings, and execute verified actions directly through WhatsApp and a modern Web Command Dashboard.

---

## 🌟 Key Capabilities

### 1. 📱 Dual WhatsApp Architecture (Baileys)
* **Session 1: Director's WhatsApp (Silent Listener & Action Agent)**
  * Scans Director's primary WhatsApp once via QR code.
  * Ingests and caches incoming messages in **MySQL silently without triggering blue-tick read receipts** (messages remain unread on Director's physical phone).
  * Executes authorized outgoing replies when commanded by Director (e.g. *"Reply to Tarun: meet me at 4 PM"*).
* **Session 2: Executive Bot WhatsApp (Assistant Number)**
  * Dedicated bot SIM/number that chats with Director and PA.
  * 🔒 **Strict Whitelist Security Firewall**: **The bot will NEVER reply to unauthorized numbers** (students, unknown faculty, strangers, or spam numbers). If anyone other than the configured **Director's Phone** or **PA's Phone** texts this bot, the message is **completely ignored and dropped without any response**.
  * Answers natural queries (*"Tarun ne kya text kiya kal?"*, *"Kal meeting kitne baje hai?"*, *"Tarun ki latest email kya aayi?"*).
  * Sends the daily morning Executive PDF Briefing.
  * Enforces **Safety Verification** before sending emails.

### 2. 📧 Gmail API Connector with Human-in-the-Loop Verification
* Connects directly via **Google OAuth 2.0 ("Connect with Google" button on dashboard)**. Director does not need to provide passwords.
* Gemini AI filters out spam, newsletters, and promotional emails.
* Categorizes genuine institutional emails into `Urgent`, `High`, and `Normal` priorities with executive summaries and action items.
* **Two-Step Email Safety Verification**:
  * When Director instructs: *"Tarun ko email bhej do regarding AI lab meeting on Friday"*, the bot drafts the email, saves it as `PENDING_VERIFICATION`, and responds on WhatsApp:
    > 📝 **DRAFT EMAIL READY FOR REVIEW:**  
    > **To:** tarun@jecrcu.edu.in  
    > **Subject:** Meeting Request: AI Lab Inauguration  
    > **Body:** Dear Tarun, ...  
    > ⚠️ *Reply "CONFIRM" to dispatch this email, or "CANCEL" to discard.*
  * The email is dispatched via official Gmail **only after Director replies "CONFIRM" or "YES"**.

### 3. 📑 Executive Daily PDF Briefing
* Delivered every morning at 08:00 AM (or on-demand via `!briefing` on WhatsApp / Dashboard button).
* Includes:
  1. 📅 **Today's Official Itinerary & Appointments** (input by PA).
  2. 🚨 **High-Priority Email Intelligence & Action Items**.
  3. 💬 **WhatsApp Priority Inbound Digest** (pending callback/action).
  4. 🎓 **Top 3-4 EdTech & Higher-Education AI Strategic Insights** curated by Gemini.

### 4. 📅 PA Schedule Management
* PA can schedule meetings directly in the Web Dashboard or text the Bot on WhatsApp:
  * `!schedule 10:00 AM - HOD Academic Council; 02:30 PM - AI Lab Review`

### 5. 💻 Modern Executive Web Dashboard
* Live at: `http://localhost:3000`
* Real-time WebSocket QR code pairing for both WhatsApp accounts.
* One-click Google Gmail authorization.
* Email intelligence inspector & outbox verification center.
* MySQL live health monitor.

---

## 🛠️ Step-by-Step Setup Guide

### Step 1: Environment & MySQL Configuration
Your `.env` is already configured with your MySQL password:
```env
PORT=3000
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=Tarun@2005
MYSQL_DATABASE=executive_ai_db

GEMINI_API_KEY=your_gemini_api_key_here
GOOGLE_CLIENT_ID=your_google_client_id_here
GOOGLE_CLIENT_SECRET=your_google_client_secret_here
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback

DIRECTOR_PHONE=919876543210
PA_PHONE=919812345678
ORGANIZATION_NAME=JECRC University
DIRECTOR_TITLE=Office of the Director
BRIEFING_TIME=08:00
```

### Step 2: Google Cloud Console Setup (One-Time)
To enable the **"Connect with Google"** button:
1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (e.g. `Executive Assistant`).
3. Under **APIs & Services** > **Library**, search for **Gmail API** and click **Enable**.
4. Go to **APIs & Services** > **OAuth consent screen**:
   - User Type: **External** (or **Internal** if using Google Workspace).
   - App Name: `Executive AI Assistant`.
   - Add scopes: `gmail.readonly`, `gmail.send`, `userinfo.email`.
   - In Test Users, add Director's email (if in Testing mode).
5. Go to **APIs & Services** > **Credentials** > **Create Credentials** > **OAuth client ID**:
   - Application type: **Web application**.
   - Authorized redirect URIs: `http://localhost:3000/auth/google/callback`
6. Copy the **Client ID** and **Client Secret** into `.env` or paste them into the Dashboard **Settings** tab.

### Step 3: Run the System
```bash
# In d:\jecrc\whatspp automation
npm start
```
Open `http://localhost:3000` in your browser.

### Step 4: Scan WhatsApp QRs in Dashboard
1. Open the **WhatsApp Connectors** tab:
   - **Director's WhatsApp Account (Session 1)**: Scan with Director's phone (Linked Devices).
   - **Executive Bot WhatsApp (Session 2)**: Scan with the assistant bot phone number.
2. In the **Gmail Intelligence** tab, click **"Connect with Google"** to link Director's Gmail.

---

## 💬 WhatsApp Interaction Examples

### For Director:
| Query / Command | AI Bot Action |
|---|---|
| *"Tarun ne kya text kiya kal?"* | Searches MySQL silent WhatsApp cache and summarizes what Tarun texted. |
| *"Kal ka schedule kya hai?"* | Lists all meetings scheduled by PA for tomorrow. |
| *"Tarun ki latest email find karo"* | Fetches latest email from Tarun via Gmail API and summarizes it. |
| *"Tarun ko WhatsApp pe reply kar do: meet me at 4 PM today"* | Sends message to Tarun from Director's own WhatsApp session and confirms. |
| *"Tarun ko email bhej do regarding AI lab inauguraton"* | Generates professional draft and asks Director: *"Reply CONFIRM to send"*. Dispatches via Gmail on confirmation. |
| `!briefing` | Generates today's PDF briefing immediately and sends it to Director's WhatsApp. |

### For PA:
| Message | Action |
|---|---|
| `!schedule 10:00 AM - HOD Meet; 03:00 PM - Campus Inspection` | Automatically parses and registers meetings into Director's calendar. |
