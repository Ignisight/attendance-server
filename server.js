// =============================================
// Attendance System — Self-Contained Server
// =============================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const fs = require('fs');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// COLLEGE CONFIG
// ==========================================
const ALLOWED_EMAIL_DOMAIN = 'nitjsr.ac.in';
const crypto = require('crypto');

function generateSessionCode() {
  return crypto.randomBytes(4).toString('hex'); // 8-char hex code
}

// Parse roll info from email like "2046ugcm300@nitjsr.ac.in"
function parseRollInfo(email) {
  const local = email.split('@')[0].toLowerCase();
  // Pattern: YYYY(ug|pg)BRANCH_CODE + ROLL_NUMBER
  const match = local.match(/^(\d{4})(ug|pg)([a-z]{2,4})(\d+)$/i);
  if (match) {
    return {
      year: match[1],
      program: match[2].toUpperCase(),
      branch: match[3].toUpperCase(),
      rollNo: match[4],
      rollNumber: local.toUpperCase(), // full roll ID
    };
  }
  return { year: '-', program: '-', branch: '-', rollNo: '-', rollNumber: local.toUpperCase() };
}

// ==========================================
// JSON FILE DATABASE
// ==========================================
const DB_PATH = path.join(__dirname, 'data.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
      if (!data.users) data.users = [];
      if (!data.otps) data.otps = [];
      if (!data.sessions) data.sessions = [];
      if (!data.attendance) data.attendance = [];
      return data;
    }
  } catch (e) { /* ignore */ }
  return { users: [], otps: [], sessions: [], attendance: [] };
}

function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

let db = loadDB();

// Clean up sessions older than 2 days
function cleanOldData() {
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const oldSessionIds = db.sessions
    .filter(s => new Date(s.createdAt).getTime() < twoDaysAgo)
    .map(s => s.id);
  if (oldSessionIds.length > 0) {
    db.sessions = db.sessions.filter(s => !oldSessionIds.includes(s.id));
    db.attendance = db.attendance.filter(a => !oldSessionIds.includes(a.sessionId));
    saveDB(db);
    console.log(`  🗑️  Cleaned ${oldSessionIds.length} old sessions`);
  }
}
cleanOldData();
setInterval(cleanOldData, 60 * 60 * 1000); // Every hour

// ==========================================
// MIDDLEWARE
// ==========================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// AUTH ENDPOINTS
// ==========================================

app.post('/api/register', async (req, res) => {
  const { email, password, name, college, department } = req.body;

  if (!email || !password || !name) {
    return res.json({ success: false, error: 'Name, email and password are required' });
  }

  const emailLower = email.toLowerCase().trim();
  const existing = db.users.find(u => u.email === emailLower);
  if (existing) {
    return res.json({ success: false, error: 'An account with this email already exists' });
  }

  if (password.length < 4) {
    return res.json({ success: false, error: 'Password must be at least 4 characters' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  db.users.push({
    id: Date.now(),
    email: emailLower,
    name: name.trim(),
    college: (college || '').trim(),
    department: (department || '').trim(),
    password: hashedPassword,
    createdAt: new Date().toISOString(),
  });
  saveDB(db);

  res.json({ success: true, message: 'Account created! You can now login.' });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.json({ success: false, error: 'Email and password are required' });
  }

  const emailLower = email.toLowerCase().trim();
  const user = db.users.find(u => u.email === emailLower);

  if (!user) {
    return res.json({ success: false, error: 'No account found with this email' });
  }

  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    return res.json({ success: false, error: 'Incorrect password' });
  }

  res.json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      college: user.college || '',
      department: user.department || '',
    },
  });
});

// Update profile
app.post('/api/update-profile', async (req, res) => {
  const { email, name, college, department } = req.body;

  if (!email) {
    return res.json({ success: false, error: 'Email is required' });
  }

  const emailLower = email.toLowerCase().trim();
  const user = db.users.find(u => u.email === emailLower);

  if (!user) {
    return res.json({ success: false, error: 'User not found' });
  }

  if (name) user.name = name.trim();
  if (college !== undefined) user.college = college.trim();
  if (department !== undefined) user.department = department.trim();
  saveDB(db);

  res.json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      college: user.college,
      department: user.department,
    },
  });
});

app.post('/api/forgot-password', (req, res) => {
  const { email } = req.body;

  if (!email) return res.json({ success: false, error: 'Email is required' });

  const emailLower = email.toLowerCase().trim();
  const user = db.users.find(u => u.email === emailLower);

  if (!user) return res.json({ success: false, error: 'No account found with this email' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 10 * 60 * 1000;

  db.otps = db.otps.filter(o => o.email !== emailLower);
  db.otps.push({ email: emailLower, otp, expiresAt });
  saveDB(db);

  console.log(`\n  🔑 OTP for ${emailLower}: ${otp}\n`);

  res.json({ success: true, message: 'OTP generated.', otp: otp });
});

app.post('/api/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;

  if (!email || !otp || !newPassword) {
    return res.json({ success: false, error: 'Email, OTP and new password are required' });
  }

  const emailLower = email.toLowerCase().trim();
  const otpEntry = db.otps.find(o => o.email === emailLower && o.otp === otp);

  if (!otpEntry) return res.json({ success: false, error: 'Invalid OTP' });

  if (Date.now() > otpEntry.expiresAt) {
    db.otps = db.otps.filter(o => o.email !== emailLower);
    saveDB(db);
    return res.json({ success: false, error: 'OTP has expired. Request a new one.' });
  }

  if (newPassword.length < 4) {
    return res.json({ success: false, error: 'Password must be at least 4 characters' });
  }

  const user = db.users.find(u => u.email === emailLower);
  if (!user) return res.json({ success: false, error: 'User not found' });

  user.password = await bcrypt.hash(newPassword, 10);
  db.otps = db.otps.filter(o => o.email !== emailLower);
  saveDB(db);

  res.json({ success: true, message: 'Password reset! You can now login.' });
});

// ==========================================
// STUDENT FORM PAGE (unique link per session)
// ==========================================
app.get('/', (req, res) => {
  // Root shows a generic landing page
  const activeSession = db.sessions.find(s => s.active);
  if (activeSession && activeSession.code) {
    // Redirect to the unique session URL
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://${getLocalIP()}:${PORT}`;
    return res.redirect(`/s/${activeSession.code}`);
  }
  res.send(getStudentFormHTML(null));
});

app.get('/s/:code', (req, res) => {
  const { code } = req.params;
  const session = db.sessions.find(s => s.code === code);
  if (!session) {
    return res.send(getStudentFormHTML(null, 'Invalid or expired session link.'));
  }
  if (!session.active) {
    return res.send(getStudentFormHTML(null, 'This session has ended.'));
  }
  res.send(getStudentFormHTML(session));
});

// ==========================================
// STUDENT SUBMISSION
// ==========================================
app.post('/submit', (req, res) => {
  const { email, name, sessionCode } = req.body;

  if (!email || !name) {
    return res.json({ success: false, error: 'Email and name are required' });
  }

  const emailLower = email.toLowerCase().trim();

  // Validate college email domain
  if (!emailLower.endsWith('@' + ALLOWED_EMAIL_DOMAIN)) {
    return res.json({
      success: false,
      error: `Only @${ALLOWED_EMAIL_DOMAIN} emails are allowed.`,
    });
  }

  // Find session by code, or fall back to active session
  let activeSession;
  if (sessionCode) {
    activeSession = db.sessions.find(s => s.code === sessionCode && s.active);
  } else {
    activeSession = db.sessions.find(s => s.active);
  }
  if (!activeSession) {
    return res.json({ success: false, error: 'No active session. The link may have expired.' });
  }

  // Check duplicate
  const dup = db.attendance.find(a => a.sessionId === activeSession.id && a.email === emailLower);
  if (dup) {
    return res.json({ success: false, error: 'You have already submitted for this session.' });
  }

  // Auto-parse roll info from email
  const rollInfo = parseRollInfo(emailLower);

  const now = new Date();
  db.attendance.push({
    sessionId: activeSession.id,
    email: emailLower,
    name: name.trim(),
    rollNumber: rollInfo.rollNumber,
    year: rollInfo.year,
    program: rollInfo.program,
    branch: rollInfo.branch,
    rollNo: rollInfo.rollNo,
    submittedAt: now.toISOString(),
    date: now.toLocaleDateString('en-IN'),
    time: now.toLocaleTimeString('en-IN', { hour12: false }),
  });
  saveDB(db);

  res.json({ success: true, message: 'Attendance recorded!' });
});

// ==========================================
// TEACHER API
// ==========================================

app.post('/api/start-session', (req, res) => {
  const { sessionName } = req.body;
  if (!sessionName || !sessionName.trim()) {
    return res.json({ success: false, error: 'Session name is required' });
  }

  db.sessions.forEach(s => { s.active = false; });

  const id = Date.now();
  const code = generateSessionCode();
  db.sessions.push({
    id: id,
    name: sessionName.trim(),
    code: code,
    createdAt: new Date().toISOString(),
    active: true,
  });
  saveDB(db);

  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://${getLocalIP()}:${PORT}`;
  res.json({
    success: true,
    sessionId: id,
    sessionName: sessionName.trim(),
    formUrl: `${baseUrl}/s/${code}`,
  });
});

app.post('/api/stop-session', (req, res) => {
  db.sessions.forEach(s => { s.active = false; });
  saveDB(db);
  res.json({ success: true, message: 'Session stopped' });
});

app.get('/api/status', (req, res) => {
  const session = db.sessions.find(s => s.active);
  res.json({ active: !!session, session: session || null });
});

app.get('/api/responses', (req, res) => {
  const { sessionName } = req.query;

  let rows;
  if (sessionName) {
    const session = db.sessions.find(s => s.name === sessionName);
    rows = session ? db.attendance.filter(a => a.sessionId === session.id) : [];
  } else {
    const activeSession = db.sessions.find(s => s.active);
    rows = activeSession ? db.attendance.filter(a => a.sessionId === activeSession.id) : [];
  }

  res.json({
    success: true,
    responses: rows.map(r => {
      const session = db.sessions.find(s => s.id === r.sessionId);
      return {
        'Email': r.email,
        'Name': r.name,
        'Roll Number': r.rollNumber,
        'Year': r.year || '-',
        'Program': r.program || '-',
        'Branch': r.branch || '-',
        'Roll No': r.rollNo || '-',
        'Session': session ? session.name : 'Unknown',
        'Date': r.date,
        'Time': r.time,
      };
    }),
    count: rows.length,
    headers: ['Email', 'Name', 'Roll Number', 'Year', 'Program', 'Branch', 'Roll No', 'Session', 'Date', 'Time'],
  });
});

// Session history
app.get('/api/history', (req, res) => {
  const sessions = db.sessions.map(s => ({
    id: s.id,
    name: s.name,
    createdAt: s.createdAt,
    active: s.active,
    responseCount: db.attendance.filter(a => a.sessionId === s.id).length,
  }));
  res.json({ success: true, sessions: sessions.reverse() });
});

// Delete single session
app.delete('/api/sessions/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.sessions = db.sessions.filter(s => s.id !== id);
  db.attendance = db.attendance.filter(a => a.sessionId !== id);
  saveDB(db);
  res.json({ success: true });
});

// Delete multiple sessions
app.post('/api/sessions/delete-many', (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) {
    return res.json({ success: false, error: 'ids array required' });
  }
  db.sessions = db.sessions.filter(s => !ids.includes(s.id));
  db.attendance = db.attendance.filter(a => !ids.includes(a.sessionId));
  saveDB(db);
  res.json({ success: true, deleted: ids.length });
});

// Clear all sessions
app.post('/api/sessions/clear-all', (req, res) => {
  const count = db.sessions.length;
  db.sessions = [];
  db.attendance = [];
  saveDB(db);
  res.json({ success: true, deleted: count });
});

// Export multiple sessions
app.get('/api/export-multi', (req, res) => {
  const { ids } = req.query;
  let sessionIds = [];
  if (ids) sessionIds = ids.split(',').map(Number);

  let rows = sessionIds.length > 0
    ? db.attendance.filter(a => sessionIds.includes(a.sessionId))
    : db.attendance;

  const excelData = rows.map(r => {
    const session = db.sessions.find(s => s.id === r.sessionId);
    return {
      'Email': r.email, 'Name': r.name, 'Roll Number': r.rollNumber,
      'Year': r.year || '-', 'Program': r.program || '-', 'Branch': r.branch || '-',
      'Roll No': r.rollNo || '-', 'Session': session ? session.name : 'Unknown',
      'Date': r.date, 'Time': r.time,
    };
  });

  const wb = XLSX.utils.book_new();
  if (excelData.length === 0) {
    const ws = XLSX.utils.aoa_to_sheet([['Email', 'Name', 'Roll Number', 'Year', 'Program', 'Branch', 'Roll No', 'Session', 'Date', 'Time']]);
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
  } else {
    const ws = XLSX.utils.json_to_sheet(excelData);
    ws['!cols'] = [{ wch: 30 }, { wch: 25 }, { wch: 18 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 35 }, { wch: 14 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
  }
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="Attendance_Export.xlsx"');
  res.send(Buffer.from(buffer));
});

// Export as Excel
app.get('/api/export', (req, res) => {
  const { sessionName } = req.query;

  let rows;
  let sheetTitle = 'All Sessions';
  if (sessionName) {
    const session = db.sessions.find(s => s.name === sessionName);
    rows = session ? db.attendance.filter(a => a.sessionId === session.id) : [];
    sheetTitle = sessionName;
  } else {
    rows = db.attendance;
  }

  if (rows.length === 0) {
    // Return empty Excel with headers
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([['Email', 'Name', 'Roll Number', 'Year', 'Program', 'Branch', 'Roll No', 'Session', 'Date', 'Time']]);
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Attendance_Empty.xlsx"`);
    return res.send(Buffer.from(buffer));
  }

  const excelData = rows.map(r => {
    const session = db.sessions.find(s => s.id === r.sessionId);
    return {
      'Email': r.email,
      'Name': r.name,
      'Roll Number': r.rollNumber,
      'Year': r.year || '-',
      'Program': r.program || '-',
      'Branch': r.branch || '-',
      'Roll No': r.rollNo || '-',
      'Session': session ? session.name : 'Unknown',
      'Date': r.date,
      'Time': r.time,
    };
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(excelData);
  ws['!cols'] = [
    { wch: 30 }, { wch: 25 }, { wch: 18 }, { wch: 8 },
    { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 35 },
    { wch: 14 }, { wch: 10 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Attendance');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fileName = sessionName
    ? `Attendance_${sessionName.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`
    : 'Attendance_All.xlsx';

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(Buffer.from(buffer));
});

// ==========================================
// HELPERS
// ==========================================

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// ==========================================
// STUDENT FORM HTML — with Google-style email picker
// ==========================================

function getStudentFormHTML(session, errorMsg) {
  const isActive = session && session.active;
  const sessionName = isActive ? session.name : '';
  const sessionCode = isActive ? (session.code || '') : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Attendance — NIT Jamshedpur</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%);
      min-height: 100vh; display: flex; justify-content: center;
      align-items: center; padding: 20px;
    }
    .card {
      background: rgba(30, 41, 59, 0.95); backdrop-filter: blur(20px);
      border-radius: 24px; padding: 36px 32px; width: 100%; max-width: 440px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.4), 0 0 40px rgba(99, 102, 241, 0.1);
      border: 1px solid rgba(99, 102, 241, 0.15);
    }
    .icon { text-align: center; font-size: 52px; margin-bottom: 12px; }
    h1 { text-align: center; font-size: 26px; font-weight: 800; color: #f1f5f9; margin-bottom: 4px; }
    .session-badge {
      text-align: center; margin: 8px auto 20px;
      background: linear-gradient(135deg, #312e81, #4338ca);
      color: #c7d2fe; padding: 6px 16px; border-radius: 20px;
      font-size: 13px; font-weight: 600;
    }
    .closed { text-align: center; color: #f87171; font-size: 17px; padding: 32px 0; line-height: 1.7; }
    .field { margin-bottom: 18px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #94a3b8; margin-bottom: 8px; letter-spacing: 0.5px; text-transform: uppercase; }
    input, select {
      width: 100%; padding: 15px 18px; border-radius: 14px;
      border: 2px solid #334155; background: #0f172a; color: #f1f5f9;
      font-size: 16px; font-family: inherit; outline: none;
      transition: border-color 0.3s, box-shadow 0.3s;
      -webkit-appearance: none;
    }
    input:focus, select:focus { border-color: #6366f1; box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.15); }
    input::placeholder { color: #475569; }

    /* Email account picker */
    .email-display {
      background: #0f172a; border: 2px solid #334155; border-radius: 14px;
      padding: 14px 18px; display: flex; align-items: center; gap: 12px;
      cursor: pointer; transition: border-color 0.3s;
    }
    .email-display:hover { border-color: #6366f1; }
    .email-avatar {
      width: 40px; height: 40px; border-radius: 50%;
      background: linear-gradient(135deg, #6366f1, #4f46e5);
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; font-weight: 700; color: white; flex-shrink: 0;
    }
    .email-info { flex: 1; }
    .email-info .email-text { font-size: 15px; color: #f1f5f9; font-weight: 500; }
    .email-info .email-hint { font-size: 12px; color: #64748b; margin-top: 2px; }
    .switch-link { color: #818cf8; font-size: 13px; font-weight: 600; text-decoration: none; }

    .domain-note {
      font-size: 12px; color: #f59e0b; margin-top: 8px;
      background: rgba(245, 158, 11, 0.1); padding: 8px 12px; border-radius: 8px;
      border: 1px solid rgba(245, 158, 11, 0.2);
    }

    .btn {
      width: 100%; padding: 16px; border: none; border-radius: 14px;
      background: linear-gradient(135deg, #6366f1, #4f46e5);
      color: white; font-size: 17px; font-weight: 700; font-family: inherit;
      cursor: pointer; margin-top: 8px; transition: all 0.3s;
      box-shadow: 0 4px 15px rgba(99, 102, 241, 0.3);
    }
    .btn:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(99, 102, 241, 0.4); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .success { text-align: center; padding: 24px 0; }
    .success .check { font-size: 72px; animation: pop 0.4s ease; }
    .success h2 { color: #22c55e; font-size: 22px; margin: 16px 0 6px; }
    .success p { color: #94a3b8; font-size: 15px; }
    #error { color: #f87171; text-align: center; margin-top: 14px; font-size: 14px; font-weight: 500; display: none; }
    @keyframes pop { 0% { transform: scale(0); } 60% { transform: scale(1.2); } 100% { transform: scale(1); } }
  </style>
</head>
<body>
  <div class="card" style="text-align: center;">
    ${isActive ? `
      <div class="icon">📋</div>
      <h1>Mark Attendance</h1>
      <div class="session-badge">${escapeHtml(sessionName)}</div>

      <div id="formDiv">
        <form id="attendanceForm" onsubmit="return submitForm(event)" style="text-align:left;">

          <!-- Email Field: Google-style account selector -->
          <div class="field">
            <label>College Email</label>
            <div id="emailPickerArea">
              <input type="email" id="email" required
                placeholder="yourname@${ALLOWED_EMAIL_DOMAIN}"
                autocomplete="email"
                pattern="[a-zA-Z0-9._%+-]+@${ALLOWED_EMAIL_DOMAIN.replace(/\./g, '\\\\.')}"
                title="Only @${ALLOWED_EMAIL_DOMAIN} emails are allowed">
              <div class="domain-note">
                ⚠️ Only <strong>@${ALLOWED_EMAIL_DOMAIN}</strong> emails accepted
              </div>
            </div>
          </div>

          <div class="field">
            <label>Full Name</label>
            <input type="text" id="fullname" required placeholder="Your full name" autocomplete="name">
          </div>

          <button type="submit" class="btn" id="submitBtn">✅ Submit Attendance</button>
          <div id="error"></div>
        </form>
      </div>

      <div id="successMsg" style="display:none">
        <div class="success">
          <div class="check">✅</div>
          <h2>Attendance Recorded!</h2>
          <p>You're marked present for this session.</p>
          <p style="color:#64748b; font-size:13px; margin-top:12px;" id="rollDisplay"></p>
        </div>
      </div>

      <script>
        function submitForm(e) {
          e.preventDefault();
          var btn = document.getElementById('submitBtn');
          var errDiv = document.getElementById('error');
          var emailVal = document.getElementById('email').value.trim().toLowerCase();

          // Client-side domain check
          if (!emailVal.endsWith('@${ALLOWED_EMAIL_DOMAIN}')) {
            errDiv.textContent = 'Only @${ALLOWED_EMAIL_DOMAIN} emails are allowed.';
            errDiv.style.display = 'block';
            return false;
          }

          btn.disabled = true;
          btn.textContent = '⏳ Submitting...';
          errDiv.style.display = 'none';

          fetch('/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: emailVal,
              name: document.getElementById('fullname').value.trim(),
              sessionCode: '${sessionCode}'
            })
          })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.success) {
              document.getElementById('formDiv').style.display = 'none';
              document.getElementById('successMsg').style.display = 'block';
              // Show parsed roll number
              var rollPart = emailVal.split('@')[0].toUpperCase();
              document.getElementById('rollDisplay').textContent = 'Roll: ' + rollPart;
            } else {
              errDiv.textContent = data.error || 'Failed';
              errDiv.style.display = 'block';
              btn.disabled = false;
              btn.textContent = '✅ Submit Attendance';
            }
          })
          .catch(function() {
            errDiv.textContent = 'Network error. Try again.';
            errDiv.style.display = 'block';
            btn.disabled = false;
            btn.textContent = '✅ Submit Attendance';
          });
          return false;
        }
      </script>
    ` : `
      <div class="closed">
        <div style="font-size:56px;margin-bottom:16px;">⏳</div>
        <h1 style="color:#f1f5f9; margin-bottom:16px;">Attendance — NIT Jamshedpur</h1>
        ${errorMsg ? `<p style="color:#f59e0b;font-size:16px;margin-bottom:12px;">${escapeHtml(errorMsg)}</p>` : ''}
        No active session right now.<br>
        Wait for your teacher to start one.
      </div>
    `}
  </div>
</body>
</html>`;
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('');
  console.log('  ╔════════════════════════════════════════════╗');
  console.log('  ║   📋  Attendance Server — NIT Jamshedpur  ║');
  console.log('  ╠════════════════════════════════════════════╣');
  console.log(`  ║  Local:    http://localhost:${PORT}           ║`);
  console.log(`  ║  Network:  http://${ip}:${PORT}      ║`);
  console.log('  ╠════════════════════════════════════════════╣');
  console.log(`  ║  Email Domain: @${ALLOWED_EMAIL_DOMAIN}      ║`);
  console.log('  ║  Data Retention: 2 days                   ║');
  console.log('  ╚════════════════════════════════════════════╝');
  console.log('');
});
