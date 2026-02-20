# QR Attendance System - Node.js Cloud Server

This handles the REST API, Session State, User Management, and Student Front-Facing web application internally hosted over Express.js.

### 📥 Download the Master Teacher App (Android)
If you need the APK that properly syncs with this branch of the cloud server:
👉 [Download v1.5.0 Teacher App](https://expo.dev/accounts/ignisight/projects/attendance-system/builds/7d45fc2d-09de-4f2c-9e83-2596c85908bd)

---

### v1.5.0 Backend Features:
- **Asynchronous Concurrent Hosting**: Disconnected session auto-kills inside `/api/start-session` for flawless parallel processing.
- **Micro-Timer Verification:** A dedicated exact `10m 0s` timeout locking daemon that prevents memory overflow ghosts on the JSON.
- **Intelligent WebView Injection:** Forces `Google Lens` browsers into the Red Warning loop instantly stopping location timeouts.
- **Render.com Natively Linked:** Entire `server.js` was untethered from `localtunnel`, effectively removing the "Free Tunnel Password" blockade from Render deployments.
