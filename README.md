# VaaniX AI — Backend Server

Full REST API backend for the VaaniX farmer platform.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy and configure environment
cp .env.example .env
# Edit .env if needed (defaults work for local dev)

# 3. Start the server
npm start
# Server starts on http://localhost:3000
```

## First Run
On first start, the server auto-seeds:
- **8 demo mandi officials** (Karnataka, Telangana, Tamil Nadu)
- **15 demo crop price entries** (Tomato, Onion, Potato, Mango, Jasmine, etc.)

## Demo Credentials

| Role | Username | Password |
|------|----------|----------|
| Admin | `admin` | `password` |
| Demo Mandi | `demo_mandi` | `demo1234` |
| Mysuru APMC | `mysuru_mandi` | `mandi@1234` |
| Bengaluru KR | `bengaluru_mandi` | `mandi@1234` |
| Hubli APMC | `hubli_mandi` | `mandi@1234` |
| Hyderabad | `hyderabad_mandi` | `mandi@1234` |
| Chennai | `chennai_mandi` | `mandi@1234` |

## API Reference

### Auth — Farmer OTP Login

```
POST /api/auth/send-otp
Body: { "phone": "9876543210" }
Response: { "ok": true, "is_new_user": bool, "demo_otp": "123456" }

POST /api/auth/verify-otp
Body: { "phone": "9876543210", "otp": "123456", "lang": "kn" }
Response: { "ok": true, "token": "eyJ...", "farmer": {...} }
  OR:      { "ok": true, "requires_registration": true }

POST /api/auth/register  (new users only)
Body: { "phone": "9876543210", "name": "Raju", "village": "Tumkur", "lang": "kn" }
Response: { "ok": true, "token": "eyJ...", "farmer": {...} }
```

### Farmer Profile

```
GET  /api/farmer/profile         [Bearer token required]
PUT  /api/farmer/profile         [Bearer token required]
Body: { "name"?, "village"?, "lang"?, "land"?, "soil"?, "water"?, "prev_crop"? }
```

### Mandi Official Auth

```
POST /api/mandi/auth/login
Body: { "username": "mysuru_mandi", "password": "mandi@1234" }
Response: { "ok": true, "token": "eyJ...", "official": {...} }

POST /api/mandi/auth/change-password  [Mandi Bearer token required]
Body: { "old_password": "...", "new_password": "..." }
```

### Mandi Prices

```
GET  /api/mandi/prices?crop=Tomato&state=Karnataka
POST /api/mandi/prices  [Mandi Bearer token required]
Body: { "crop": "Tomato", "price_per_kg": 24, "supply_level": "normal", "quality": "Grade A" }

PUT  /api/mandi/prices/:id  [Mandi Bearer token required]
DELETE /api/mandi/prices/:id  [Mandi Bearer token required]
```

### Admin

```
POST /api/admin/login
Body: { "username": "admin", "password": "password" }

POST /api/admin/mandi-official  [Admin Bearer token required]
Body: { "username": "new_mandi", "password": "pwd", "name": "Name", "mandi_name": "Mandi", "location": "City", "state": "Karnataka" }

GET  /api/admin/stats            [Admin Bearer token required]
GET  /api/admin/farmers          [Admin Bearer token required]
GET  /api/admin/mandi-officials  [Admin Bearer token required]
DELETE /api/admin/farmer/:phone  [Admin Bearer token required]
DELETE /api/admin/mandi-official/:username  [Admin Bearer token required]
```

### Utility

```
GET  /api/health   — Server health check
GET  /api/config   — Frontend configuration (supported langs, SMS mode, etc.)
```

## Enable Real SMS (Twilio)

1. Create a Twilio account at https://twilio.com
2. Get your Account SID, Auth Token, and a phone number
3. Add to `.env`:
```
TWILIO_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_FROM=+1xxxxxxxxxx
```

## Production Deployment

```bash
# Change these in .env:
JWT_SECRET=<long random string>
ADMIN_HASH=<bcrypt hash of your admin password>
ALLOWED_ORIGINS=https://yourfrontend.com
```

Generate a new admin hash:
```bash
node -e "require('bcryptjs').hash('your_new_password', 10).then(console.log)"
```

## Database

Uses a simple JSON file (`vaanix.db.json`) — no database server needed.
For production with 10,000+ farmers, replace the `DB` class with `better-sqlite3` or PostgreSQL.

## Frontend Integration

The frontend (`VaaniX_v8.html`) auto-detects the backend:
- If on `localhost` → connects to `http://localhost:3000/api`
- If on a domain → connects to `same-origin/api`
- If backend offline → falls back to localStorage (offline mode)
