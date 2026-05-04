/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║         VaaniX AI — Backend Server v2.0                     ║
 * ║  Real SMS: Fast2SMS · MSG91 · Twilio · Console-demo          ║
 * ║  Features: OTP · JWT · Mandi auth · Web OTP API · Cooldown   ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

'use strict';
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const fs         = require('fs');
const path       = require('path');
const rateLimit  = require('express-rate-limit');

// ── Config ────────────────────────────────────────────────────────────────
const PORT           = parseInt(process.env.PORT || '3000');
const JWT_SECRET     = process.env.JWT_SECRET     || 'vaanix_secret_change_in_prod_2026';
const JWT_EXPIRES    = process.env.JWT_EXPIRES    || '30d';
const OTP_TTL_MS     = parseInt(process.env.OTP_EXPIRES_MIN  || '10')  * 60000;
const RESEND_COOL_MS = parseInt(process.env.RESEND_COOLDOWN_SEC || '60') * 1000;
const DB_FILE        = process.env.DB_FILE || path.join(__dirname, 'vaanix.db.json');

// SMS providers
const SMS_PROVIDER = process.env.SMS_PROVIDER  || 'auto';
const FAST2SMS_KEY = process.env.FAST2SMS_API_KEY   || '';
const MSG91_KEY    = process.env.MSG91_AUTH_KEY      || '';
const MSG91_TMPL   = process.env.MSG91_TEMPLATE_ID   || '';
const TWILIO_SID   = process.env.TWILIO_SID          || '';
const TWILIO_TOKEN = process.env.TWILIO_TOKEN        || '';
const TWILIO_FROM  = process.env.TWILIO_FROM         || '';

function activeSMSProvider() {
  if (SMS_PROVIDER !== 'auto') return SMS_PROVIDER;
  if (FAST2SMS_KEY) return 'fast2sms';
  if (MSG91_KEY)    return 'msg91';
  if (TWILIO_SID)   return 'twilio';
  return 'console';
}
const ACTIVE_SMS = activeSMSProvider();

// ── Lightweight JSON Database ─────────────────────────────────────────────
class JsonDB {
  constructor(file) {
    this.file = file;
    this.data = fs.existsSync(file)
      ? (() => { try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return null; } })() || this._empty()
      : this._empty();
    setInterval(() => this._flush(), 8000);
  }
  _empty() {
    return { farmers:{}, otps:{}, mandi_officials:{}, mandi_prices:[], otp_log:[], sessions:{} };
  }
  _flush() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); } catch {}
  }
  save() { this._flush(); }
}
const db = new JsonDB(DB_FILE);

// ── Helpers ───────────────────────────────────────────────────────────────
const genOTP   = () => String(Math.floor(100000 + Math.random() * 900000));
const nowMs    = () => Date.now();
const signJWT  = (p) => jwt.sign(p, JWT_SECRET, { expiresIn: JWT_EXPIRES });
const checkJWT = (t) => { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } };

function authMW(req, res, next) {
  const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tok) return res.status(401).json({ ok:false, error:'No token' });
  const d = checkJWT(tok);
  if (!d)  return res.status(401).json({ ok:false, error:'Invalid or expired token' });
  req.user = d; next();
}
function mandiMW(req, res, next) {
  authMW(req, res, () => {
    if (req.user.role !== 'mandi') return res.status(403).json({ ok:false, error:'Mandi role required' });
    next();
  });
}
function adminMW(req, res, next) {
  authMW(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ ok:false, error:'Admin role required' });
    next();
  });
}

// ── SMS Dispatcher ────────────────────────────────────────────────────────
async function sendOTPSMS(phone, otp, domain) {
  const siteDomain = domain || process.env.SITE_DOMAIN || 'vaanix.app';
  // Web OTP API-compliant message (Android Chrome auto-reads OTP)
  const body = `Your VaaniX OTP is ${otp}. Valid 10 min. Do not share.\n\n@${siteDomain} #${otp}`;

  switch (ACTIVE_SMS) {

    // ── Fast2SMS (India, FREE tier — sign up at fast2sms.com) ─────────
    case 'fast2sms': {
      const params = new URLSearchParams({
        authorization: FAST2SMS_KEY,
        route: 'q',
        message: body,
        language: 'english',
        flash: '0',
        numbers: phone
      });
      const r = await fetch('https://www.fast2sms.com/dev/bulkV2?' + params.toString(),
        { headers: { 'cache-control': 'no-cache' } });
      const d = await r.json();
      if (!d.return) throw new Error('Fast2SMS error: ' + (d.message || JSON.stringify(d)));
      console.log(`📱 Fast2SMS → +91${phone}: ${otp}`);
      return { provider:'fast2sms', sent:true };
    }

    // ── MSG91 (India, free credits — sign up at msg91.com) ───────────
    case 'msg91': {
      const r = await fetch('https://api.msg91.com/api/v5/otp', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'authkey': MSG91_KEY },
        body: JSON.stringify({ template_id:MSG91_TMPL, mobile:'91'+phone, authkey:MSG91_KEY, otp })
      });
      const d = await r.json();
      if (d.type === 'error') throw new Error('MSG91: ' + d.message);
      console.log(`📱 MSG91 → +91${phone}: ${otp}`);
      return { provider:'msg91', sent:true };
    }

    // ── Twilio (global, paid) ─────────────────────────────────────────
    case 'twilio': {
      const cred = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
        method: 'POST',
        headers: { Authorization:'Basic '+cred, 'Content-Type':'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ Body:body, From:TWILIO_FROM, To:'+91'+phone }).toString()
      });
      const d = await r.json();
      if (d.error_code) throw new Error('Twilio: ' + d.message);
      console.log(`📱 Twilio → +91${phone}: ${otp}`);
      return { provider:'twilio', sent:true };
    }

    // ── Console / Demo ────────────────────────────────────────────────
    default:
      console.log('\n' + '═'.repeat(48));
      console.log(`📲  DEMO SMS  →  +91 ${phone}`);
      console.log(`    OTP: ${otp}   (expires in ${OTP_TTL_MS/60000} min)`);
      console.log('═'.repeat(48) + '\n');
      return { provider:'console', sent:false, demo_otp: otp };
  }
}

// ── Express App ───────────────────────────────────────────────────────────
const app = express();
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Site-Domain']
}));
app.use(express.json({ limit:'2mb' }));

const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) app.use(express.static(publicDir));

// ── Rate Limiters ─────────────────────────────────────────────────────────
const otpSendLimiter   = rateLimit({ windowMs:10*60000, max:5,  keyGenerator:(req)=>req.body?.phone||req.ip, message:{ok:false,error:'Too many OTP requests. Wait 10 min.'} });
const otpVerifyLimiter = rateLimit({ windowMs:15*60000, max:25, message:{ok:false,error:'Too many attempts.'} });
const loginLimiter     = rateLimit({ windowMs:15*60000, max:20, message:{ok:false,error:'Too many requests.'} });

// ══════════════════════════════════════════════════════════════════════════
//  PUBLIC
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/health', (_,res) => res.json({ ok:true, service:'VaaniX API', version:'2.0.0', sms_provider:ACTIVE_SMS, ts:new Date().toISOString() }));
app.get('/api/config', (_,res) => res.json({ ok:true, sms_real:ACTIVE_SMS!=='console', sms_provider:ACTIVE_SMS, otp_ttl_min:OTP_TTL_MS/60000, resend_cool_sec:RESEND_COOL_MS/1000, web_otp_api:true, supported_langs:['kn','te','ta','hi','en'] }));

// ══════════════════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════════════════
const authRouter = express.Router();

authRouter.post('/send-otp', otpSendLimiter, async (req, res) => {
  const { phone, lang } = req.body;
  if (!/^\d{10}$/.test(phone))
    return res.status(400).json({ ok:false, error:'Invalid mobile number (10 digits required)' });

  // Resend cooldown
  const k = `otp_${phone}`, prev = db.data.otps[k];
  if (prev && !prev.used && (nowMs() - prev.sent_at) < RESEND_COOL_MS) {
    const wait = Math.ceil((RESEND_COOL_MS - (nowMs() - prev.sent_at)) / 1000);
    return res.status(429).json({ ok:false, error:`Wait ${wait}s before resending.`, resend_in_sec:wait });
  }

  const otp    = genOTP();
  const domain = (req.headers['x-site-domain'] || req.headers.origin || '').replace(/^https?:\/\//,'') || 'vaanix.app';
  let smsRes;
  try   { smsRes = await sendOTPSMS(phone, otp, domain); }
  catch (e) { console.error('SMS failed:', e.message); smsRes = { provider:'console', sent:false, demo_otp:otp }; }

  db.data.otps[k] = { otp, used:false, attempts:0, sent_at:nowMs(), expires:nowMs()+OTP_TTL_MS };
  db.data.otp_log.push({ phone, ts:new Date().toISOString(), action:'sent', provider:smsRes.provider });
  db.save();

  return res.json({ ok:true, is_new_user:!db.data.farmers[phone], sms_sent:smsRes.sent, sms_provider:smsRes.provider, resend_in_sec:RESEND_COOL_MS/1000, demo_otp:smsRes.demo_otp });
});

authRouter.post('/verify-otp', otpVerifyLimiter, async (req, res) => {
  const { phone, otp, lang, name, village } = req.body;
  if (!/^\d{10}$/.test(phone)) return res.status(400).json({ ok:false, error:'Invalid phone' });

  const k = `otp_${phone}`, stored = db.data.otps[k];
  if (!stored)         return res.status(400).json({ ok:false, error:'No OTP found. Request a new one.' });
  if (stored.used)     return res.status(400).json({ ok:false, error:'OTP already used. Request a new one.' });
  if (nowMs()>stored.expires) return res.status(400).json({ ok:false, error:'OTP expired. Request a new one.' });

  stored.attempts = (stored.attempts||0)+1;
  if (stored.attempts > 5) return res.status(429).json({ ok:false, error:'Too many wrong attempts. Request new OTP.' });
  if (stored.otp !== String(otp)) {
    db.save();
    return res.status(400).json({ ok:false, error:'Wrong OTP.', attempts_left:5-stored.attempts });
  }

  stored.used = true;
  db.data.otp_log.push({ phone, ts:new Date().toISOString(), action:'verified' });

  let farmer = db.data.farmers[phone];
  const is_new = !farmer;

  if (is_new && name && village) {
    farmer = { phone, name:name.trim(), village:village.trim(), lang:lang||'en', land:'', soil:'', water:'', prev_crop:'', created_at:new Date().toISOString(), last_login:new Date().toISOString() };
    db.data.farmers[phone] = farmer;
  } else if (is_new) {
    db.save();
    return res.json({ ok:true, requires_registration:true, is_new_user:true });
  } else {
    farmer.last_login = new Date().toISOString();
    if (lang) farmer.lang = lang;
  }

  db.save();
  return res.json({ ok:true, token:signJWT({phone, role:'farmer', name:farmer.name}), farmer:{phone:farmer.phone, name:farmer.name, village:farmer.village, lang:farmer.lang}, is_new_user:is_new });
});

authRouter.post('/register', otpVerifyLimiter, (req, res) => {
  const { phone, name, village, lang } = req.body;
  if (!phone||!name||!village) return res.status(400).json({ ok:false, error:'phone,name,village required' });
  const stored = db.data.otps[`otp_${phone}`];
  if (!stored||!stored.used) return res.status(401).json({ ok:false, error:'Verify OTP first' });
  const farmer = { phone, name:name.trim(), village:village.trim(), lang:lang||'en', land:'', soil:'', water:'', prev_crop:'', created_at:new Date().toISOString(), last_login:new Date().toISOString() };
  db.data.farmers[phone] = farmer;
  db.save();
  return res.status(201).json({ ok:true, token:signJWT({phone, role:'farmer', name:farmer.name}), farmer:{phone, name:farmer.name, village:farmer.village, lang:farmer.lang} });
});

authRouter.post('/token-refresh', authMW, (req, res) => {
  const f = db.data.farmers[req.user.phone];
  if (!f) return res.status(404).json({ ok:false, error:'Not found' });
  return res.json({ ok:true, token:signJWT({phone:req.user.phone, role:'farmer', name:f.name}) });
});

// ══════════════════════════════════════════════════════════════════════════
//  FARMER
// ══════════════════════════════════════════════════════════════════════════
const farmerRouter = express.Router();
farmerRouter.get('/profile', authMW, (req,res) => {
  const f = db.data.farmers[req.user.phone];
  if (!f) return res.status(404).json({ ok:false, error:'Not found' });
  return res.json({ ok:true, farmer:f });
});
farmerRouter.put('/profile', authMW, (req,res) => {
  const f = db.data.farmers[req.user.phone];
  if (!f) return res.status(404).json({ ok:false, error:'Not found' });
  ['name','village','lang','land','soil','water','prev_crop'].forEach(k => { if(req.body[k]!=null) f[k]=String(req.body[k]).trim(); });
  f.updated_at = new Date().toISOString();
  db.save();
  return res.json({ ok:true, farmer:f });
});

// ══════════════════════════════════════════════════════════════════════════
//  MANDI AUTH
// ══════════════════════════════════════════════════════════════════════════
const mandiAuthRouter = express.Router();
mandiAuthRouter.post('/login', loginLimiter, async (req,res) => {
  const { username, password } = req.body;
  if (!username||!password) return res.status(400).json({ ok:false, error:'username + password required' });
  const off = db.data.mandi_officials[username.toLowerCase()];
  if (!off) return res.status(401).json({ ok:false, error:'Invalid credentials' });
  if (off.locked_until && nowMs()<off.locked_until)
    return res.status(423).json({ ok:false, error:`Locked. Try in ${Math.ceil((off.locked_until-nowMs())/60000)} min.` });
  const valid = await bcrypt.compare(password, off.password_hash);
  if (!valid) {
    off.failed_attempts = (off.failed_attempts||0)+1;
    if (off.failed_attempts >= 5) { off.locked_until = nowMs()+30*60000; off.failed_attempts=0; }
    db.save();
    return res.status(401).json({ ok:false, error:'Invalid credentials' });
  }
  off.failed_attempts=0; off.last_login=new Date().toISOString(); delete off.locked_until;
  db.save();
  return res.json({ ok:true, token:signJWT({username:username.toLowerCase(), role:'mandi', mandi_name:off.mandi_name, mandi_id:off.id}), official:{username:off.username, name:off.name, mandi_name:off.mandi_name, location:off.location, state:off.state} });
});
mandiAuthRouter.post('/change-password', mandiMW, async (req,res) => {
  const {old_password,new_password}=req.body;
  const off=db.data.mandi_officials[req.user.username];
  if (!off) return res.status(404).json({ ok:false, error:'Not found' });
  if (!await bcrypt.compare(old_password,off.password_hash)) return res.status(401).json({ ok:false, error:'Wrong password' });
  if (!new_password||new_password.length<8) return res.status(400).json({ ok:false, error:'Min 8 chars' });
  off.password_hash = await bcrypt.hash(new_password,10);
  db.save();
  return res.json({ ok:true, message:'Password updated' });
});

// ══════════════════════════════════════════════════════════════════════════
//  MANDI PRICES
// ══════════════════════════════════════════════════════════════════════════
const pricesRouter = express.Router();
pricesRouter.get('/', (req,res) => {
  let p = [...db.data.mandi_prices].sort((a,b)=>new Date(b.updated_at)-new Date(a.updated_at));
  if (req.query.crop)  p=p.filter(x=>x.crop.toLowerCase().includes(req.query.crop.toLowerCase()));
  if (req.query.state) p=p.filter(x=>(x.state||'').toLowerCase().includes(req.query.state.toLowerCase()));
  if (req.query.date)  p=p.filter(x=>x.date===req.query.date);
  const seen=new Set();
  const out=p.filter(x=>{ const k=x.mandi_name+'|||'+x.crop; if(seen.has(k)) return false; seen.add(k); return true; });
  return res.json({ ok:true, count:out.length, prices:out, as_of:new Date().toISOString() });
});
pricesRouter.get('/crops', (_,res) => res.json({ ok:true, crops:[...new Set(db.data.mandi_prices.map(p=>p.crop))].sort() }));
pricesRouter.get('/trend/:crop', (req,res) => {
  const crop=req.params.crop, since=new Date(Date.now()-7*86400000).toISOString().split('T')[0];
  const rows=db.data.mandi_prices.filter(p=>p.crop.toLowerCase()===crop.toLowerCase()&&p.date>=since).sort((a,b)=>a.date.localeCompare(b.date));
  const byDate={};
  rows.forEach(r=>{ if(!byDate[r.date]) byDate[r.date]=[]; byDate[r.date].push(r.price_per_kg); });
  const trend=Object.entries(byDate).map(([date,prices])=>({ date, avg:Math.round(prices.reduce((a,b)=>a+b,0)/prices.length), count:prices.length }));
  return res.json({ ok:true, crop, trend });
});
pricesRouter.post('/', mandiMW, (req,res) => {
  const {crop,price_per_kg,supply_level,quality,notes}=req.body;
  if (!crop||price_per_kg==null) return res.status(400).json({ ok:false, error:'crop+price_per_kg required' });
  const off=db.data.mandi_officials[req.user.username];
  const e={ id:`p_${Date.now()}_${Math.random().toString(36).slice(2,5)}`, crop:crop.trim(), price_per_kg:parseFloat(price_per_kg), supply_level:supply_level||'normal', quality:quality||'Grade A', notes:notes||'', mandi_name:req.user.mandi_name, mandi_id:req.user.mandi_id, state:off?.state||'Karnataka', date:new Date().toISOString().split('T')[0], updated_at:new Date().toISOString(), posted_by:req.user.username };
  db.data.mandi_prices.push(e);
  if (db.data.mandi_prices.length>15000) db.data.mandi_prices=db.data.mandi_prices.slice(-15000);
  db.save();
  return res.status(201).json({ ok:true, price:e });
});
pricesRouter.put('/:id', mandiMW, (req,res) => {
  const e=db.data.mandi_prices.find(x=>x.id===req.params.id);
  if (!e) return res.status(404).json({ ok:false, error:'Not found' });
  if (e.posted_by!==req.user.username) return res.status(403).json({ ok:false, error:'Forbidden' });
  ['price_per_kg','supply_level','quality','notes'].forEach(k=>{ if(req.body[k]!=null) e[k]=req.body[k]; });
  e.updated_at=new Date().toISOString();
  db.save();
  return res.json({ ok:true, price:e });
});
pricesRouter.delete('/:id', mandiMW, (req,res) => {
  const i=db.data.mandi_prices.findIndex(x=>x.id===req.params.id);
  if (i===-1) return res.status(404).json({ ok:false, error:'Not found' });
  if (db.data.mandi_prices[i].posted_by!==req.user.username) return res.status(403).json({ ok:false, error:'Forbidden' });
  db.data.mandi_prices.splice(i,1); db.save();
  return res.json({ ok:true });
});

// ══════════════════════════════════════════════════════════════════════════
//  ADMIN
// ══════════════════════════════════════════════════════════════════════════
const adminRouter = express.Router();
const ADMIN_USER  = process.env.ADMIN_USER || 'admin';
const ADMIN_HASH  = process.env.ADMIN_HASH || '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi';

adminRouter.post('/login', loginLimiter, async (req,res) => {
  const {username,password}=req.body;
  if (username!==ADMIN_USER||!await bcrypt.compare(password,ADMIN_HASH)) return res.status(401).json({ ok:false, error:'Invalid credentials' });
  return res.json({ ok:true, token:signJWT({username, role:'admin'}) });
});
adminRouter.post('/mandi-official', adminMW, async (req,res) => {
  const {username,password,name,mandi_name,location,state}=req.body;
  if (!username||!password||!name||!mandi_name) return res.status(400).json({ ok:false, error:'username,password,name,mandi_name required' });
  const key=username.toLowerCase();
  if (db.data.mandi_officials[key]) return res.status(409).json({ ok:false, error:'Username exists' });
  db.data.mandi_officials[key]={ id:`m_${Date.now()}_${key}`, username:key, name, mandi_name, location:location||'', state:state||'Karnataka', password_hash:await bcrypt.hash(password,10), created_at:new Date().toISOString(), last_login:null, failed_attempts:0 };
  db.save();
  return res.status(201).json({ ok:true, message:'Created' });
});
adminRouter.get('/stats', adminMW, (req,res) => {
  const active=Object.values(db.data.farmers).filter(f=>f.last_login&&nowMs()-new Date(f.last_login).getTime()<7*86400000).length;
  const sent=db.data.otp_log.filter(l=>l.action==='sent').length, verf=db.data.otp_log.filter(l=>l.action==='verified').length;
  return res.json({ ok:true, stats:{ total_farmers:Object.keys(db.data.farmers).length, active_7d:active, mandi_officials:Object.keys(db.data.mandi_officials).length, price_entries:db.data.mandi_prices.length, otp_sent:sent, otp_verified:verf, conversion_rate:`${sent?Math.round(verf/sent*100):0}%`, as_of:new Date().toISOString() } });
});
adminRouter.get('/farmers', adminMW, (req,res) => {
  const page=parseInt(req.query.page||'1'),limit=parseInt(req.query.limit||'50'),all=Object.values(db.data.farmers);
  return res.json({ ok:true, total:all.length, page, farmers:all.slice((page-1)*limit,page*limit) });
});
adminRouter.get('/mandi-officials', adminMW, (req,res) => {
  const list=Object.values(db.data.mandi_officials).map(({password_hash,...s})=>s);
  return res.json({ ok:true, officials:list });
});
adminRouter.delete('/farmer/:phone', adminMW, (req,res) => {
  if (!db.data.farmers[req.params.phone]) return res.status(404).json({ ok:false, error:'Not found' });
  delete db.data.farmers[req.params.phone]; db.save();
  return res.json({ ok:true });
});
adminRouter.delete('/mandi-official/:username', adminMW, (req,res) => {
  const k=req.params.username.toLowerCase();
  if (!db.data.mandi_officials[k]) return res.status(404).json({ ok:false, error:'Not found' });
  delete db.data.mandi_officials[k]; db.save();
  return res.json({ ok:true });
});

// ── Mount ─────────────────────────────────────────────────────────────────
app.use('/api/auth',         authRouter);
app.use('/api/farmer',       farmerRouter);
app.use('/api/mandi/auth',   mandiAuthRouter);
app.use('/api/mandi/prices', pricesRouter);
app.use('/api/admin',        adminRouter);
app.use((_,res)=>res.status(404).json({ ok:false, error:'Not found' }));
app.use((e,_,res,__)=>{ console.error(e); res.status(500).json({ ok:false, error:'Server error' }); });

// ══════════════════════════════════════════════════════════════════════════
//  SEED
// ══════════════════════════════════════════════════════════════════════════
async function seed() {
  if (Object.keys(db.data.mandi_officials).length > 0) return;
  console.log('🌱 Seeding demo data...');
  const officials = [
    { u:'mysuru_mandi',    p:'mandi@1234', name:'Ravi Kumar',    mandi:'Mysuru APMC',    loc:'Mysuru',    state:'Karnataka'   },
    { u:'bengaluru_mandi', p:'mandi@1234', name:'Suresh Naik',   mandi:'KR Market',      loc:'Bengaluru', state:'Karnataka'   },
    { u:'hubli_mandi',     p:'mandi@1234', name:'Prakash Bhat',  mandi:'Hubli APMC',     loc:'Hubli',     state:'Karnataka'   },
    { u:'hassan_mandi',    p:'mandi@1234', name:'Anand Hegde',   mandi:'Hassan APMC',    loc:'Hassan',    state:'Karnataka'   },
    { u:'dharwad_mandi',   p:'mandi@1234', name:'Vijay Patil',   mandi:'Dharwad APMC',   loc:'Dharwad',   state:'Karnataka'   },
    { u:'tumkur_mandi',    p:'mandi@1234', name:'Mohan Gowda',   mandi:'Tumkur APMC',    loc:'Tumkur',    state:'Karnataka'   },
    { u:'hyderabad_mandi', p:'mandi@1234', name:'Raju Reddy',    mandi:'Gaddiannaram',   loc:'Hyderabad', state:'Telangana'   },
    { u:'warangal_mandi',  p:'mandi@1234', name:'Srinivas Rao',  mandi:'Warangal APMC',  loc:'Warangal',  state:'Telangana'   },
    { u:'chennai_mandi',   p:'mandi@1234', name:'Murugan S',     mandi:'Koyambedu APMC', loc:'Chennai',   state:'Tamil Nadu'  },
    { u:'madurai_mandi',   p:'mandi@1234', name:'Selvam K',      mandi:'Madurai APMC',   loc:'Madurai',   state:'Tamil Nadu'  },
    { u:'demo_mandi',      p:'demo1234',   name:'Demo Official', mandi:'Demo Mandi',     loc:'Demo City', state:'Karnataka'   },
  ];
  for (const o of officials) {
    db.data.mandi_officials[o.u] = { id:`m_${Date.now()}_${o.u}`, username:o.u, name:o.name, mandi_name:o.mandi, location:o.loc, state:o.state, password_hash:await bcrypt.hash(o.p,10), created_at:new Date().toISOString(), last_login:null, failed_attempts:0 };
  }
  const today=new Date().toISOString().split('T')[0];
  const prices=[
    { crop:'Tomato',  price:24, supply:'normal', mandi:'KR Market',      state:'Karnataka', user:'bengaluru_mandi' },
    { crop:'Tomato',  price:18, supply:'high',   mandi:'Mysuru APMC',    state:'Karnataka', user:'mysuru_mandi'    },
    { crop:'Tomato',  price:31, supply:'low',    mandi:'Hubli APMC',     state:'Karnataka', user:'hubli_mandi'     },
    { crop:'Tomato',  price:22, supply:'normal', mandi:'Tumkur APMC',    state:'Karnataka', user:'tumkur_mandi'    },
    { crop:'Tomato',  price:20, supply:'normal', mandi:'Gaddiannaram',   state:'Telangana', user:'hyderabad_mandi' },
    { crop:'Tomato',  price:23, supply:'normal', mandi:'Koyambedu APMC', state:'Tamil Nadu',user:'chennai_mandi'   },
    { crop:'Onion',   price:15, supply:'high',   mandi:'Dharwad APMC',   state:'Karnataka', user:'dharwad_mandi'   },
    { crop:'Onion',   price:22, supply:'normal', mandi:'KR Market',      state:'Karnataka', user:'bengaluru_mandi' },
    { crop:'Onion',   price:19, supply:'normal', mandi:'Gaddiannaram',   state:'Telangana', user:'hyderabad_mandi' },
    { crop:'Potato',  price:14, supply:'high',   mandi:'Hassan APMC',    state:'Karnataka', user:'hassan_mandi'    },
    { crop:'Potato',  price:18, supply:'normal', mandi:'Mysuru APMC',    state:'Karnataka', user:'mysuru_mandi'    },
    { crop:'Mango',   price:65, supply:'low',    mandi:'KR Market',      state:'Karnataka', user:'bengaluru_mandi' },
    { crop:'Mango',   price:55, supply:'normal', mandi:'Madurai APMC',   state:'Tamil Nadu',user:'madurai_mandi'   },
    { crop:'Jasmine', price:180,supply:'low',    mandi:'Mysuru APMC',    state:'Karnataka', user:'mysuru_mandi'    },
    { crop:'Rose',    price:90, supply:'normal', mandi:'Dharwad APMC',   state:'Karnataka', user:'dharwad_mandi'   },
    { crop:'Marigold',price:35, supply:'normal', mandi:'Tumkur APMC',    state:'Karnataka', user:'tumkur_mandi'    },
    { crop:'Banana',  price:28, supply:'normal', mandi:'Koyambedu APMC', state:'Tamil Nadu',user:'chennai_mandi'   },
    { crop:'Capsicum',price:55, supply:'low',    mandi:'KR Market',      state:'Karnataka', user:'bengaluru_mandi' },
    { crop:'Brinjal', price:12, supply:'high',   mandi:'Hubli APMC',     state:'Karnataka', user:'hubli_mandi'     },
    { crop:'Okra',    price:20, supply:'normal', mandi:'Warangal APMC',  state:'Telangana', user:'warangal_mandi'  },
    { crop:'Coconut', price:18, supply:'normal', mandi:'Hassan APMC',    state:'Karnataka', user:'hassan_mandi'    },
  ];
  for (const p of prices) {
    db.data.mandi_prices.push({ id:`p_seed_${Date.now()}_${Math.random().toString(36).slice(2,5)}`, crop:p.crop, price_per_kg:p.price, supply_level:p.supply, quality:'Grade A', notes:'', mandi_name:p.mandi, mandi_id:'', state:p.state, date:today, updated_at:new Date().toISOString(), posted_by:p.user });
  }
  db.save();
  console.log(`✅ Seeded ${officials.length} officials + ${prices.length} prices`);
}

// ── Start ─────────────────────────────────────────────────────────────────
seed().then(() => {
  app.listen(PORT, () => {
    console.log(`\n╔${'═'.repeat(46)}╗`);
    console.log(`║  VaaniX AI Backend v2.0  —  Port ${PORT}      ║`);
    console.log(`╠${'═'.repeat(46)}╣`);
    console.log(`║  SMS: ${ACTIVE_SMS.padEnd(38)} ║`);
    console.log(`║  OTP TTL: ${(OTP_TTL_MS/60000+'min').padEnd(35)} ║`);
    console.log(`║  Resend cooldown: ${(RESEND_COOL_MS/1000+'s').padEnd(27)} ║`);
    console.log(`╠${'═'.repeat(46)}╣`);
    if (ACTIVE_SMS==='console') {
      console.log('║  ⚠  Demo mode: OTPs logged to console     ║');
      console.log('║     Set FAST2SMS_API_KEY for real SMS      ║');
    } else {
      console.log(`║  ✅ Real SMS via ${ACTIVE_SMS.padEnd(28)} ║`);
    }
    console.log(`╠${'═'.repeat(46)}╣`);
    console.log('║  demo_mandi / demo1234                       ║'.substring(0,48)+'║');
    console.log('║  admin / password                            ║'.substring(0,48)+'║');
    console.log(`╚${'═'.repeat(46)}╝\n`);
  });
});

module.exports = app;
