// =============================================
// Attendance System — MongoDB Atlas Edition
// =============================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const fs = require('fs');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { Jimp } = require('jimp');
const jsQR = require('jsqr');
const crypto = require('crypto');
const mongoose = require('mongoose');

const upload = multer({ storage: multer.memoryStorage() });
const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// COLLEGE CONFIG
// ==========================================
const ALLOWED_EMAIL_DOMAIN = 'nitjsr.ac.in';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '188263362905-05e73in41h1ib970spt6q3meoidg2fte.apps.googleusercontent.com';
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'work.anuragkishan@gmail.com';
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || 'Attendance System';

// Send email via Brevo HTTP API (works on Render free tier — no SMTP needed, 300 emails/day free)
async function sendEmail(to, subject, html) {
  if (!BREVO_API_KEY) {
    console.log('  ⚠️  BREVO_API_KEY not configured. Email not sent.');
    return { success: false, error: 'Email service not configured. Contact Admin.' };
  }
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { name: EMAIL_FROM_NAME, email: EMAIL_FROM },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      }),
    });
    const data = await res.json();
    if (res.ok) return { success: true };
    if (res.status === 429) return { success: false, error: 'Daily email limit reached. Please try again tomorrow.' };
    console.error('Brevo API error:', data);
    return { success: false, error: data.message || 'Email send failed.' };
  } catch (err) {
    console.error('Email send error:', err.message);
    return { success: false, error: 'Email service unreachable.' };
  }
}

function generateSessionCode() {
  return crypto.randomBytes(4).toString('hex');
}

function parseRollInfo(email) {
  const local = email.split('@')[0].toLowerCase();
  const match = local.match(/^(\d{4})(ug|pg)([a-z]{2,4})(\d+)$/i);
  if (match) {
    return {
      year: match[1],
      program: match[2].toUpperCase(),
      branch: match[3].toUpperCase(),
      rollNo: match[4],
      rollNumber: local.toUpperCase(),
    };
  }
  return { year: '-', program: '-', branch: '-', rollNo: '-', rollNumber: local.toUpperCase() };
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function getDistanceFromLatLonInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ==========================================
// MONGOOSE CONNECTION (background, non-blocking)
// ==========================================
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('❌  MONGO_URI environment variable is not set.');
  process.exit(1);
}

let dbReady = false;

async function connectDB() {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 30000,
        connectTimeoutMS: 30000,
      });
      console.log('  ✅  MongoDB Atlas connected.');
      dbReady = true;
      return;
    } catch (err) {
      console.error(`  ❌  MongoDB attempt ${attempt}/10: ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.error('  ❌  Could not connect to MongoDB after 10 attempts.');
}

// ==========================================
// MONGOOSE SCHEMAS & MODELS
// ==========================================

// Teacher accounts
const TeacherSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true, index: true },
  email: { type: String, required: true, unique: true, lowercase: true, index: true },
  name: { type: String, required: true },
  college: { type: String, default: '' },
  department: { type: String, default: '' },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});
const Teacher = mongoose.model('Teacher', TeacherSchema);

// OTP store (auto-deletes via MongoDB TTL)
const OTPSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  otpHash: { type: String, required: true },              // bcrypt-hashed OTP — NEVER stored as plaintext
  expiresAt: { type: Date, required: true, index: { expires: 0 } }, // TTL: MongoDB auto-deletes expired docs
  failedAttempts: { type: Number, default: 0 },                  // Rate limiting: max 5 failed tries
  lockedUntil: { type: Date, default: null },                 // Lockout timestamp after too many failures
  lastRequestedAt: { type: Date, default: null },                 // Cooldown: 60s between OTP requests
});
const OTP = mongoose.model('OTP', OTPSchema);

// Attendance Sessions (retained 6 months)
const SessionSchema = new mongoose.Schema({
  sessionId: { type: Number, required: true, unique: true, index: true }, // Date.now() — preserved for compatibility
  name: { type: String, required: true },
  code: { type: String, required: true, unique: true, index: true },
  createdAt: { type: Date, default: Date.now, index: true },
  active: { type: Boolean, default: true, index: true },
  stoppedAt: { type: Date, default: null },
  lat: { type: Number, default: null },
  lon: { type: Number, default: null },
});
// TTL: auto-delete sessions older than 6 months
SessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 183 * 24 * 60 * 60 });
const Session = mongoose.model('Session', SessionSchema);

// Attendance Records (retained 4 years)
const AttendanceSchema = new mongoose.Schema({
  sessionId: { type: Number, required: true, index: true },  // matches Session.sessionId
  email: { type: String, required: true, lowercase: true, index: true },
  name: { type: String },
  regNo: { type: String },
  year: { type: String },
  program: { type: String },
  branch: { type: String },
  rollNo: { type: String },
  submittedAt: { type: Date, default: Date.now },
  date: { type: String },
  time: { type: String },
});
// Compound unique: no double-submission per session per student
AttendanceSchema.index({ sessionId: 1, email: 1 }, { unique: true });
// TTL: auto-delete attendance older than 4 years
AttendanceSchema.index({ submittedAt: 1 }, { expireAfterSeconds: 4 * 365 * 24 * 60 * 60 });
const Attendance = mongoose.model('Attendance', AttendanceSchema);

// Device Bindings (permanent — never auto-deleted)
const DeviceSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, index: true },
  deviceId: { type: String, required: true, unique: true, index: true }, // stored as SHA-256 hash from client
  registeredAt: { type: Date, default: Date.now },
});
const Device = mongoose.model('Device', DeviceSchema);

// ==========================================
// MIDDLEWARE (SECURITY & PARSERS)
// ==========================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const APP_SECRET_KEY = process.env.APP_SECRET_KEY;
const LEGACY_APP_SECRET = process.env.LEGACY_APP_SECRET || '';  // old key — remove after all users update APK
if (!APP_SECRET_KEY) {
  console.error('❌  APP_SECRET_KEY environment variable is not set.');
  process.exit(1);
}

// App secret check (accepts both new key and legacy key during transition)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    const clientKey = req.headers['x-app-secret'];
    if (clientKey !== APP_SECRET_KEY && clientKey !== LEGACY_APP_SECRET) {
      return res.status(403).json({ success: false, error: 'Access Denied: Unofficial Client.' });
    }
  }
  next();
});

// DB ready guard — return 503 if MongoDB not yet connected
app.use('/api', (req, res, next) => {
  if (!dbReady) {
    return res.status(503).json({ success: false, error: 'Server starting up, please retry in a few seconds.' });
  }
  next();
});

// ==========================================
// TEACHER AUTH ENDPOINTS
// ==========================================

app.post('/api/register', async (req, res) => {
  const { email, password, name, college, department } = req.body;
  if (!email || !password || !name)
    return res.json({ success: false, error: 'Name, email and password are required' });

  const emailLower = email.toLowerCase().trim();
  const existing = await Teacher.findOne({ email: emailLower });
  if (existing)
    return res.json({ success: false, error: 'An account with this email already exists' });

  if (password.length < 4)
    return res.json({ success: false, error: 'Password must be at least 4 characters' });

  const hashedPassword = await bcrypt.hash(password, 10);
  await Teacher.create({
    id: Date.now(),
    email: emailLower,
    name: name.trim(),
    college: (college || '').trim(),
    department: (department || '').trim(),
    password: hashedPassword,
  });
  res.json({ success: true, message: 'Account created! You can now login.' });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.json({ success: false, error: 'Email and password are required' });

  const emailLower = email.toLowerCase().trim();
  const user = await Teacher.findOne({ email: emailLower });
  if (!user)
    return res.json({ success: false, error: 'No account found with this email' });

  const match = await bcrypt.compare(password, user.password);
  if (!match)
    return res.json({ success: false, error: 'Incorrect password' });

  res.json({
    success: true,
    user: { id: user.id, email: user.email, name: user.name, college: user.college || '', department: user.department || '' },
  });
});

app.post('/api/update-profile', async (req, res) => {
  const { email, name, college, department } = req.body;
  if (!email) return res.json({ success: false, error: 'Email is required' });

  const emailLower = email.toLowerCase().trim();
  const user = await Teacher.findOne({ email: emailLower });
  if (!user) return res.json({ success: false, error: 'User not found' });

  if (name) user.name = name.trim();
  if (college !== undefined) user.college = college.trim();
  if (department !== undefined) user.department = department.trim();
  await user.save();

  res.json({
    success: true,
    message: 'Profile updated!',
    user: { name: user.name, email: user.email, college: user.college, department: user.department },
  });
});

// ---- SECURE OTP PASSWORD RESET ----

app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.json({ success: false, error: 'Email is required' });

  const emailLower = email.toLowerCase().trim();
  const user = await Teacher.findOne({ email: emailLower });
  if (!user) return res.json({ success: false, error: 'No account found with this email' });

  // ── COOLDOWN: 60 seconds between OTP requests ──
  const existingOtp = await OTP.findOne({ email: emailLower });
  if (existingOtp && existingOtp.lastRequestedAt) {
    const elapsed = Date.now() - existingOtp.lastRequestedAt.getTime();
    if (elapsed < 60 * 1000) {
      const wait = Math.ceil((60 * 1000 - elapsed) / 1000);
      return res.json({ success: false, error: `Please wait ${wait} seconds before requesting a new OTP.` });
    }
  }

  // ── GENERATE OTP using crypto (NOT Math.random) ──
  const otp = crypto.randomInt(100000, 999999).toString();

  // ── HASH OTP before storing (NEVER store plaintext) ──
  const otpHash = await bcrypt.hash(otp, 10);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await OTP.findOneAndUpdate(
    { email: emailLower },
    { otpHash, expiresAt, failedAttempts: 0, lockedUntil: null, lastRequestedAt: new Date() },
    { upsert: true, new: true }
  );

  // ── SEND OTP via Brevo HTTP API — never log or expose ──
  const emailHtml = `<div style="font-family:sans-serif;padding:20px;">
    <p>Hi <strong>${user.name}</strong>,</p>
    <p>Your OTP is: <strong style="font-size:24px;letter-spacing:4px;">${otp}</strong></p>
    <p>It expires in 10 minutes. Do not share this with anyone.</p>
  </div>`;

  const emailResult = await sendEmail(emailLower, 'Password Reset OTP - Attendance App', emailHtml);
  if (!emailResult.success) {
    return res.json({ success: false, error: emailResult.error });
  }
  // ── RESPONSE: success message ONLY — no OTP, no hints ──
  res.json({ success: true, message: `OTP sent to ${emailLower}` });
});

app.post('/api/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword)
    return res.json({ success: false, error: 'Email, OTP and new password are required' });

  const emailLower = email.toLowerCase().trim();
  const otpEntry = await OTP.findOne({ email: emailLower });
  if (!otpEntry) return res.json({ success: false, error: 'Invalid or expired OTP.' });

  // ── RATE LIMIT: check if locked out ──
  if (otpEntry.lockedUntil && Date.now() < otpEntry.lockedUntil.getTime()) {
    const mins = Math.ceil((otpEntry.lockedUntil.getTime() - Date.now()) / 60000);
    return res.json({ success: false, error: `Too many failed attempts. Try again in ${mins} minute(s).` });
  }

  // ── EXPIRY CHECK ──
  if (Date.now() > otpEntry.expiresAt.getTime()) {
    await OTP.deleteOne({ email: emailLower });
    return res.json({ success: false, error: 'OTP has expired. Request a new one.' });
  }

  // ── VERIFY OTP via bcrypt.compare (secure) ──
  const otpValid = await bcrypt.compare(otp, otpEntry.otpHash);
  if (!otpValid) {
    // Increment failed attempts
    otpEntry.failedAttempts += 1;
    if (otpEntry.failedAttempts >= 5) {
      // Lock for 15 minutes after 5 fails
      otpEntry.lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
      otpEntry.failedAttempts = 0;
      await otpEntry.save();
      return res.json({ success: false, error: 'Too many incorrect attempts. Locked for 15 minutes.' });
    }
    await otpEntry.save();
    return res.json({ success: false, error: `Invalid OTP. ${5 - otpEntry.failedAttempts} attempt(s) remaining.` });
  }

  // ── PASSWORD VALIDATION ──
  if (newPassword.length < 4)
    return res.json({ success: false, error: 'Password must be at least 4 characters' });

  const user = await Teacher.findOne({ email: emailLower });
  if (!user) return res.json({ success: false, error: 'User not found' });

  // ── UPDATE PASSWORD & DESTROY OTP ──
  user.password = await bcrypt.hash(newPassword, 10);
  await user.save();
  await OTP.deleteOne({ email: emailLower });

  res.json({ success: true, message: 'Password reset! You can now login.' });
});

app.post('/api/change-password', async (req, res) => {
  const { email, currentPassword, newPassword } = req.body;
  if (!email || !currentPassword || !newPassword)
    return res.json({ success: false, error: 'All fields are required' });

  const user = await Teacher.findOne({ email: email.toLowerCase().trim() });
  if (!user) return res.json({ success: false, error: 'User not found' });

  const valid = await bcrypt.compare(currentPassword, user.password);
  if (!valid) return res.json({ success: false, error: 'Current password is incorrect' });

  if (newPassword.length < 4)
    return res.json({ success: false, error: 'New password must be at least 4 characters' });

  user.password = await bcrypt.hash(newPassword, 10);
  await user.save();
  res.json({ success: true, message: 'Password changed successfully!' });
});

// ==========================================
// STUDENT FORM WEB PAGE
// ==========================================
app.get('/', async (req, res) => {
  const activeSession = await Session.findOne({ active: true });
  if (activeSession && activeSession.code) {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://${getLocalIP()}:${PORT}`;
    return res.redirect(`/s/${activeSession.code}`);
  }
  res.send(getStudentFormHTML(null));
});

app.get('/s/:code', async (req, res) => {
  const { code } = req.params;
  const session = await Session.findOne({ code });
  if (!session) return res.send(getStudentFormHTML(null, 'Invalid or expired session link.'));
  if (session.stoppedAt) return res.send(getStudentFormHTML(null, 'This session has ended.'));
  res.send(getStudentFormHTML(session));
});

// ==========================================
// STUDENT MOBILE V2 API
// ==========================================

app.post('/api/student/login', async (req, res) => {
  const { email, deviceId } = req.body;
  if (!email || !deviceId)
    return res.json({ success: false, error: 'Email and deviceId are required' });

  const emailLower = email.toLowerCase().trim();
  if (!emailLower.endsWith('@' + ALLOWED_EMAIL_DOMAIN))
    return res.json({ success: false, error: `Only @${ALLOWED_EMAIL_DOMAIN} emails are allowed.` });

  // 1 Phone = 1 Email: check if this deviceId is already bound to a DIFFERENT email
  const existingDevice = await Device.findOne({ deviceId });
  if (existingDevice) {
    if (existingDevice.email !== emailLower) {
      return res.json({
        success: false,
        error: `This phone is already bound to ${existingDevice.email}. Using multiple emails on one phone is NOT allowed.`,
      });
    }
    // Same device + same email = returning user
    return res.json({ success: true, message: 'Welcome back!' });
  }

  // New device — register it (email can have multiple devices)
  await Device.create({ email: emailLower, deviceId });
  res.json({ success: true, message: 'Device securely registered!' });
});

app.post('/api/student/decode-qr', upload.single('qrimage'), async (req, res) => {
  if (!req.file) return res.json({ success: false, error: 'No image uploaded.' });
  try {
    const image = await Jimp.fromBuffer(req.file.buffer);
    const { width, height, data } = image.bitmap;
    const imageData = new Uint8ClampedArray(data);
    const code = jsQR(imageData, width, height);
    if (code && code.data) return res.json({ success: true, data: code.data });
    return res.json({ success: false, error: 'No QR code found in the image.' });
  } catch (error) {
    console.error(error);
    return res.json({ success: false, error: 'Failed to process image file on server.' });
  }
});

app.post('/api/student/submit', async (req, res) => {
  const { email, deviceId, sessionCode, lat, lon } = req.body;
  if (!email || !deviceId || !sessionCode)
    return res.json({ success: false, error: 'Missing required fields' });

  const emailLower = email.toLowerCase().trim();

  // Validate device binding: the deviceId must exist and match this email
  const boundDevice = await Device.findOne({ deviceId });
  if (!boundDevice || boundDevice.email !== emailLower)
    return res.json({ success: false, error: 'Unregistered device. Please sign in again.' });

  // Find session by code
  const activeSession = await Session.findOne({ code: sessionCode });
  if (!activeSession) return res.json({ success: false, error: 'Invalid or expired session QR.' });
  if (activeSession.stoppedAt) return res.json({ success: false, error: 'This session has ended. Attendance is closed.' });

  // Check 10-min expiry (session.sessionId is Date.now() timestamp)
  if (Date.now() - activeSession.sessionId > 10 * 60 * 1000)
    return res.json({ success: false, error: 'Session expired (10 mins limit exceeded).' });

  // Location check
  if (activeSession.lat && activeSession.lon) {
    if (!lat || !lon)
      return res.json({ success: false, error: 'Location permission completely blocked. Allow in settings.' });
    const dist = getDistanceFromLatLonInMeters(activeSession.lat, activeSession.lon, lat, lon);
    if (dist > 80)
      return res.json({ success: false, error: `You are too far (${dist.toFixed(0)}m). Must be within 80m.` });
  }

  const rollInfo = parseRollInfo(emailLower);
  const now = new Date();

  try {
    await Attendance.create({
      sessionId: activeSession.sessionId,
      email: emailLower,
      name: emailLower.split('@')[0],
      regNo: rollInfo.rollNumber,
      year: rollInfo.year,
      program: rollInfo.program,
      branch: rollInfo.branch,
      rollNo: rollInfo.rollNo,
      submittedAt: now,
      date: now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }),
      time: now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    });
  } catch (e) {
    if (e.code === 11000) // duplicate key = already submitted
      return res.json({ success: false, error: 'You have already submitted for this session.' });
    throw e;
  }

  res.json({ success: true, message: 'Attendance smoothly recorded!' });
});

// ==========================================
// STUDENT WEB SUBMISSION (LEGACY/FALLBACK)
// ==========================================
app.post('/submit', async (req, res) => {
  const { email, name, sessionCode, lat, lon } = req.body;
  if (!email || !name) return res.json({ success: false, error: 'Email and name are required' });

  const emailLower = email.toLowerCase().trim();
  if (!emailLower.endsWith('@' + ALLOWED_EMAIL_DOMAIN))
    return res.json({ success: false, error: `Only @${ALLOWED_EMAIL_DOMAIN} emails are allowed.` });

  let activeSession;
  if (sessionCode) {
    activeSession = await Session.findOne({ code: sessionCode });
    if (activeSession && activeSession.stoppedAt)
      return res.json({ success: false, error: 'This session has ended. Attendance is closed.' });
  } else {
    activeSession = await Session.findOne({ active: true });
  }
  if (!activeSession)
    return res.json({ success: false, error: 'No active session. The link may have expired.' });

  if (Date.now() - activeSession.sessionId > 10 * 60 * 1000)
    return res.json({ success: false, error: 'Session expired (10 mins limit exceeded).' });

  if (activeSession.lat && activeSession.lon) {
    if (!lat || !lon)
      return res.json({ success: false, error: 'Location permission is required.' });
    const dist = getDistanceFromLatLonInMeters(activeSession.lat, activeSession.lon, lat, lon);
    if (dist > 80)
      return res.json({ success: false, error: `You are too far (${dist.toFixed(0)}m). Must be within 80m.` });
  }

  const rollInfo = parseRollInfo(emailLower);
  const now = new Date();

  try {
    await Attendance.create({
      sessionId: activeSession.sessionId,
      email: emailLower,
      name: name.trim(),
      regNo: rollInfo.rollNumber,
      year: rollInfo.year,
      program: rollInfo.program,
      branch: rollInfo.branch,
      rollNo: rollInfo.rollNo,
      submittedAt: now,
      date: now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }),
      time: now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
    });
  } catch (e) {
    if (e.code === 11000)
      return res.json({ success: false, error: 'You have already submitted for this session.' });
    throw e;
  }
  res.json({ success: true, message: 'Attendance recorded!' });
});

// ==========================================
// TEACHER SESSION API
// ==========================================

app.post('/api/start-session', async (req, res) => {
  const { sessionName, lat, lon } = req.body;
  if (!sessionName || !sessionName.trim())
    return res.json({ success: false, error: 'Session name is required' });

  const id = Date.now();
  const code = generateSessionCode();

  await Session.create({
    sessionId: id,
    name: sessionName.trim(),
    code,
    createdAt: new Date(),
    active: true,
    lat: lat || null,
    lon: lon || null,
  });

  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://${getLocalIP()}:${PORT}`;
  res.json({ success: true, sessionId: id, sessionName: sessionName.trim(), formUrl: `${baseUrl}/s/${code}` });
});

app.post('/api/stop-session', async (req, res) => {
  await Session.updateMany({ active: true }, { $set: { active: false, stoppedAt: new Date() } });
  res.json({ success: true, message: 'Session stopped' });
});

app.post('/api/sessions/:id/stop', async (req, res) => {
  const id = parseInt(req.params.id);
  const session = await Session.findOne({ sessionId: id });
  if (!session) return res.json({ success: false, error: 'Session not found' });
  if (!session.active) return res.json({ success: false, error: 'Session already stopped' });
  session.active = false;
  session.stoppedAt = new Date();
  await session.save();
  res.json({ success: true, message: 'Session stopped' });
});

app.get('/api/status', async (req, res) => {
  const session = await Session.findOne({ active: true });
  res.json({ active: !!session, session: session || null });
});

app.get('/api/responses', async (req, res) => {
  const { sessionName } = req.query;
  let rows = [];

  if (sessionName) {
    const session = await Session.findOne({ name: sessionName });
    if (session) rows = await Attendance.find({ sessionId: session.sessionId });
  } else {
    const activeSession = await Session.findOne({ active: true });
    if (activeSession) rows = await Attendance.find({ sessionId: activeSession.sessionId });
  }

  rows.sort((a, b) => (a.rollNo || '').localeCompare(b.rollNo || '', undefined, { numeric: true }));

  const sessions = await Session.find({ sessionId: { $in: rows.map(r => r.sessionId) } });
  const sessionMap = {};
  sessions.forEach(s => (sessionMap[s.sessionId] = s.name));

  res.json({
    success: true,
    responses: rows.map(r => ({
      'Roll No': r.rollNo || '-', 'Name': r.name,
      'Reg No': r.regNo || '-', 'Email': r.email,
      'Year': r.year || '-', 'Program': r.program || '-',
      'Branch': r.branch || '-', 'Session': sessionMap[r.sessionId] || 'Unknown',
      'Date': r.date, 'Time': r.time,
    })),
    count: rows.length,
    headers: ['Roll No', 'Name', 'Reg No', 'Email', 'Year', 'Program', 'Branch', 'Session', 'Date', 'Time'],
  });
});

app.get('/api/history', async (req, res) => {
  const sessions = await Session.find().sort({ createdAt: -1 });
  const result = await Promise.all(sessions.map(async s => ({
    id: s.sessionId,
    name: s.name,
    createdAt: s.createdAt,
    stoppedAt: s.stoppedAt || null,
    active: s.active,
    responseCount: await Attendance.countDocuments({ sessionId: s.sessionId }),
  })));
  res.json({ success: true, sessions: result });
});

app.delete('/api/sessions/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  await Session.deleteOne({ sessionId: id });
  await Attendance.deleteMany({ sessionId: id });
  res.json({ success: true });
});

app.post('/api/sessions/delete-many', async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) return res.json({ success: false, error: 'ids array required' });
  await Session.deleteMany({ sessionId: { $in: ids } });
  await Attendance.deleteMany({ sessionId: { $in: ids } });
  res.json({ success: true, deleted: ids.length });
});

app.post('/api/sessions/clear-all', async (req, res) => {
  const count = await Session.countDocuments();
  await Session.deleteMany({});
  await Attendance.deleteMany({});
  res.json({ success: true, deleted: count });
});

// Export multiple sessions
app.get('/api/export-multi', async (req, res) => {
  const { ids } = req.query;
  let sessionIds = ids ? ids.split(',').map(Number) : [];

  let rows = sessionIds.length > 0
    ? await Attendance.find({ sessionId: { $in: sessionIds } })
    : await Attendance.find();

  rows.sort((a, b) => (a.rollNo || '').localeCompare(b.rollNo || '', undefined, { numeric: true }));

  const sessions = await Session.find({ sessionId: { $in: rows.map(r => r.sessionId) } });
  const sessionMap = {};
  sessions.forEach(s => (sessionMap[s.sessionId] = s.name));

  const excelHeaders = ['Roll No', 'Name', 'Reg No', 'Email', 'Year', 'Program', 'Branch', 'Session', 'Date', 'Time'];
  const excelData = rows.map(r => ({
    'Roll No': r.rollNo || '-', 'Name': r.name,
    'Reg No': r.regNo || '-', 'Email': r.email,
    'Year': r.year || '-', 'Program': r.program || '-',
    'Branch': r.branch || '-', 'Session': sessionMap[r.sessionId] || 'Unknown',
    'Date': r.date, 'Time': r.time,
  }));

  const wb = XLSX.utils.book_new();
  const ws = rows.length > 0 ? XLSX.utils.json_to_sheet(excelData) : XLSX.utils.aoa_to_sheet([excelHeaders]);
  if (rows.length > 0) ws['!cols'] = [{ wch: 8 }, { wch: 25 }, { wch: 18 }, { wch: 30 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 35 }, { wch: 14 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="Attendance_Export.xlsx"');
  res.send(Buffer.from(buffer));
});

// Export single session
app.get('/api/export', async (req, res) => {
  const { sessionName } = req.query;
  let rows = [];
  let sheetTitle = 'All Sessions';

  if (sessionName) {
    const session = await Session.findOne({ name: sessionName });
    if (session) rows = await Attendance.find({ sessionId: session.sessionId });
    sheetTitle = sessionName;
  } else {
    rows = await Attendance.find();
  }

  rows.sort((a, b) => (a.rollNo || '').localeCompare(b.rollNo || '', undefined, { numeric: true }));

  const sessions = await Session.find({ sessionId: { $in: rows.map(r => r.sessionId) } });
  const sessionMap = {};
  sessions.forEach(s => (sessionMap[s.sessionId] = s.name));

  const excelHeaders = ['Roll No', 'Name', 'Reg No', 'Email', 'Year', 'Program', 'Branch', 'Session', 'Date', 'Time'];

  const wb = XLSX.utils.book_new();
  if (rows.length === 0) {
    const ws = XLSX.utils.aoa_to_sheet([excelHeaders]);
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
  } else {
    const excelData = rows.map(r => ({
      'Roll No': r.rollNo || '-', 'Name': r.name,
      'Reg No': r.regNo || '-', 'Email': r.email,
      'Year': r.year || '-', 'Program': r.program || '-',
      'Branch': r.branch || '-', 'Session': sessionMap[r.sessionId] || 'Unknown',
      'Date': r.date, 'Time': r.time,
    }));
    const ws = XLSX.utils.json_to_sheet(excelData);
    ws['!cols'] = [{ wch: 8 }, { wch: 25 }, { wch: 18 }, { wch: 30 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 35 }, { wch: 14 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, ws, sheetTitle);
  }

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="Attendance_${sheetTitle}.xlsx"`);
  res.send(Buffer.from(buffer));
});

// ==========================================
// HTML PAGE GENERATORS
// ==========================================
function getStudentFormHTML(session, error = null) {
  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const sessionCode = session ? session.code : '';
  const sessionIdVal = session ? session.sessionId : '';
  const sessionName = session ? session.name : '';

  if (error) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Session Ended</title>
<style>body{background:#0f172a;color:#f1f5f9;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;padding:40px;background:#1e293b;border-radius:20px;max-width:400px}
.icon{font-size:60px;margin-bottom:20px}.title{font-size:24px;font-weight:700;margin-bottom:10px;color:#ef4444}
.msg{color:#94a3b8;font-size:16px}</style></head>
<body><div class="box"><div class="icon">🔒</div><div class="title">Session Unavailable</div><div class="msg">${escapeHtml(error)}</div></div></body></html>`;
  }

  if (!session) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Attendance System</title>
<style>body{background:#0f172a;color:#f1f5f9;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;padding:40px;background:#1e293b;border-radius:20px;max-width:400px}
.icon{font-size:60px;margin-bottom:20px}.title{font-size:24px;font-weight:700;margin-bottom:10px}
.msg{color:#94a3b8;font-size:16px}</style></head>
<body><div class="box"><div class="icon">📋</div><div class="title">NIT Jamshedpur Attendance</div>
<div class="msg">No active session right now. Please check with your teacher.</div></div></body></html>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mark Attendance — ${escapeHtml(sessionName)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0f172a; color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: #1e293b; border-radius: 24px; padding: 32px; width: 100%; max-width: 420px; border: 1px solid #334155; }
    .header { text-align: center; margin-bottom: 28px; }
    .emoji { font-size: 48px; }
    h1 { font-size: 22px; font-weight: 700; margin-top: 12px; color: #f8fafc; }
    .session-badge { background: #1d4ed8; color: #bfdbfe; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: 600; display: inline-block; margin-top: 8px; }
    label { display: block; font-size: 12px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
    input { width: 100%; background: #0f172a; border: 1.5px solid #334155; border-radius: 12px; padding: 14px 16px; color: #f1f5f9; font-size: 16px; margin-bottom: 16px; outline: none; }
    input:focus { border-color: #6366f1; }
    button { width: 100%; background: #6366f1; color: #fff; border: none; border-radius: 14px; padding: 16px; font-size: 16px; font-weight: 700; cursor: pointer; }
    button:active { opacity: 0.85; }
    .result { margin-top: 16px; padding: 16px; border-radius: 12px; text-align: center; font-weight: 600; display: none; }
    .result.success { background: rgba(34,197,94,0.1); border: 1px solid rgba(34,197,94,0.3); color: #86efac; }
    .result.error   { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); color: #fca5a5; }
    .warn { background: rgba(234,179,8,0.08); border: 1px solid rgba(234,179,8,0.2); border-radius: 12px; padding: 12px 14px; margin-bottom: 20px; color: #fde68a; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="emoji">📋</div>
      <h1>Mark Your Attendance</h1>
      <span class="session-badge">📚 ${escapeHtml(sessionName)}</span>
    </div>
    <div class="warn">⚠️ Use your official <strong>@${ALLOWED_EMAIL_DOMAIN}</strong> email only.</div>
    <form id="form">
      <input type="hidden" name="sessionCode" value="${escapeHtml(sessionCode)}">
      <div><label>Full Name</label><input type="text" name="name" placeholder="e.g. Rahul Kumar" required autocomplete="name"></div>
      <div><label>College Email</label><input type="email" name="email" placeholder="e.g. 2023ugcs045@${ALLOWED_EMAIL_DOMAIN}" required autocomplete="email"></div>
      <button type="submit" id="btn">✅ Submit Attendance</button>
    </form>
    <div class="result" id="result"></div>
  </div>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('btn');
      const result = document.getElementById('result');
      btn.disabled = true; btn.textContent = '⏳ Submitting...';
      result.style.display = 'none';
      const fd = new FormData(e.target);
      const body = Object.fromEntries(fd);
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(async (pos) => {
          body.lat = pos.coords.latitude;
          body.lon = pos.coords.longitude;
          await send(body);
        }, async () => { await send(body); }, { timeout: 8000 });
      } else { await send(body); }
      async function send(d) {
        try {
          const r = await fetch('/submit', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(d) });
          const data = await r.json();
          result.style.display = 'block';
          if (data.success) { result.className = 'result success'; result.textContent = '✅ ' + data.message; btn.textContent = 'Submitted!'; }
          else { result.className = 'result error'; result.textContent = '❌ ' + data.error; btn.disabled = false; btn.textContent = '✅ Submit Attendance'; }
        } catch { result.style.display = 'block'; result.className = 'result error'; result.textContent = '❌ Network error. Try again.'; btn.disabled = false; btn.textContent = '✅ Submit Attendance'; }
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(text) {
  if (!text) return '';
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
  console.log('  ║  Storage:  MongoDB Atlas (Persistent) 🍃  ║');
  console.log(`  ║  Google Sign-In: ${GOOGLE_CLIENT_ID ? '✅ Enabled' : '❌ Not set'}        ║`);
  console.log('  ╚════════════════════════════════════════════╝');
  console.log('');

  if (!process.env.RENDER_EXTERNAL_URL) {
    process.env.RENDER_EXTERNAL_URL = 'https://attendance-server-ddgs.onrender.com';
  }

  // Connect to MongoDB in background (HTTP server already running)
  connectDB().then(() => {
    // Auto-close sessions exceeding 10 minutes
    setInterval(async () => {
      try {
        const nowMs = Date.now();
        const expiredSessions = await Session.find({ active: true });
        for (const s of expiredSessions) {
          if (nowMs - s.sessionId > 10 * 60 * 1000) {
            s.active = false;
            s.stoppedAt = new Date(s.sessionId + 10 * 60 * 1000);
            await s.save();
          }
        }
      } catch (e) {
        console.error('Auto-close interval error:', e.message);
      }
    }, 10000);
  });
});

// ==========================================
// GLOBAL CRASH GUARDS
// ==========================================
process.on('uncaughtException', (err) => {
  console.error('  ❌  Uncaught Exception (server kept alive):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('  ❌  Unhandled Rejection (server kept alive):', reason);
});
