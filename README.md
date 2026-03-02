# QR Attendance System — Node.js Cloud Server (v2.2.0)

REST API backend for the NIT Jamshedpur QR Attendance System. Handles authentication, sessions, attendance, OTP password reset, and student device binding.

**Live:** [attendance-server-ddgs.onrender.com](https://attendance-server-ddgs.onrender.com)

### 📥 Download the Mobile App
👉 [Download Android APK (v2.2.0)](https://expo.dev/accounts/ignisight/projects/attendance-system/builds/0df16407-f7c2-4868-9ba9-b133e152bf0b)

---

### 🍃 v2.2.0 — MongoDB + Security Upgrade

#### Database
- **MongoDB Atlas** — persistent cloud storage replacing the old in-memory `data.json`.
- All data survives server restarts and redeployments permanently.
- TTL indexes auto-cleanup: Sessions (6 months), Attendance (4 years), OTPs (10 minutes).

#### Security
- **APP_SECRET_KEY** rotated and moved to environment variables — zero secrets in source code.
- **OTP hashed with bcrypt** — never stored as plaintext in the database.
- **Cryptographic OTP generation** via `crypto.randomInt()`.
- **Brute-force protection:** 5 failed OTP attempts → 15-minute lockout.
- **60-second cooldown** between OTP requests.
- **Brevo HTTP API** for email delivery (no SMTP — works on Render free tier).
- Global crash guards prevent uncaught exceptions from killing the server process.

#### API Endpoints
| Endpoint | Method | Description |
|---|---|---|
| `/api/register` | POST | Teacher registration |
| `/api/login` | POST | Teacher login |
| `/api/forgot-password` | POST | Send OTP email |
| `/api/reset-password` | POST | Verify OTP & reset password |
| `/api/change-password` | POST | Change password (logged in) |
| `/api/update-profile` | POST | Update teacher profile |
| `/api/start-session` | POST | Start attendance session |
| `/api/sessions/:id/stop` | POST | Stop active session |
| `/api/status` | GET | Current session status |
| `/api/history` | GET | All past sessions |
| `/api/export` | GET | Download Excel attendance |
| `/api/student/login` | POST | Student device registration |
| `/api/scan` | POST | QR code image upload scan |

#### Environment Variables (Render)
| Variable | Purpose |
|---|---|
| `MONGO_URI` | MongoDB Atlas connection string |
| `APP_SECRET_KEY` | API authentication key |
| `BREVO_API_KEY` | Brevo email API key |
| `EMAIL_FROM` | Sender email address |

#### Tech Stack
- Node.js + Express
- MongoDB Atlas (Mongoose)
- Brevo HTTP API (emails)
- bcryptjs (password + OTP hashing)
- Deployed on Render (free tier)
