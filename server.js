const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const crypto = require('node:crypto');
const { openLocalDb } = require('./local-db');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'noby.sqlite');
const SESSION_DAYS = 14;
const OTP_MINUTES = 15;
const PAYPAL_RECEIVER = process.env.PAYPAL_RECEIVER_EMAIL || 'cfgf6463@gmail.com';
const POINT_PACKAGES = Object.freeze({starter:{amount:'1.99',points:250,label:'250 نقطة'},reader:{amount:'4.99',points:700,label:'700 نقطة'},library:{amount:'9.99',points:1600,label:'1600 نقطة'}});
const INGEST_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'data', 'backups');
let ingestionRunning = false;
let db;
const now = () => Date.now();
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('hex');
const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const emailOk = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const passOk = value => typeof value === 'string' && value.length >= 8 && value.length <= 128;

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, points INTEGER NOT NULL DEFAULT 50, avatar_frame TEXT NOT NULL DEFAULT 'none', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS manga (id INTEGER PRIMARY KEY AUTOINCREMENT, title_ar TEXT NOT NULL, title_en TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'other', status TEXT NOT NULL DEFAULT 'مستمر', rating REAL NOT NULL DEFAULT 0, cover_url TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', published INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chapters (id INTEGER PRIMARY KEY AUTOINCREMENT, manga_id INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE, number INTEGER NOT NULL, title TEXT NOT NULL, pages_json TEXT NOT NULL DEFAULT '[]', translated_text TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'published', created_at INTEGER NOT NULL, UNIQUE(manga_id, number));
    CREATE TABLE IF NOT EXISTS purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, item_key TEXT NOT NULL, cost INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(user_id,item_key));
    CREATE TABLE IF NOT EXISTS paypal_orders (order_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, package_key TEXT NOT NULL, points INTEGER NOT NULL, amount TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', status TEXT NOT NULL DEFAULT 'CREATED', created_at INTEGER NOT NULL, captured_at INTEGER NULL);
    CREATE TABLE IF NOT EXISTS password_otps (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, otp_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used_at INTEGER NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS reader_progress (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE, page_index INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'webtoon', updated_at INTEGER NOT NULL, PRIMARY KEY(user_id,chapter_id));
    CREATE TABLE IF NOT EXISTS ad_slots (slot_key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, mode TEXT NOT NULL DEFAULT 'house', client_id TEXT NOT NULL DEFAULT '', ad_slot TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT 'ادعم نوبي بإعلان بسيط', body TEXT NOT NULL DEFAULT 'الإعلانات تساعدنا على استمرار القراءة المجانية.', href TEXT NOT NULL DEFAULT '#');
    CREATE TABLE IF NOT EXISTS ad_events (id INTEGER PRIMARY KEY AUTOINCREMENT, slot_key TEXT NOT NULL, event_type TEXT NOT NULL, user_id INTEGER NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
  `);
  const adCount = db.prepare('SELECT COUNT(*) AS n FROM ad_slots').get().n;
  if (!adCount) {
    const insert = db.prepare('INSERT INTO ad_slots(slot_key,title,body) VALUES(?,?,?)');
    for (const row of [['home-top','مساحة إعلانية رئيسية','إعلان خفيف لا يقطع تجربة القراءة.'],['library-inline','إعلان بين الأعمال','بدعمك نستمر في إضافة أعمال مرخصة.'],['reader-bottom','دعم القراءة المجانية','إعلان واحد بعد الفصل، بلا نوافذ مزعجة.']]) insert.run(...row);
  }
}
function cookieValue(req, name) { const found = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(name + '=')); return found ? decodeURIComponent(found.slice(name.length + 1)) : ''; }
function setCookie(res, name, value, maxAge) { res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${process.env.PUBLIC_HTTPS === 'true' ? '; Secure' : ''}`); }
function clearCookie(res, name) { res.setHeader('Set-Cookie', `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${process.env.PUBLIC_HTTPS === 'true' ? '; Secure' : ''}`); }
function userFrom(req) { const raw = cookieValue(req,'noby_session'); if (!raw) return null; return db.prepare('SELECT u.id,u.username,u.email,u.points,u.avatar_frame FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(hash(raw),now()) || null; }
function auth(req,res,next) { req.user = userFrom(req); if (!req.user) return res.status(401).json({error:'يلزم تسجيل الدخول.'}); next(); }
function adminFrom(req) { const raw = cookieValue(req,'noby_admin'); if (!raw) return false; return Boolean(db.prepare('SELECT 1 FROM admin_sessions WHERE token_hash=? AND expires_at>?').get(hash(raw),now())); }
function admin(req,res,next) { if (!adminFrom(req)) return res.status(401).json({error:'لوحة الإدارة محمية.'}); next(); }
function adminConfigured() { return Boolean(process.env.ADMIN_EMAIL && (process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD_HASH)); }
function suspiciousNetwork(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(x=>x.trim()).filter(Boolean);
  const standard = String(req.headers.forwarded || '').match(/for=([^;,]+)/gi) || [];
  const real = String(req.headers['x-real-ip'] || '').trim();
  const cloudflare = String(req.headers['cf-connecting-ip'] || '').trim();
  if (forwarded.length > 4 || standard.length > 4) return true;
  if (real && forwarded.length && real !== forwarded[0]) return true;
  if (cloudflare && forwarded.length && cloudflare !== forwarded[0] && !String(req.headers['cf-ray'])) return true;
  if (forwarded.some(ip => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc00:|fe80:)/i.test(ip))) return true;
  return false;
}
function paypalBase() { return String(process.env.PAYPAL_MODE || 'sandbox').toLowerCase() === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'; }
async function paypalToken() {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) throw new Error('PAYPAL_NOT_CONFIGURED');
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(`${paypalBase()}/v1/oauth2/token`, {method:'POST',headers:{Authorization:`Basic ${basic}`,'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'});
  if (!response.ok) throw new Error('PAYPAL_AUTH_FAILED');
  return (await response.json()).access_token;
}
async function paypalRequest(method, endpoint, body) {
  const token = await paypalToken();
  const response = await fetch(`${paypalBase()}${endpoint}`, {method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const payload = await response.json().catch(()=>({}));
  if (!response.ok) { const error = new Error('PAYPAL_REQUEST_FAILED'); error.payload = payload; throw error; }
  return payload;
}
async function deliverOtp(user, otp) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, RESET_OTP_DEV_MODE } = process.env;
  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    const transporter = nodemailer.createTransport({host:SMTP_HOST,port:Number(SMTP_PORT||587),secure:String(SMTP_PORT)==='465',auth:{user:SMTP_USER,pass:SMTP_PASS}});
    await transporter.sendMail({from:SMTP_FROM||SMTP_USER,to:user.email,subject:'رمز استعادة حساب نوبي',text:`رمز استعادة حسابك هو ${otp}. ينتهي خلال ${OTP_MINUTES} دقيقة.`});
    return 'smtp';
  }
  if (RESET_OTP_DEV_MODE === 'true') { console.log(`[Noby OTP DEV] ${user.email}: ${otp}`); return 'dev'; }
  return null;
}
function ingestionSources() {
  return String(process.env.INGEST_SOURCES || '').split(/\n|;/).map(item=>item.trim()).filter(Boolean).map(item=>{const [url,licenseUrl,...rest]=item.split('|').map(x=>x.trim());return {url,licenseUrl,mangaId:rest[0]||'',chapterNumber:rest[1]||''};}).filter(item=>item.url&&item.licenseUrl);
}
function backupDatabase() {
  try { db.save(); fs.mkdirSync(BACKUP_DIR,{recursive:true}); const target=path.join(BACKUP_DIR,`noby-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`); fs.copyFileSync(DB_FILE,target); const files=fs.readdirSync(BACKUP_DIR).filter(name=>name.endsWith('.sqlite')).sort().reverse(); for(const old of files.slice(14))fs.rmSync(path.join(BACKUP_DIR,old),{force:true}); console.log(`[Noby backup] ${target}`); return target; } catch(error) { console.error('[Noby backup] failed',error.message); return null; }
}
function runIngestionSource(source) {
  return new Promise(resolve=>{const worker=path.join(__dirname,'worker','pipeline.js');const args=[worker,'--url',source.url,'--license-confirmed','--license-url',source.licenseUrl,'--translate'];if(source.mangaId)args.push('--manga-id',source.mangaId);if(source.chapterNumber)args.push('--chapter-number',source.chapterNumber);const child=spawn(process.execPath,args,{env:{...process.env,DB_FILE}});let output='';child.stdout.on('data',chunk=>{output+=chunk.toString().slice(-4000)});child.stderr.on('data',chunk=>{output+=chunk.toString().slice(-4000)});child.on('close',code=>{console.log(`[Noby scheduler] ${source.url} exit=${code} ${output.slice(-1000)}`);resolve(code===0);});});
}
async function runIngestionCycle() {
  if (ingestionRunning) return;
  const sources=ingestionSources(); if (!sources.length) return;
  ingestionRunning=true;
  try { for (const source of sources) await runIngestionSource(source); db=await openLocalDb(DB_FILE); } catch(error) { console.error('[Noby scheduler] failed',error.message); } finally { ingestionRunning=false; }
}
function startEmbeddedScheduler() {
  backupDatabase();
  setInterval(backupDatabase,BACKUP_INTERVAL_MS).unref();
  if (!ingestionSources().length) return;
  if (process.env.SCHEDULER_RUN_ON_START === 'true') runIngestionCycle();
  setInterval(runIngestionCycle,INGEST_INTERVAL_MS).unref();
  console.log(`[Noby scheduler] enabled; sources=${ingestionSources().length}; interval=6h`);
}

app.disable('x-powered-by');
app.use(helmet({contentSecurityPolicy:false, crossOriginEmbedderPolicy:false}));
app.use(cors({origin:true,credentials:true}));
app.use(express.json({limit:'2mb'}));
app.use('/api', rateLimit({windowMs:60000,limit:180,standardHeaders:'draft-7',legacyHeaders:false}));
app.use('/api/auth', rateLimit({windowMs:900000,limit:20,standardHeaders:'draft-7',legacyHeaders:false}));

app.get('/api/health',(req,res)=>res.json({ok:true,database:'local-sqlite',independent:true,ads:db.prepare('SELECT COUNT(*) AS n FROM ad_slots WHERE enabled=1').get().n,timestamp:new Date().toISOString()}));
app.get('/api/manga',(req,res)=>{const search=clean(req.query.search,80),cat=clean(req.query.category,40);let sql='SELECT * FROM manga WHERE published=1',params=[];if(cat&&cat!=='all'){sql+=' AND category=?';params.push(cat)}if(search){sql+=' AND (title_ar LIKE ? OR title_en LIKE ? OR description LIKE ?)';params.push(`%${search}%`,`%${search}%`,`%${search}%`)}res.json(db.prepare(sql+' ORDER BY rating DESC,id DESC').all(...params));});
app.get('/api/manga/:id/chapters',(req,res)=>res.json(db.prepare("SELECT id,number,title,status FROM chapters WHERE manga_id=? AND status='published' ORDER BY number").all(Number(req.params.id))));
app.get('/api/chapters/:id',(req,res)=>{const c=db.prepare('SELECT c.*,m.title_ar FROM chapters c JOIN manga m ON m.id=c.manga_id WHERE c.id=? AND c.status=\'published\'').get(Number(req.params.id));if(!c)return res.status(404).json({error:'الفصل غير موجود.'});res.json({...c,pages:JSON.parse(c.pages_json||'[]')});});
app.get('/api/ads',(req,res)=>{const slots=db.prepare('SELECT slot_key,enabled,mode,client_id,ad_slot,title,body,href FROM ad_slots WHERE enabled=1').all();res.json({configured:Boolean(process.env.ADSENSE_CLIENT_ID),slots});});
app.post('/api/ads/event',(req,res)=>{const slot=clean(req.body.slotKey,80),type=clean(req.body.eventType,20);if(!slot||!['view','click'].includes(type))return res.status(400).json({error:'حدث إعلان غير صالح.'});db.prepare('INSERT INTO ad_events(slot_key,event_type,user_id,created_at) VALUES(?,?,?,?)').run(slot,type,userFrom(req)?.id||null,now());res.status(204).end();});

app.post('/api/auth/register',(req,res)=>{const username=clean(req.body.username,30),email=clean(req.body.email,160).toLowerCase(),password=req.body.password;if(!/^[\p{L}\w.-]{3,30}$/u.test(username)||!emailOk(email)||!passOk(password))return res.status(400).json({error:'تحقق من الاسم والبريد وكلمة المرور.'});try{db.prepare('INSERT INTO users(username,email,password_hash,created_at) VALUES(?,?,?,?)').run(username,email,bcrypt.hashSync(password,12),now());res.status(201).json({success:true});}catch(e){res.status(409).json({error:'اسم المستخدم أو البريد مستخدم مسبقاً.'});}});
app.post('/api/auth/login',(req,res)=>{const u=db.prepare('SELECT * FROM users WHERE username=?').get(clean(req.body.username,30));if(!u||!bcrypt.compareSync(req.body.password||'',u.password_hash))return res.status(401).json({error:'بيانات الدخول غير صحيحة.'});const token=randomToken();db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(hash(token),u.id,now()+SESSION_DAYS*86400000,now());setCookie(res,'noby_session',token,SESSION_DAYS*86400);res.json({user:{id:u.id,username:u.username,email:u.email,points:u.points,avatar_frame:u.avatar_frame}});});
app.post('/api/auth/logout',(req,res)=>{const token=cookieValue(req,'noby_session');if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));clearCookie(res,'noby_session');res.json({success:true});});
app.get('/api/auth/me',auth,(req,res)=>res.json({user:req.user}));
app.post('/api/auth/forgot-password',async(req,res)=>{const email=clean(req.body.email,160).toLowerCase();if(!emailOk(email))return res.status(400).json({error:'البريد الإلكتروني غير صالح.'});const user=db.prepare('SELECT id,email FROM users WHERE email=?').get(email);if(!user)return res.json({success:true,message:'إذا كان البريد مسجلاً فسيصلك رمز الاستعادة.'});const otp=String(crypto.randomInt(100000,1000000));db.prepare('DELETE FROM password_otps WHERE user_id=? OR expires_at<?').run(user.id,now());db.prepare('INSERT INTO password_otps(user_id,otp_hash,expires_at,created_at) VALUES(?,?,?,?)').run(user.id,hash(otp),now()+OTP_MINUTES*60000,now());try{const delivery=await deliverOtp(user,otp);if(!delivery){db.prepare('DELETE FROM password_otps WHERE user_id=?').run(user.id);return res.status(503).json({error:'خدمة البريد غير مهيأة. اضبط SMTP قبل تفعيل الاستعادة.'});}res.json({success:true,message:'إذا كان البريد مسجلاً فسيصلك رمز الاستعادة.',devOtp:delivery==='dev'?otp:undefined});}catch{db.prepare('DELETE FROM password_otps WHERE user_id=?').run(user.id);res.status(503).json({error:'تعذر إرسال رمز الاستعادة حالياً.'});}});
app.post('/api/auth/reset-password',(req,res)=>{const email=clean(req.body.email,160).toLowerCase(),otp=clean(req.body.otp,6),password=req.body.password;if(!emailOk(email)||!/^[0-9]{6}$/.test(otp)||!passOk(password))return res.status(400).json({error:'تحقق من البريد والرمز وكلمة المرور الجديدة.'});const user=db.prepare('SELECT id FROM users WHERE email=?').get(email),record=user&&db.prepare('SELECT * FROM password_otps WHERE user_id=? AND used_at IS NULL AND expires_at>? ORDER BY id DESC LIMIT 1').get(user.id,now());if(!record||record.attempts>=5||hash(otp)!==record.otp_hash){if(record)db.prepare('UPDATE password_otps SET attempts=attempts+1 WHERE id=?').run(record.id);return res.status(400).json({error:'رمز الاستعادة غير صحيح أو منتهي.'});}db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password,12),user.id);db.prepare('UPDATE password_otps SET used_at=? WHERE id=?').run(now(),record.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);res.json({success:true});});
app.post('/api/rewards/reading',auth,(req,res)=>{if(req.body.adBlockDetected===true||suspiciousNetwork(req))return res.status(403).json({error:'تم تجميد النقاط بسبب مانع الإعلانات أو شبكة غير موثوقة.'});db.prepare('UPDATE users SET points=points+15 WHERE id=?').run(req.user.id);res.json({points:db.prepare('SELECT points FROM users WHERE id=?').get(req.user.id).points});});
app.get('/api/reader/progress/:chapterId',auth,(req,res)=>res.json(db.prepare('SELECT page_index,mode,updated_at FROM reader_progress WHERE user_id=? AND chapter_id=?').get(req.user.id,Number(req.params.chapterId))||{page_index:0,mode:'webtoon',updated_at:0}));
app.put('/api/reader/progress/:chapterId',auth,(req,res)=>{const chapterId=Number(req.params.chapterId),page=Math.max(0,Math.min(100000,Number(req.body.pageIndex)||0)),mode=['webtoon','horizontal'].includes(req.body.mode)?req.body.mode:'webtoon';db.prepare('INSERT INTO reader_progress(user_id,chapter_id,page_index,mode,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,chapter_id) DO UPDATE SET page_index=excluded.page_index,mode=excluded.mode,updated_at=excluded.updated_at').run(req.user.id,chapterId,page,mode,now());res.json({success:true,pageIndex:page,mode});});
app.get('/api/payments/paypal/config',(req,res)=>res.json({provider:'paypal',receiver:PAYPAL_RECEIVER,mode:process.env.PAYPAL_MODE||'sandbox',configured:Boolean(process.env.PAYPAL_CLIENT_ID&&process.env.PAYPAL_CLIENT_SECRET),clientId:process.env.PAYPAL_CLIENT_ID||'',packages:POINT_PACKAGES,note:'الالتقاط يتم فقط بعد موافقة المستخدم عبر PayPal Smart Buttons.'}));
app.post('/api/payments/paypal/create-order',auth,async(req,res)=>{const packageKey=clean(req.body.packageKey,30),pkg=POINT_PACKAGES[packageKey];if(!pkg)return res.status(400).json({error:'حزمة نقاط غير صالحة.'});try{const order=await paypalRequest('POST','/v2/checkout/orders',{intent:'CAPTURE',purchase_units:[{custom_id:String(req.user.id),description:`Noby ${pkg.label}`,amount:{currency_code:'USD',value:pkg.amount}}],application_context:{brand_name:'Noby',user_action:'PAY_NOW',shipping_preference:'NO_SHIPPING'}});if(!order.id)return res.status(502).json({error:'لم يُرجع PayPal رقم الطلب.'});db.prepare('INSERT INTO paypal_orders(order_id,user_id,package_key,points,amount,currency,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(order.id,req.user.id,packageKey,pkg.points,pkg.amount,'USD','CREATED',now());res.json({orderID:order.id,packageKey,points:pkg.points});}catch(error){if(error.message==='PAYPAL_NOT_CONFIGURED')return res.status(503).json({error:'أضف مفاتيح PayPal الرسمية قبل تفعيل الشراء.'});res.status(502).json({error:'تعذر إنشاء طلب PayPal.'});}});
app.post('/api/payments/paypal/capture-order',auth,async(req,res)=>{const orderId=clean(req.body.orderID,80);if(!/^[A-Z0-9-]{10,80}$/i.test(orderId))return res.status(400).json({error:'رقم طلب PayPal غير صالح.'});const local=db.prepare('SELECT * FROM paypal_orders WHERE order_id=? AND user_id=?').get(orderId,req.user.id);if(!local)return res.status(404).json({error:'طلب الدفع غير معروف لهذا الحساب.'});if(local.status==='COMPLETED')return res.json({success:true,alreadyCaptured:true,points:db.prepare('SELECT points FROM users WHERE id=?').get(req.user.id).points});try{const capture=await paypalRequest('POST',`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,{});const completed=capture.status==='COMPLETED'||capture.purchase_units?.[0]?.payments?.captures?.some(x=>x.status==='COMPLETED');if(!completed)return res.status(402).json({error:'لم تكتمل دفعة PayPal.'});const tx=db.transaction(()=>{const marked=db.prepare('UPDATE paypal_orders SET status=?,captured_at=? WHERE order_id=? AND status<>?').run('COMPLETED',now(),orderId,'COMPLETED');if(marked.changes===1)db.prepare('UPDATE users SET points=points+? WHERE id=?').run(local.points,req.user.id);});tx();res.json({success:true,points:db.prepare('SELECT points FROM users WHERE id=?').get(req.user.id).points,packageKey:local.package_key});}catch(error){res.status(502).json({error:'تعذر التقاط دفعة PayPal.'});}});
app.post('/api/store/purchase',auth,(req,res)=>{const item=clean(req.body.itemKey,80);const tx=db.transaction(()=>{const u=db.prepare('SELECT points FROM users WHERE id=?').get(req.user.id);if(!u||u.points<30)throw Error('نقاطك غير كافية.');db.prepare('INSERT INTO purchases(user_id,item_key,cost,created_at) VALUES(?,?,?,?)').run(req.user.id,item,30,now());db.prepare('UPDATE users SET points=points-30,avatar_frame=? WHERE id=?').run(item,req.user.id);});try{tx();res.json({success:true,...db.prepare('SELECT points,avatar_frame FROM users WHERE id=?').get(req.user.id)});}catch(e){res.status(400).json({error:e.message.includes('نقاط')?e.message:'العنصر مفعّل مسبقاً أو تعذر الشراء.'});}});

app.post('/api/admin/login',(req,res)=>{if(!adminConfigured())return res.status(503).json({error:'لم تُضبط بيانات المشغل بعد.'});const email=clean(req.body.email,160).toLowerCase(),pass=req.body.password||'',valid=email===String(process.env.ADMIN_EMAIL).toLowerCase()&&(process.env.ADMIN_PASSWORD_HASH?bcrypt.compareSync(pass,process.env.ADMIN_PASSWORD_HASH):pass===process.env.ADMIN_PASSWORD);if(!valid)return res.status(401).json({error:'بيانات المشغل غير صحيحة.'});const t=randomToken();db.prepare('INSERT INTO admin_sessions(token_hash,expires_at,created_at) VALUES(?,?,?)').run(hash(t),now()+86400000,now());setCookie(res,'noby_admin',t,86400);res.json({success:true});});
app.post('/api/admin/logout',(req,res)=>{const t=cookieValue(req,'noby_admin');if(t)db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(hash(t));clearCookie(res,'noby_admin');res.json({success:true});});
app.get('/api/admin/summary',admin,(req,res)=>res.json({users:db.prepare('SELECT COUNT(*) n FROM users').get().n,manga:db.prepare('SELECT COUNT(*) n FROM manga').get().n,chapters:db.prepare('SELECT COUNT(*) n FROM chapters').get().n,adViews:db.prepare("SELECT COUNT(*) n FROM ad_events WHERE event_type='view'").get().n,adClicks:db.prepare("SELECT COUNT(*) n FROM ad_events WHERE event_type='click'").get().n}));
app.post('/api/admin/manga',admin,(req,res)=>{const b=req.body;if(!clean(b.titleAr,255))return res.status(400).json({error:'العنوان العربي مطلوب.'});const r=db.prepare('INSERT INTO manga(title_ar,title_en,category,status,rating,cover_url,description,created_at) VALUES(?,?,?,?,?,?,?,?)').run(clean(b.titleAr,255),clean(b.titleEn,255),clean(b.category,40)||'other',clean(b.status,40)||'مستمر',Number(b.rating)||0,clean(b.coverUrl,1000),clean(b.description,2000),now());res.status(201).json({id:r.lastInsertRowid});});
app.post('/api/admin/manga/:id/chapters',admin,(req,res)=>{const pages=Array.isArray(req.body.pages)?req.body.pages.map(x=>clean(x,1200)).filter(Boolean):[];if(!pages.length)return res.status(400).json({error:'أضف صفحات الفصل.'});const r=db.prepare('INSERT INTO chapters(manga_id,number,title,pages_json,translated_text,status,created_at) VALUES(?,?,?,?,?,?,?)').run(Number(req.params.id),Number(req.body.number),clean(req.body.title,255)||`الفصل ${req.body.number}`,JSON.stringify(pages),clean(req.body.translatedText,50000),'published',now());res.status(201).json({id:r.lastInsertRowid});});
app.put('/api/admin/ads/:slot',admin,(req,res)=>{db.prepare('UPDATE ad_slots SET enabled=?,mode=?,client_id=?,ad_slot=?,title=?,body=?,href=? WHERE slot_key=?').run(req.body.enabled===false?0:1,clean(req.body.mode,20)||'house',clean(req.body.clientId,120),clean(req.body.adSlot,80),clean(req.body.title,255),clean(req.body.body,500),clean(req.body.href,1000)||'#',clean(req.params.slot,80));res.json({success:true});});

function htmlSafe(value) { return String(value||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function renderSeoPage(req,item) { const origin=String(process.env.PUBLIC_ORIGIN||`${req.protocol}://${req.get('host')}`).replace(/\/$/,''); const title=item?`${item.title_ar} — نوبي`:'نوبي — مكتبة القراءة العربية'; const description=item?(item.description||`اقرأ ${item.title_ar} على نوبي.`):'منصة قراءة عربية مستقلة للأعمال المصرح بها'; const image=item?.cover_url||`${origin}/og-default.svg`; const canonical=item?`${origin}/manga/${item.id}`:origin+'/'; const schema=JSON.stringify(item?{'@context':'https://schema.org','@type':'ComicSeries','name':item.title_ar,'description':description,'image':image,'url':canonical}:{'@context':'https://schema.org','@type':'WebSite','name':'نوبي Noby','url':canonical,'description':description}); const html=fs.readFileSync(path.join(__dirname,'public','index.html'),'utf8'); return html.replaceAll('__SEO_TITLE__',htmlSafe(title)).replaceAll('__SEO_DESCRIPTION__',htmlSafe(description)).replaceAll('__SEO_IMAGE__',htmlSafe(image)).replaceAll('__SEO_CANONICAL__',htmlSafe(canonical)).replace('__SEO_SCHEMA__',schema.replace(/</g,'\\u003c')); }
app.get('/',(req,res)=>res.type('html').send(renderSeoPage(req,null)));
app.get('/manga/:id',(req,res)=>{const item=db.prepare('SELECT * FROM manga WHERE id=? AND published=1').get(Number(req.params.id));res.type('html').send(renderSeoPage(req,item||null));});
app.use(express.static(path.join(__dirname,'public'),{maxAge:process.env.NODE_ENV==='production'?'1d':0}));
app.use((req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
openLocalDb(DB_FILE).then(local=>{db=local;initDb();app.listen(PORT,'0.0.0.0',()=>{console.log(`[Noby standalone] listening on ${PORT}; db=${DB_FILE}`);startEmbeddedScheduler();});}).catch(error=>{console.error('[Noby standalone] database startup failed',error);process.exit(1)});
process.on('SIGTERM',()=>process.exit(0));
process.on('SIGINT',()=>process.exit(0));
