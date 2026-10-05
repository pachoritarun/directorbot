// Detect subpath for reverse proxy (e.g. /directorbot or /)
let basePath = window.location.pathname.replace(/\/+$/, '');
if (basePath.includes('/recruitment')) {
  basePath = basePath.substring(0, basePath.indexOf('/recruitment'));
}
if (basePath.endsWith('.html') || basePath.includes('.htm')) {
  basePath = basePath.substring(0, basePath.lastIndexOf('/'));
}
if (basePath === '/' || !basePath) {
  basePath = '';
}

function resolveUrl(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  const clean = url.startsWith('/') ? url : `/${url}`;
  return `${basePath}${clean}`;
}

// Fetch Interceptor for Auth & BasePath
const originalFetch = window.fetch;
window.fetch = function(url, options = {}) {
  if (typeof url === 'string' && url.startsWith('/api/')) {
    url = resolveUrl(url);
  }

  const token = localStorage.getItem('auth_token');
  if (token) {
    options.headers = options.headers || {};
    if (options.headers instanceof Headers) {
      if (!options.headers.has('Authorization')) {
        options.headers.append('Authorization', `Bearer ${token}`);
      }
    } else if (Array.isArray(options.headers)) {
      if (!options.headers.some(([k]) => k.toLowerCase() === 'authorization')) {
        options.headers.push(['Authorization', `Bearer ${token}`]);
      }
    } else {
      if (!options.headers['Authorization'] && !options.headers['authorization']) {
        options.headers['Authorization'] = `Bearer ${token}`;
      }
    }
  }

  return originalFetch.call(this, url, options).then(res => {
    if (res.status === 401 && typeof url === 'string' && !url.includes('/api/auth/login')) {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('auth_user');
      window.location.replace(resolveUrl('/login.html'));
    }
    return res;
  });
};

// Global State
let currentUser = null;
let currentDispatchMethod = 'gmail';
let searchDebounceTimer = null;

// DOM Ready
document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  await initUserProfile();
  await loadStatus();
  await loadApplications();
  await loadRecruitmentSettings();
  await loadTeamMembers();
  checkOAuthParams();

  // Periodic polling
  setInterval(loadStatus, 15000);
  setInterval(loadApplications, 12000);
});

// Tab Navigation
function setupTabs() {
  const links = document.querySelectorAll('.sidebar-nav .nav-link');
  links.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const tabId = link.getAttribute('data-tab');
      if (!tabId) return;

      links.forEach(l => l.classList.remove('active'));
      link.classList.add('active');

      document.querySelectorAll('.tab-content').forEach(section => {
        section.classList.remove('active');
      });

      const target = document.getElementById(tabId);
      if (target) target.classList.add('active');
    });
  });
}

// User Profile Initialization
async function initUserProfile() {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (data && data.success && data.user) {
      currentUser = data.user;
      
      const nameElem = document.getElementById('sidebar-user-name');
      const roleElem = document.getElementById('sidebar-user-role');
      const avatarElem = document.getElementById('sidebar-user-avatar');

      if (nameElem) nameElem.textContent = currentUser.name || 'Deepak Talkudar';
      if (roleElem) roleElem.textContent = currentUser.role === 'recruiter_admin' ? 'Recruiter Admin' : (currentUser.role === 'director' ? 'Executive Director' : 'Recruiter');

      if (avatarElem) {
        const parts = (currentUser.name || 'Deepak Talkudar').split(' ').filter(Boolean);
        const initials = parts.length > 1 ? (parts[0][0] + parts[parts.length - 1][0]) : parts[0].substring(0, 2);
        avatarElem.textContent = initials.toUpperCase();
      }

      // Pre-fill profile form
      const profName = document.getElementById('profile_name');
      const profEmail = document.getElementById('profile_email');
      if (profName) profName.value = currentUser.name || '';
      if (profEmail) profEmail.value = currentUser.email || '';
    }
  } catch (err) {
    console.error('Failed to init user profile:', err);
  }
}

// Status & Mailbox Check
async function loadStatus() {
  try {
    const res = await fetch('/api/recruitment/status');
    const data = await res.json();
    if (!data || !data.success) return;

    // 1. Mailbox chip
    const gmailChip = document.getElementById('chip-hiring-gmail');
    const gmailText = document.getElementById('chip-gmail-text');
    const btnConnect = document.getElementById('btn-connect-gmail');
    const btnDisconnect = document.getElementById('btn-disconnect-gmail');
    const descGmail = document.getElementById('text-gmail-connection-desc');

    if (data.gmailConnected && data.hiringEmail) {
      gmailChip.className = 'status-chip online';
      gmailText.textContent = `Hiring Mailbox: ${data.hiringEmail}`;
      if (descGmail) descGmail.innerHTML = `Active Google Account: <strong style="color: #34d399;">${data.hiringEmail}</strong>. Scanning incoming candidate emails with resumes.`;
      if (btnConnect) btnConnect.style.display = 'none';
      if (btnDisconnect) btnDisconnect.style.display = 'inline-flex';
    } else {
      gmailChip.className = 'status-chip offline';
      gmailText.textContent = 'Hiring Mailbox Disconnected';
      if (descGmail) descGmail.textContent = 'Connect the official university recruitment email address to start reading upcoming resumes.';
      if (btnConnect) btnConnect.style.display = 'inline-flex';
      if (btnDisconnect) btnDisconnect.style.display = 'none';
    }

    // 2. Dispatch chip
    const dispatchChip = document.getElementById('chip-dispatch-method');
    const dispatchText = document.getElementById('chip-dispatch-text');
    const channelName = document.getElementById('stat-channel-name');

    currentDispatchMethod = data.dispatchMethod || 'gmail';
    if (currentDispatchMethod === 'smtp') {
      dispatchChip.className = 'status-chip method-smtp';
      dispatchText.textContent = 'Active Method: Custom SMTP';
      if (channelName) channelName.textContent = 'CUSTOM SMTP';
    } else {
      dispatchChip.className = 'status-chip method-gmail';
      dispatchText.textContent = 'Active Method: Gmail OAuth';
      if (channelName) channelName.textContent = 'GMAIL OAUTH';
    }

    // 3. Stat counters
    if (data.stats) {
      document.getElementById('stat-total-apps').textContent = data.stats.total || 0;
      document.getElementById('stat-sent-apps').textContent = data.stats.sent || 0;
      document.getElementById('stat-pending-apps').textContent = data.stats.pending || 0;
    }
  } catch (err) {
    console.warn('Error loading status:', err.message);
  }
}

// Load Applications Feed
async function loadApplications() {
  const search = document.getElementById('input-app-search')?.value.trim() || '';
  const status = document.getElementById('select-status-filter')?.value || 'ALL';

  const params = new URLSearchParams();
  if (search) params.append('search', search);
  if (status && status !== 'ALL') params.append('status', status);

  try {
    const res = await fetch(`/api/recruitment/applications?${params.toString()}`);
    const data = await res.json();
    const tbody = document.getElementById('tbody-applications');
    if (!tbody) return;

    if (!data.success || !data.applications || data.applications.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align: center; color: var(--text-muted); padding: 48px;">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 10px; opacity: 0.5;">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
            </svg>
            <div>No candidate applications found yet.</div>
            <div style="font-size: 0.8rem; margin-top: 4px;">Incoming emails with resume attachments will be analyzed by Gemini AI and listed here instantly.</div>
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = data.applications.map(app => {
      try {
        const rawDate = app.created_at || app.received_at;
        const dateStr = rawDate ? new Date(rawDate).toLocaleString('en-IN', {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit'
        }) : 'Recent';

        // Status badge
        let statusBadge = '';
        if (app.confirmation_status === 'SENT') {
          const methodTag = app.confirmation_method === 'SMTP' ? 'via SMTP' : 'via Gmail';
          statusBadge = `<span class="badge-status sent" title="Sent at ${app.confirmation_sent_at || ''}">✓ Dispatched (${methodTag})</span>`;
        } else if (app.confirmation_status === 'FAILED') {
          statusBadge = `<span class="badge-status failed" title="${escapeHtml(app.confirmation_error || 'Dispatch error')}">✕ Failed</span>`;
        } else if (app.confirmation_status === 'SKIPPED') {
          statusBadge = `<span class="badge-status pending" title="${escapeHtml(app.confirmation_error || 'Skipped')}">⏭ Skipped (Duplicate)</span>`;
        } else {
          statusBadge = `<span class="badge-status pending">⏳ Pending</span>`;
        }

        // Attachments display with safe type checks
        let filenames = [];
        if (typeof app.resume_filenames === 'string' && app.resume_filenames) {
          filenames = app.resume_filenames.split(',').map(f => f.trim()).filter(Boolean);
        } else if (Array.isArray(app.resume_filenames)) {
          filenames = app.resume_filenames;
        }

        const attachmentsHtml = filenames.length > 0 ? filenames.map(f => `
          <div class="attachment-badge">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
            </svg>
            ${escapeHtml(f)}
          </div>
        `).join('') : '<span style="color: var(--text-muted); font-size: 0.78rem;">Email Text</span>';

        // Skills tags with safe type checks
        let skillsList = [];
        if (typeof app.skills === 'string' && app.skills) {
          skillsList = app.skills.split(',').map(s => s.trim()).filter(Boolean);
        } else if (Array.isArray(app.skills)) {
          skillsList = app.skills;
        }

        const skillsHtml = skillsList.length > 0 ? `
          <div style="margin-top: 5px; display: flex; gap: 4px; flex-wrap: wrap;">
            ${skillsList.slice(0, 4).map(s => `
              <span style="font-size: 0.7rem; background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; color: var(--text-sub);">
                ${escapeHtml(s)}
              </span>
            `).join('')}
          </div>` : '';

        return `
          <tr>
            <td><span class="app-id-badge">${escapeHtml(app.application_id || 'JECRC-REC')}</span></td>
            <td class="candidate-cell">
              <div class="name">${escapeHtml(app.candidate_name || 'Candidate')}</div>
              <div class="email">${escapeHtml(app.candidate_email || '')}</div>
              ${app.candidate_phone ? `<div class="phone">📞 ${escapeHtml(app.candidate_phone)}</div>` : ''}
            </td>
            <td><span class="post-pill">${escapeHtml(app.applied_post || 'Applicant')}</span></td>
            <td>${attachmentsHtml}</td>
            <td style="max-width: 260px;">
              <div style="font-size: 0.8rem; color: var(--text-sub); line-height: 1.35;">${escapeHtml(app.ai_summary || app.email_snippet || 'No summary available')}</div>
              ${skillsHtml}
            </td>
            <td>${statusBadge}</td>
            <td style="font-size: 0.78rem; color: var(--text-muted); white-space: nowrap;">${dateStr}</td>
            <td>
              <div style="display: flex; gap: 6px; align-items: center;">
                <button class="btn-resend" onclick="sendConfirmation('${app.id}')" title="Send or resend confirmation email">
                  ${app.confirmation_status === 'SENT' ? 'Resend' : 'Send'}
                </button>
                <button class="btn-danger" style="padding: 4px 8px; font-size: 0.72rem;" onclick="deleteSingleApplication('${app.id}')" title="Delete application record">
                  ✕
                </button>
              </div>
            </td>
          </tr>
        `;
      } catch (rowErr) {
        console.warn('Error formatting application row:', rowErr);
        return '';
      }
    }).join('');
  } catch (err) {
    console.error('Failed to load applications:', err);
  }
}

// Clear Entire Application History
async function clearApplicationHistory() {
  if (!confirm('⚠️ Are you sure you want to permanently clear all candidate application history? This action cannot be undone.')) {
    return;
  }

  try {
    const res = await fetch('/api/recruitment/applications', { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast('✓ All candidate application history cleared.', 'success');
      await loadApplications();
      await loadStatus();
    } else {
      showToast('❌ ' + (data.error || 'Failed to clear history.'), 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// Delete a Single Application Record
async function deleteSingleApplication(appId) {
  if (!confirm('Delete this candidate application record?')) {
    return;
  }

  try {
    const res = await fetch(`/api/recruitment/applications/${appId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast('Application record deleted.', 'success');
      await loadApplications();
      await loadStatus();
    } else {
      showToast('❌ ' + (data.error || 'Failed to delete record.'), 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

function debounceSearch() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(loadApplications, 300);
}

// Trigger Manual Inbox Scan
async function triggerInboxScan() {
  const btn = document.getElementById('btn-scan-now');
  if (btn) btn.classList.add('loading');

  try {
    showToast('Scanning hiring mailbox for new resumes...', 'info');
    const res = await fetch('/api/recruitment/scan-now', { method: 'POST' });
    const data = await res.json();

    if (data.success && data.result) {
      if (data.result.status === 'not_connected') {
        showToast('⚠️ Hiring Gmail is not connected yet. Click Connect Google Mailbox.', 'error');
      } else if (data.result.count > 0) {
        showToast(`🎉 Processed ${data.result.count} new candidate application(s)!`, 'success');
      } else {
        showToast(data.result.message || 'Inbox scan finished. No new unread resumes.', 'info');
      }
    } else {
      showToast(data.error || 'Failed to complete inbox scan.', 'error');
    }

    await loadStatus();
    await loadApplications();
  } catch (err) {
    showToast('Failed to scan mailbox: ' + err.message, 'error');
  } finally {
    if (btn) btn.classList.remove('loading');
  }
}

// Send or Resend Confirmation for an Application
async function sendConfirmation(appId) {
  try {
    showToast('Sending confirmation email...', 'info');
    const res = await fetch(`/api/recruitment/send-confirmation/${appId}`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || 'Confirmation dispatched successfully!', 'success');
      await loadApplications();
      await loadStatus();
    } else {
      showToast('❌ ' + (data.error || 'Failed to dispatch confirmation.'), 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// Google OAuth Connection Flow
function connectHiringGmail() {
  window.location.href = resolveUrl('/auth/recruitment/google');
}

async function disconnectHiringGmail() {
  if (!confirm('Are you sure you want to disconnect the hiring Google mailbox?')) return;
  try {
    const res = await fetch('/api/recruitment/disconnect-gmail', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Hiring Gmail disconnected successfully.', 'success');
      await loadStatus();
    }
  } catch (err) {
    showToast('Error disconnecting: ' + err.message, 'error');
  }
}

// Dispatch Method Selection
function selectDispatchMethod(method) {
  currentDispatchMethod = method;
  const cardGmail = document.getElementById('card-choice-gmail');
  const cardSmtp = document.getElementById('card-choice-smtp');

  if (method === 'smtp') {
    cardSmtp.classList.add('selected');
    cardGmail.classList.remove('selected');
  } else {
    cardGmail.classList.add('selected');
    cardSmtp.classList.remove('selected');
  }
}

// Load Settings
async function loadRecruitmentSettings() {
  try {
    const res = await fetch('/api/recruitment/settings');
    const data = await res.json();
    if (!data.success || !data.settings) return;

    const s = data.settings;
    selectDispatchMethod(s.dispatch_method || 'gmail');

    document.getElementById('smtp_host').value = s.smtp_host || '';
    document.getElementById('smtp_port').value = s.smtp_port || '587';
    document.getElementById('smtp_secure').value = s.smtp_secure || 'false';
    document.getElementById('smtp_user').value = s.smtp_user || '';
    document.getElementById('smtp_pass').value = s.smtp_pass || '';
    document.getElementById('smtp_from_name').value = s.smtp_from_name || '';
    document.getElementById('smtp_from_email').value = s.smtp_from_email || '';

    const autoReplyCheck = document.getElementById('auto_reply_enabled');
    if (autoReplyCheck) autoReplyCheck.checked = s.auto_reply_enabled === 'true';

    document.getElementById('email_subject_template').value = s.email_subject_template || '';
    document.getElementById('email_body_template').value = s.email_body_template || '';

    updateLivePreview();
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

// Live Preview Updater
function updateLivePreview() {
  const subjectTpl = document.getElementById('email_subject_template')?.value || '';
  const bodyTpl = document.getElementById('email_body_template')?.value || '';

  const today = new Date().toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });

  const replaceTags = (txt) => {
    return txt
      .replace(/{candidate_name}/g, 'Rahul Sharma')
      .replace(/{applied_post}/g, 'Assistant Professor - CSE')
      .replace(/{application_id}/g, 'JECRC-HR-98214')
      .replace(/{received_date}/g, today)
      .replace(/{university_name}/g, 'JECRC University');
  };

  const previewSub = document.getElementById('preview-subject');
  const previewBody = document.getElementById('preview-body');

  if (previewSub) previewSub.textContent = replaceTags(subjectTpl);
  if (previewBody) previewBody.textContent = replaceTags(bodyTpl);
}

// Tag Chip Inserter
function insertTag(tag) {
  const textarea = document.getElementById('email_body_template');
  if (!textarea) return;

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;

  textarea.value = text.substring(0, start) + tag + text.substring(end);
  textarea.selectionStart = textarea.selectionEnd = start + tag.length;
  textarea.focus();
  updateLivePreview();
}

// Save Settings
async function saveRecruitmentSettings() {
  const payload = {
    dispatch_method: currentDispatchMethod,
    smtp_host: document.getElementById('smtp_host').value.trim(),
    smtp_port: document.getElementById('smtp_port').value.trim(),
    smtp_secure: document.getElementById('smtp_secure').value,
    smtp_user: document.getElementById('smtp_user').value.trim(),
    smtp_pass: document.getElementById('smtp_pass').value,
    smtp_from_name: document.getElementById('smtp_from_name').value.trim(),
    smtp_from_email: document.getElementById('smtp_from_email').value.trim(),
    auto_reply_enabled: document.getElementById('auto_reply_enabled').checked ? 'true' : 'false',
    email_subject_template: document.getElementById('email_subject_template').value,
    email_body_template: document.getElementById('email_body_template').value
  };

  try {
    const res = await fetch('/api/recruitment/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      showToast('Dispatch & SMTP settings saved successfully!', 'success');
      await loadStatus();
    } else {
      showToast('❌ ' + (data.error || 'Failed to save settings'), 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// Test SMTP Connection
async function runSmtpTest() {
  const host = document.getElementById('smtp_host').value.trim();
  const port = document.getElementById('smtp_port').value.trim();
  const secure = document.getElementById('smtp_secure').value;
  const user = document.getElementById('smtp_user').value.trim();
  const pass = document.getElementById('smtp_pass').value;
  const fromName = document.getElementById('smtp_from_name').value.trim();
  const fromEmail = document.getElementById('smtp_from_email').value.trim();
  const testRecipient = document.getElementById('smtp_test_recipient').value.trim();

  const resultBox = document.getElementById('smtp-test-result');
  const btn = document.getElementById('btn-test-smtp');

  if (!host || !user) {
    showToast('Please enter SMTP Host and Username to test', 'error');
    return;
  }

  btn.disabled = true;
  resultBox.style.display = 'block';
  resultBox.style.color = 'var(--text-sub)';
  resultBox.textContent = 'Connecting to SMTP server...';

  try {
    const res = await fetch('/api/recruitment/test-smtp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, port, secure, user, pass, fromName, fromEmail, testRecipient })
    });
    const data = await res.json();

    if (data.success) {
      resultBox.style.color = '#34d399';
      resultBox.textContent = '✓ ' + (data.message || 'SMTP verified successfully!');
      showToast('✓ SMTP connection verified successfully!', 'success');
    } else {
      resultBox.style.color = '#fb7185';
      resultBox.textContent = '✕ ' + (data.error || 'SMTP verification failed');
      showToast('SMTP Test Failed: ' + data.error, 'error');
    }
  } catch (err) {
    resultBox.style.color = '#fb7185';
    resultBox.textContent = '✕ Connection error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

// Team Member Management
async function loadTeamMembers() {
  try {
    const res = await fetch('/api/recruitment/team');
    const data = await res.json();
    const tbody = document.getElementById('tbody-team');
    if (!tbody) return;

    if (!data.success || !data.members || data.members.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 24px;">No members added yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.members.map(m => {
      const isSelf = currentUser && m.id === currentUser.id;
      const roleBadge = m.role === 'recruiter_admin' ? 
        '<span style="background: rgba(139,92,246,0.15); color: #c4b5fd; padding: 3px 8px; border-radius: 6px; font-size: 0.76rem; font-weight: 600;">Recruiter Admin</span>' :
        '<span style="background: rgba(6,182,212,0.15); color: #67e8f9; padding: 3px 8px; border-radius: 6px; font-size: 0.76rem; font-weight: 600;">Recruiter</span>';

      return `
        <tr>
          <td>
            <div style="font-weight: 600;">${escapeHtml(m.name || 'Member')} ${isSelf ? '<span style="font-size: 0.72rem; color: var(--accent-cyan);">(You)</span>' : ''}</div>
          </td>
          <td><span style="font-family: monospace; font-size: 0.82rem;">${escapeHtml(m.email)}</span></td>
          <td>${roleBadge}</td>
          <td style="font-size: 0.78rem; color: var(--text-muted);">${m.created_at ? new Date(m.created_at).toLocaleDateString('en-IN') : '-'}</td>
          <td>
            ${!isSelf && m.role !== 'director' ? `
              <button class="btn-danger" style="padding: 4px 10px; font-size: 0.76rem;" onclick="deleteMember('${m.id}', '${escapeHtml(m.name)}')">
                Remove
              </button>
            ` : '<span style="color: var(--text-muted); font-size: 0.75rem;">Active</span>'}
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load team members:', err);
  }
}

function openAddMemberModal() {
  document.getElementById('modal-add-member').classList.add('open');
}

function closeAddMemberModal() {
  document.getElementById('modal-add-member').classList.remove('open');
  document.getElementById('form-add-member').reset();
}

async function handleAddMember(e) {
  e.preventDefault();
  const name = document.getElementById('new_member_name').value.trim();
  const email = document.getElementById('new_member_email').value.trim();
  const password = document.getElementById('new_member_pass').value;

  try {
    const res = await fetch('/api/recruitment/team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password })
    });
    const data = await res.json();

    if (data.success) {
      showToast(`Member ${name} added successfully!`, 'success');
      closeAddMemberModal();
      await loadTeamMembers();
    } else {
      showToast('❌ ' + (data.error || 'Failed to add member'), 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function deleteMember(id, name) {
  if (!confirm(`Are you sure you want to remove ${name} from recruitment access?`)) return;
  try {
    const res = await fetch(`/api/recruitment/team/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast('Member removed successfully', 'success');
      await loadTeamMembers();
    } else {
      showToast('❌ ' + (data.error || 'Failed to remove member'), 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// Profile & Passcode Update
async function handleUpdateProfile(e) {
  e.preventDefault();
  const name = document.getElementById('profile_name').value.trim();
  const email = document.getElementById('profile_email').value.trim();

  try {
    const res = await fetch('/api/auth/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email })
    });
    const data = await res.json();

    if (data.success) {
      showToast('Profile updated successfully! Next login will use new email.', 'success');
      await initUserProfile();
    } else {
      showToast('❌ ' + (data.error || 'Failed to update profile'), 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function handleChangePassword(e) {
  e.preventDefault();
  const currentPassword = document.getElementById('pwd_current').value;
  const newPassword = document.getElementById('pwd_new').value;
  const confirmPassword = document.getElementById('pwd_confirm').value;

  if (newPassword !== confirmPassword) {
    showToast('❌ New passcodes do not match', 'error');
    return;
  }
  if (newPassword.length < 6) {
    showToast('❌ Passcode must be at least 6 characters', 'error');
    return;
  }

  try {
    const res = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const data = await res.json();

    if (data.success) {
      showToast('Passcode updated successfully! You can now use your new passcode.', 'success');
      document.getElementById('form-change-password').reset();
    } else {
      showToast('❌ ' + (data.error || 'Failed to update passcode'), 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// OAuth Callback Params
function checkOAuthParams() {
  const urlParams = new URLSearchParams(window.location.search);
  const auth = urlParams.get('auth');
  const email = urlParams.get('email');
  const msg = urlParams.get('msg');

  if (auth === 'success' && email) {
    showToast(`✓ Google Mailbox connected successfully: ${email}`, 'success');
    window.history.replaceState({}, document.title, window.location.pathname);
  } else if (auth === 'failed' || auth === 'error') {
    showToast(`OAuth Error: ${decodeURIComponent(msg || 'Authentication failed')}`, 'error');
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

// Logout
window.executeLogout = function(e) {
  if (e) {
    try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
  }
  try {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    sessionStorage.clear();
  } catch (err) {}
  window.location.href = resolveUrl('/logout');
};

// Toast Notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(50px)';
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
