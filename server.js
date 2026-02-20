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
const nodemailer = require('nodemailer');
const localtunnel = require('localtunnel');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// COLLEGE CONFIG
// ==========================================
const ALLOWED_EMAIL_DOMAIN = 'nitjsr.ac.in';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '188263362905-05e73in41h1ib970spt6q3meoidg2fte.apps.googleusercontent.com';
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
});

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

  if (!EMAIL_USER || !EMAIL_PASS) {
    console.log('⚠️  Email credentials missing. OTP (console only):', otp);
    return res.json({
      success: false,
      error: 'Email service not configured on server. Contact Admin.'
    });
  }

  const mailOptions = {
    from: `"Attendance System" <${EMAIL_USER}>`,
    to: emailLower,
    subject: 'Password Reset OTP - Attendance App',
    text: `Your OTP for password reset is: ${otp}\n\nIt expires in 10 minutes.`,
    html: `<div style="font-family: sans-serif; padding: 20px;">
             <h2>Password Reset Request</h2>
             <p>Your OTP is:</p>
             <h1 style="color: #4f46e5; letter-spacing: 5px;">${otp}</h1>
             <p>It expires in 10 minutes.</p>
             <p style="color: #666; font-size: 12px;">If you didn't request this, ignore this email.</p>
           </div>`
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error('Error sending email:', error);
      return res.json({ success: false, error: 'Failed to send OTP email. Try again later.' });
    }
    console.log('Email sent: ' + info.response);
    // DO NOT send OTP in response
    res.json({ success: true, message: `OTP sent to ${emailLower}` });
  });
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

// Update profile
app.post('/api/update-profile', (req, res) => {
  const { email, name, college, department } = req.body;
  if (!email) return res.json({ success: false, error: 'Email is required' });

  const user = db.users.find(u => u.email === email.toLowerCase().trim());
  if (!user) return res.json({ success: false, error: 'User not found' });

  if (name !== undefined) user.name = name.trim();
  if (college !== undefined) user.college = college.trim();
  if (department !== undefined) user.department = department.trim();
  saveDB(db);

  res.json({
    success: true,
    message: 'Profile updated!',
    user: { name: user.name, email: user.email, college: user.college, department: user.department },
  });
});

// Change password (requires current password)
app.post('/api/change-password', async (req, res) => {
  const { email, currentPassword, newPassword } = req.body;
  if (!email || !currentPassword || !newPassword) {
    return res.json({ success: false, error: 'All fields are required' });
  }

  const user = db.users.find(u => u.email === email.toLowerCase().trim());
  if (!user) return res.json({ success: false, error: 'User not found' });

  const valid = await bcrypt.compare(currentPassword, user.password);
  if (!valid) return res.json({ success: false, error: 'Current password is incorrect' });

  if (newPassword.length < 4) {
    return res.json({ success: false, error: 'New password must be at least 4 characters' });
  }

  user.password = await bcrypt.hash(newPassword, 10);
  saveDB(db);

  res.json({ success: true, message: 'Password changed successfully!' });
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
  // Only block if session was explicitly stopped (has stoppedAt)
  if (session.stoppedAt) {
    return res.send(getStudentFormHTML(null, 'This session has ended.'));
  }
  res.send(getStudentFormHTML(session));
});

// ==========================================
// STUDENT SUBMISSION
// ==========================================
app.post('/submit', (req, res) => {
  const { email, name, sessionCode, lat, lon } = req.body;


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
    // Find session by code (don't require active - it may have been
    // deactivated when teacher started a new session, but students
    // with the link should still be able to submit)
    activeSession = db.sessions.find(s => s.code === sessionCode);
    if (activeSession && activeSession.stoppedAt) {
      // Session was explicitly stopped - reject
      return res.json({ success: false, error: 'This session has ended. Attendance is closed.' });
    }
  } else {
    activeSession = db.sessions.find(s => s.active);
  }
  if (!activeSession) {
    return res.json({ success: false, error: 'No active session. The link may have expired.' });
  }

  // Check duplicate
  if (dup) {
    return res.json({ success: false, error: 'You have already submitted for this session.' });
  }

  // Check time limit (10 mins)
  const SESSION_DURATION = 10 * 60 * 1000;
  if (Date.now() - activeSession.id > SESSION_DURATION) {
    return res.json({ success: false, error: 'Session expired (10 mins limit exceeded).' });
  }

  // --- LOCATION VALIDATION ---
  if (activeSession.lat && activeSession.lon) {
    if (!lat || !lon) {
      return res.json({ success: false, error: 'Location permission is required. Please allow location access.' });
    }

    const dist = getDistanceFromLatLonInMeters(activeSession.lat, activeSession.lon, lat, lon);
    console.log(`📏 Distance Check: ${dist.toFixed(2)}m (Max: 80m)`);

    if (dist > 80) {
      return res.json({ success: false, error: `You are too far (${dist.toFixed(0)}m). Must be within 80m of the classroom.` });
    }
  }
  // ---------------------------

  // Auto-parse roll info from email
  const rollInfo = parseRollInfo(emailLower);

  const now = new Date();
  db.attendance.push({
    sessionId: activeSession.id,
    email: emailLower,
    name: name.trim(),
    regNo: rollInfo.rollNumber,
    year: rollInfo.year,
    program: rollInfo.program,
    branch: rollInfo.branch,
    rollNo: rollInfo.rollNo,
    submittedAt: now.toISOString(),
    date: now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }),
    time: now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  });
  saveDB(db);

  res.json({ success: true, message: 'Attendance recorded!' });
});

// ==========================================
// TEACHER API
// ==========================================

app.post('/api/start-session', (req, res) => {
  const { sessionName, lat, lon } = req.body;
  if (!sessionName || !sessionName.trim()) {
    return res.json({ success: false, error: 'Session name is required' });
  }

  // Allow multiple sessions instead of stopping older ones

  const id = Date.now();
  const code = generateSessionCode();
  db.sessions.push({
    id: id,
    name: sessionName.trim(),
    code: code,
    createdAt: new Date().toISOString(),
    active: true,
    lat: lat || null,
    lon: lon || null,
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
  const now = new Date().toISOString();
  db.sessions.forEach(s => {
    if (s.active) {
      s.active = false;
      s.stoppedAt = now;
    }
  });
  saveDB(db);
  res.json({ success: true, message: 'Session stopped' });
});

// Stop a specific session by ID (from history)
app.post('/api/sessions/:id/stop', (req, res) => {
  const id = parseInt(req.params.id);
  const session = db.sessions.find(s => s.id === id);
  if (!session) return res.json({ success: false, error: 'Session not found' });
  if (!session.active) return res.json({ success: false, error: 'Session already stopped' });
  session.active = false;
  session.stoppedAt = new Date().toISOString();
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

  // Sort by roll number ascending
  rows.sort((a, b) => {
    const ra = (a.rollNo || '').toString();
    const rb = (b.rollNo || '').toString();
    return ra.localeCompare(rb, undefined, { numeric: true });
  });

  res.json({
    success: true,
    responses: rows.map(r => {
      const session = db.sessions.find(s => s.id === r.sessionId);
      return {
        'Roll No': r.rollNo || '-',
        'Name': r.name,
        'Reg No': r.regNo || r.rollNumber || '-',
        'Email': r.email,
        'Year': r.year || '-',
        'Program': r.program || '-',
        'Branch': r.branch || '-',
        'Session': session ? session.name : 'Unknown',
        'Date': r.date,
        'Time': r.time,
      };
    }),
    count: rows.length,
    headers: ['Roll No', 'Name', 'Reg No', 'Email', 'Year', 'Program', 'Branch', 'Session', 'Date', 'Time'],
  });
});

// Session history
app.get('/api/history', (req, res) => {
  const sessions = db.sessions.map(s => ({
    id: s.id,
    name: s.name,
    createdAt: s.createdAt,
    stoppedAt: s.stoppedAt || null,
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

  // Sort by roll number ascending
  rows.sort((a, b) => {
    const ra = (a.rollNo || '').toString();
    const rb = (b.rollNo || '').toString();
    return ra.localeCompare(rb, undefined, { numeric: true });
  });

  const excelData = rows.map(r => {
    const session = db.sessions.find(s => s.id === r.sessionId);
    return {
      'Roll No': r.rollNo || '-',
      'Name': r.name,
      'Reg No': r.regNo || r.rollNumber || '-',
      'Email': r.email,
      'Year': r.year || '-',
      'Program': r.program || '-',
      'Branch': r.branch || '-',
      'Session': session ? session.name : 'Unknown',
      'Date': r.date,
      'Time': r.time,
    };
  });

  const excelHeaders = ['Roll No', 'Name', 'Reg No', 'Email', 'Year', 'Program', 'Branch', 'Session', 'Date', 'Time'];
  const wb = XLSX.utils.book_new();
  if (excelData.length === 0) {
    const ws = XLSX.utils.aoa_to_sheet([excelHeaders]);
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
  } else {
    const ws = XLSX.utils.json_to_sheet(excelData);
    ws['!cols'] = [{ wch: 8 }, { wch: 25 }, { wch: 18 }, { wch: 30 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 35 }, { wch: 14 }, { wch: 10 }];
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

  const excelHeaders = ['Roll No', 'Name', 'Reg No', 'Email', 'Year', 'Program', 'Branch', 'Session', 'Date', 'Time'];

  if (rows.length === 0) {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([excelHeaders]);
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Attendance_Empty.xlsx"`);
    return res.send(Buffer.from(buffer));
  }

  // Sort by roll number ascending
  rows.sort((a, b) => {
    const ra = (a.rollNo || '').toString();
    const rb = (b.rollNo || '').toString();
    return ra.localeCompare(rb, undefined, { numeric: true });
  });

  const excelData = rows.map(r => {
    const session = db.sessions.find(s => s.id === r.sessionId);
    return {
      'Roll No': r.rollNo || '-',
      'Name': r.name,
      'Reg No': r.regNo || r.rollNumber || '-',
      'Email': r.email,
      'Year': r.year || '-',
      'Program': r.program || '-',
      'Branch': r.branch || '-',
      'Session': session ? session.name : 'Unknown',
      'Date': r.date,
      'Time': r.time,
    };
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(excelData);
  ws['!cols'] = [
    { wch: 8 }, { wch: 25 }, { wch: 18 }, { wch: 30 },
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

function getDistanceFromLatLonInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function deg2rad(deg) {
  return deg * (Math.PI / 180);
}

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
  const useGoogleSignIn = !!GOOGLE_CLIENT_ID;
  const requireLocation = isActive && session && session.lat && session.lon;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Attendance — NIT Jamshedpur</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  ${useGoogleSignIn ? '<script src="https://accounts.google.com/gsi/client" async defer></script>' : ''}
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
    input[readonly] { background: #1e293b; color: #22c55e; border-color: #22c55e40; cursor: default; }

    /* Google account display */
    .account-card {
      display: flex; align-items: center; gap: 14px;
      background: #0f172a; border: 2px solid #22c55e40; border-radius: 14px;
      padding: 14px 18px; margin-bottom: 8px;
    }
    .account-avatar {
      width: 44px; height: 44px; border-radius: 50%;
      background: linear-gradient(135deg, #6366f1, #4f46e5);
      display: flex; align-items: center; justify-content: center;
      font-size: 20px; font-weight: 700; color: white; flex-shrink: 0;
    }
    .account-info { flex: 1; }
    .account-email { font-size: 15px; color: #22c55e; font-weight: 600; }
    .account-name { font-size: 12px; color: #64748b; margin-top: 2px; }
    .account-badge { font-size: 10px; background: #052e16; color: #22c55e; padding: 2px 8px; border-radius: 6px; font-weight: 600; }

    .change-link { display: block; text-align: right; color: #818cf8; font-size: 13px; font-weight: 600; cursor: pointer; margin-top: 6px; }

    .google-btn-wrap { text-align: center; margin-bottom: 24px; }
    .google-btn-custom {
      display: inline-flex; align-items: center; gap: 12px;
      padding: 14px 28px; border-radius: 14px;
      background: white; color: #1f2937; font-size: 16px; font-weight: 600;
      font-family: inherit; cursor: pointer; border: none;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2); transition: all 0.3s;
    }
    .google-btn-custom:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.3); transform: translateY(-1px); }
    .google-btn-custom img { width: 22px; height: 22px; }

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
    .step-indicator { text-align: center; color: #64748b; font-size: 13px; margin-bottom: 20px; }
    .step-indicator strong { color: #6366f1; }
    @keyframes pop { 0% { transform: scale(0); } 60% { transform: scale(1.2); } 100% { transform: scale(1); } }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    .fade-in { animation: fadeIn 0.3s ease; }
  </style>
</head>
<body>
  <div class="card" style="text-align: center;">
    ${isActive ? `
      <div class="icon">📋</div>
      <h1>Mark Attendance</h1>
      <div class="session-badge">${escapeHtml(sessionName)}</div>

      <!-- Step 1: Sign in with Google -->
      <div id="step1">
        <div class="step-indicator"><strong>Step 1</strong> — Verify your identity</div>
        ${useGoogleSignIn ? `
          <div class="google-btn-wrap">
            <div id="g_id_onload"
                 data-client_id="${GOOGLE_CLIENT_ID}"
                 data-callback="handleGoogleResponse"
                 data-auto_prompt="false">
            </div>
            <div class="g_id_signin"
                 data-type="standard"
                 data-size="large"
                 data-theme="filled_blue"
                 data-text="signin_with"
                 data-shape="pill"
                 data-width="300">
            </div>
          </div>
          <div class="domain-note">
            ⚠️ Select your <strong>@${ALLOWED_EMAIL_DOMAIN}</strong> account
          </div>
        ` : `
          <div class="field" style="text-align:left;">
            <label>College Email</label>
            <input type="email" id="emailFallback" required
              placeholder="yourname@${ALLOWED_EMAIL_DOMAIN}"
              autocomplete="email">
            <div class="domain-note">
              ⚠️ Only <strong>@${ALLOWED_EMAIL_DOMAIN}</strong> emails accepted
            </div>
          </div>
          <button type="button" class="btn" onclick="useFallbackEmail()" style="margin-bottom: 16px;">Continue →</button>
        `}
      </div>

      <!-- Step 2: Confirm & submit (shown after sign-in) -->
      <div id="step2" style="display:none;" class="fade-in">
        <div class="step-indicator"><strong>Step 2</strong> — Confirm & submit</div>
        
        <div class="account-card">
          <div class="account-avatar" id="avatarLetter">?</div>
          <div class="account-info">
            <div class="account-email" id="displayEmail">—</div>
            <div class="account-name" id="displayName">—</div>
          </div>
          <div class="account-badge">✓ Verified</div>
        </div>
        <div class="change-link" onclick="changeAccount()">Change account</div>

        <form id="attendanceForm" onsubmit="return submitForm(event)" style="text-align:left; margin-top: 16px;">
          <input type="hidden" id="email" value="">
          <input type="hidden" id="lat" value="">
          <input type="hidden" id="lon" value="">

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
        var selectedEmail = '';
        var selectedName = '';
        var requireLocation = ${requireLocation};

        if (requireLocation) {
             const btn = document.getElementById('submitBtn');
             // Initially disable if location required
             // We will try to fetch it when they reach step 2, or eagerly
        }

        function checkLocation() {
            if (!requireLocation) return;
            var btn = document.getElementById('submitBtn');
            var latInput = document.getElementById('lat');
            var lonInput = document.getElementById('lon');

            if (!latInput.value) {
                btn.disabled = true;
                btn.textContent = '📍 Getting Location...';
                
                if (navigator.geolocation) {
                    navigator.geolocation.getCurrentPosition(
                        function(pos) {
                            latInput.value = pos.coords.latitude;
                            lonInput.value = pos.coords.longitude;
                            btn.disabled = false;
                            btn.textContent = '✅ Submit Attendance';
                        },
                        function(err) {
                            btn.textContent = '⚠️ Location Required';
                            showError('Location blocked by your scanner app!<br><br>You <b>MUST</b> open this in Chrome/Safari to allow location.<br><br><button type="button" onclick="navigator.clipboard.writeText(window.location.href); alert(\'Link copied! Now open Chrome, Safari, or your main web browser and paste it in the top bar.\')" style="background:#ef4444; color:white; padding:10px; border:none; border-radius:8px; cursor:pointer; width:100%; font-weight:bold; font-size:14px; margin-top:5px;">📋 Copy Link to Open in Browser</button>');
                        },
                        { enableHighAccuracy: true, timeout: 10000 }
                    );
                } else {
                    showError('Geolocation is not supported by this browser.');
                }
            }
        }

        // Google Sign-In callback
        function handleGoogleResponse(response) {
          try {
            // Decode JWT payload
            var parts = response.credential.split('.');
            var payload = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));
            var email = payload.email.toLowerCase();
            var name = payload.name || '';

            // Check domain
            if (!email.endsWith('@${ALLOWED_EMAIL_DOMAIN}')) {
              showError('Please select your @${ALLOWED_EMAIL_DOMAIN} account, not ' + email);
              return;
            }

            setVerifiedEmail(email, name);
          } catch(e) {
            showError('Failed to verify Google account. Try again.');
          }
        }

        // Fallback: manual email entry (when Google Client ID not set)
        function useFallbackEmail() {
          var emailInput = document.getElementById('emailFallback');
          if (!emailInput) return;
          var email = emailInput.value.trim().toLowerCase();
          if (!email) { showError('Please enter your email.'); return; }
          if (!email.endsWith('@${ALLOWED_EMAIL_DOMAIN}')) {
            showError('Only @${ALLOWED_EMAIL_DOMAIN} emails allowed.');
            return;
          }
          setVerifiedEmail(email, '');
        }

        function setVerifiedEmail(email, name) {
          selectedEmail = email;
          selectedName = name;

          // Update UI
          document.getElementById('email').value = email;
          document.getElementById('displayEmail').textContent = email;
          document.getElementById('displayName').textContent = name || email.split('@')[0];
          document.getElementById('avatarLetter').textContent = email[0].toUpperCase();
          if (name) document.getElementById('fullname').value = name;

          // Switch to step 2
          document.getElementById('step1').style.display = 'none';
          document.getElementById('step2').style.display = 'block';
          document.getElementById('step2').style.display = 'block';
          hideError();
          if (requireLocation) checkLocation();
        }

        function changeAccount() {
          selectedEmail = '';
          selectedName = '';
          document.getElementById('email').value = '';
          document.getElementById('step1').style.display = 'block';
          document.getElementById('step2').style.display = 'none';
        }

        function showError(msg) {
          var errDiv = document.getElementById('error');
          errDiv.innerHTML = msg;
          errDiv.style.display = 'block';
        }
        function hideError() {
          var errDiv = document.getElementById('error');
          if (errDiv) errDiv.style.display = 'none';
        }

        function submitForm(e) {
          e.preventDefault();
          var btn = document.getElementById('submitBtn');
          var emailVal = document.getElementById('email').value.trim().toLowerCase();

          if (!emailVal || !emailVal.endsWith('@${ALLOWED_EMAIL_DOMAIN}')) {
            showError('Invalid email. Please sign in again.');
            return false;
          }

          btn.disabled = true;
          btn.textContent = '⏳ Submitting...';
          hideError();

          fetch('/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: emailVal,
              name: document.getElementById('fullname').value.trim(),
              sessionCode: '${sessionCode}',
              lat: document.getElementById('lat').value,
              lon: document.getElementById('lon').value
            })
          })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.success) {
              document.getElementById('step2').style.display = 'none';
              document.getElementById('successMsg').style.display = 'block';
              var rollPart = emailVal.split('@')[0].toUpperCase();
              document.getElementById('rollDisplay').textContent = 'Roll: ' + rollPart;
            } else {
              showError(data.error || 'Failed');
              btn.disabled = false;
              btn.textContent = '✅ Submit Attendance';
            }
          })
          .catch(function() {
            showError('Network error. Try again.');
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
        ${errorMsg ? '<p style="color:#f59e0b;font-size:16px;margin-bottom:12px;">' + escapeHtml(errorMsg) + '</p>' : ''}
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
app.listen(PORT, '0.0.0.0', async () => {
  const ip = getLocalIP();
  console.log('');
  console.log('  ╔════════════════════════════════════════════╗');
  console.log('  ║   📋  Attendance Server — NIT Jamshedpur  ║');
  console.log('  ╠════════════════════════════════════════════╣');
  console.log(`  ║  Local:    http://localhost:${PORT}           ║`);
  console.log(`  ║  Network:  http://${ip}:${PORT}      ║`);

  if (!process.env.RENDER_EXTERNAL_URL) {
    process.env.RENDER_EXTERNAL_URL = 'https://attendance-server-ddgs.onrender.com';
  }

  console.log('  ╠════════════════════════════════════════════╣');
  console.log(`  ║  Email Domain: @${ALLOWED_EMAIL_DOMAIN}      ║`);
  console.log('  ║  Data Retention: 2 days                   ║');
  console.log(`  ║  Google Sign-In: ${GOOGLE_CLIENT_ID ? '✅ Enabled' : '❌ Not set'}        ║`);
  console.log('  ╚════════════════════════════════════════════╝');
  console.log('');

  // Auto-close any session that exceeds 10 minutes
  setInterval(() => {
    let changed = false;
    const nowMs = Date.now();
    db.sessions.forEach(s => {
      // s.id is the creation timestamp
      if (s.active && (nowMs - s.id > 10 * 60 * 1000)) {
        s.active = false;
        // Strictly set stoppedAt to exactly 10 minutes from creation
        s.stoppedAt = new Date(s.id + 10 * 60 * 1000).toISOString();
        changed = true;
      }
    });
    if (changed) saveDB(db);
  }, 10000); // check every 10 seconds

});

