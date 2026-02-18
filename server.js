// =============================================
// Attendance System — Self-Contained Server
// =============================================
// Run: node server.js
// That's it! No accounts, no APIs, no setup.
// =============================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const fs = require('fs');
const XLSX = require('xlsx');

const app = express();
const PORT = 3000;

// ==========================================
// JSON FILE DATABASE (zero dependencies)
// ==========================================
const DB_PATH = path.join(__dirname, 'data.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return {
    sessions: [], attendance: [], rollMap: [
      { email: 'student1@college.edu', rollNumber: '21ME001' },
      { email: 'student2@college.edu', rollNumber: '21ME002' },
    ]
  };
}

function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

let db = loadDB();

// ==========================================
// MIDDLEWARE
// ==========================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// STUDENT FORM PAGE — served at /
// ==========================================
app.get('/', (req, res) => {
  const activeSession = db.sessions.find(s => s.active);
  res.send(getStudentFormHTML(activeSession));
});

// ==========================================
// STUDENT SUBMISSION
// ==========================================
app.post('/submit', (req, res) => {
  const { email, name } = req.body;

  if (!email || !name) {
    return res.json({ success: false, error: 'Email and name are required' });
  }

  const activeSession = db.sessions.find(s => s.active);
  if (!activeSession) {
    return res.json({ success: false, error: 'No active session. Please wait for your teacher to start one.' });
  }

  const emailLower = email.toLowerCase().trim();

  // Check duplicate
  const dup = db.attendance.find(a => a.sessionId === activeSession.id && a.email === emailLower);
  if (dup) {
    return res.json({ success: false, error: 'You have already submitted for this session.' });
  }

  // Lookup roll number
  const rollEntry = db.rollMap.find(r => r.email === emailLower);
  const rollNumber = rollEntry ? rollEntry.rollNumber : 'NOT MAPPED';

  const now = new Date();
  db.attendance.push({
    sessionId: activeSession.id,
    email: emailLower,
    name: name.trim(),
    rollNumber: rollNumber,
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

// Start a new session
app.post('/api/start-session', (req, res) => {
  const { sessionName } = req.body;
  if (!sessionName || !sessionName.trim()) {
    return res.json({ success: false, error: 'Session name is required' });
  }

  // Close any active sessions
  db.sessions.forEach(s => { s.active = false; });

  const id = Date.now();
  db.sessions.push({
    id: id,
    name: sessionName.trim(),
    createdAt: new Date().toISOString(),
    active: true,
  });
  saveDB(db);

  const localIP = getLocalIP();
  res.json({
    success: true,
    sessionId: id,
    sessionName: sessionName.trim(),
    formUrl: `http://${localIP}:${PORT}`,
  });
});

// Stop current session
app.post('/api/stop-session', (req, res) => {
  db.sessions.forEach(s => { s.active = false; });
  saveDB(db);
  res.json({ success: true, message: 'Session stopped' });
});

// Get session status
app.get('/api/status', (req, res) => {
  const session = db.sessions.find(s => s.active);
  res.json({ active: !!session, session: session || null });
});

// Get responses
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
        'Session Name': session ? session.name : 'Unknown',
        'Date': r.date,
        'Time': r.time,
      };
    }),
    count: rows.length,
    headers: ['Email', 'Name', 'Roll Number', 'Session Name', 'Date', 'Time'],
  });
});

// Export as Excel
app.get('/api/export', (req, res) => {
  const { sessionName } = req.query;

  let rows;
  if (sessionName) {
    const session = db.sessions.find(s => s.name === sessionName);
    rows = session ? db.attendance.filter(a => a.sessionId === session.id) : [];
  } else {
    rows = db.attendance;
  }

  const excelData = rows.map(r => {
    const session = db.sessions.find(s => s.id === r.sessionId);
    return {
      'Email': r.email,
      'Name': r.name,
      'Roll Number': r.rollNumber,
      'Session Name': session ? session.name : 'Unknown',
      'Date': r.date,
      'Time': r.time,
    };
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(excelData);
  ws['!cols'] = [{ wch: 30 }, { wch: 25 }, { wch: 15 }, { wch: 35 }, { wch: 14 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Attendance');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fileName = sessionName
    ? `Attendance_${sessionName.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`
    : 'Attendance_All.xlsx';

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(buffer);
});

// Get all sessions
app.get('/api/sessions', (req, res) => {
  const sessions = db.sessions.map(s => ({
    ...s,
    responseCount: db.attendance.filter(a => a.sessionId === s.id).length,
  }));
  res.json({ success: true, sessions: sessions.reverse() });
});

// Manage roll map
app.get('/api/roll-map', (req, res) => {
  res.json({ success: true, entries: db.rollMap });
});

app.post('/api/roll-map', (req, res) => {
  const { email, rollNumber } = req.body;
  if (!email || !rollNumber) {
    return res.json({ success: false, error: 'Email and roll number required' });
  }
  const emailLower = email.toLowerCase().trim();
  const existing = db.rollMap.findIndex(r => r.email === emailLower);
  if (existing >= 0) {
    db.rollMap[existing].rollNumber = rollNumber.trim();
  } else {
    db.rollMap.push({ email: emailLower, rollNumber: rollNumber.trim() });
  }
  saveDB(db);
  res.json({ success: true });
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
// STUDENT FORM HTML
// ==========================================

function getStudentFormHTML(session) {
  const isActive = session && session.active;
  const sessionName = isActive ? session.name : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Attendance</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }
    .card {
      background: rgba(30, 41, 59, 0.95);
      backdrop-filter: blur(20px);
      border-radius: 24px;
      padding: 36px 32px;
      width: 100%;
      max-width: 440px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.4), 0 0 40px rgba(99, 102, 241, 0.1);
      border: 1px solid rgba(99, 102, 241, 0.15);
    }
    .icon { text-align: center; font-size: 52px; margin-bottom: 12px; }
    h1 { text-align: center; font-size: 26px; font-weight: 800; color: #f1f5f9; margin-bottom: 4px; }
    .session-badge {
      text-align: center;
      margin: 8px auto 28px;
      background: linear-gradient(135deg, #312e81, #4338ca);
      color: #c7d2fe;
      padding: 6px 16px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
    }
    .closed {
      text-align: center;
      color: #f87171;
      font-size: 17px;
      padding: 32px 0;
      line-height: 1.7;
    }
    .field { margin-bottom: 18px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #94a3b8; margin-bottom: 8px; letter-spacing: 0.5px; text-transform: uppercase; }
    input {
      width: 100%;
      padding: 15px 18px;
      border-radius: 14px;
      border: 2px solid #334155;
      background: #0f172a;
      color: #f1f5f9;
      font-size: 16px;
      font-family: inherit;
      outline: none;
      transition: border-color 0.3s, box-shadow 0.3s;
    }
    input:focus { border-color: #6366f1; box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.15); }
    input::placeholder { color: #475569; }
    .btn {
      width: 100%;
      padding: 16px;
      border: none;
      border-radius: 14px;
      background: linear-gradient(135deg, #6366f1, #4f46e5);
      color: white;
      font-size: 17px;
      font-weight: 700;
      font-family: inherit;
      cursor: pointer;
      margin-top: 8px;
      transition: all 0.3s;
      box-shadow: 0 4px 15px rgba(99, 102, 241, 0.3);
    }
    .btn:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(99, 102, 241, 0.4); }
    .btn:active { transform: translateY(0); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .success { text-align: center; padding: 24px 0; }
    .success .check { font-size: 72px; animation: pop 0.4s ease; }
    .success h2 { color: #22c55e; font-size: 22px; margin: 16px 0 6px; }
    .success p { color: #94a3b8; font-size: 15px; }
    #error { color: #f87171; text-align: center; margin-top: 14px; font-size: 14px; font-weight: 500; display: none; }
    @keyframes pop { 0% { transform: scale(0); } 60% { transform: scale(1.2); } 100% { transform: scale(1); } }
    .note { font-size: 12px; color: #475569; margin-top: 6px; }
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
          <div class="field">
            <label>College Email</label>
            <input type="email" id="email" required placeholder="yourname@college.edu" autocomplete="email">
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
        </div>
      </div>

      <script>
        function submitForm(e) {
          e.preventDefault();
          var btn = document.getElementById('submitBtn');
          var errDiv = document.getElementById('error');
          btn.disabled = true;
          btn.textContent = '⏳ Submitting...';
          errDiv.style.display = 'none';

          fetch('/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: document.getElementById('email').value.trim(),
              name: document.getElementById('fullname').value.trim()
            })
          })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.success) {
              document.getElementById('formDiv').style.display = 'none';
              document.getElementById('successMsg').style.display = 'block';
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
        <h1 style="color:#f1f5f9; margin-bottom:16px;">Attendance</h1>
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
  console.log('  ║   📋  Attendance System Server  Running   ║');
  console.log('  ╠════════════════════════════════════════════╣');
  console.log(`  ║  Local:    http://localhost:${PORT}           ║`);
  console.log(`  ║  Network:  http://${ip}:${PORT}      ║`);
  console.log('  ╠════════════════════════════════════════════╣');
  console.log('  ║  📱 Enter the Network URL in teacher app  ║');
  console.log('  ║  📋 Students scan QR → opens the form     ║');
  console.log('  ╚════════════════════════════════════════════╝');
  console.log('');
});
