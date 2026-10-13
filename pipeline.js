const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const { openLocalDb } = require('../local-db');

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i === -1 ? '' : String(args[i + 1] || ''); };
const flag = name => args.includes(name);
const URL_INPUT = option('--url');
const DB_FILE = option('--db') || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'noby.sqlite');
const AI_BASE = String(process.env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');
const AI_KEY = process.env.OPENAI_API_KEY || '';
const AI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ALLOWLIST = String(process.env.INGEST_ALLOWLIST || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const now = () => Date.now();
const clean = (value, max = 50000) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const isPrivateIPv4 = ip => /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
const isPrivateIPv6 = ip => /^(::1|fc00:|fd[0-9a-f]{2}:|fe80:)/i.test(ip);
function usage() { console.log('node worker/pipeline.js --url <licensed-public-url> --license-confirmed --license-url <url> [--translate] [--manga-id <id>] [--chapter-number <n>] [--db <file>]'); }
function allowedHost(host) { return ALLOWLIST.length > 0 && ALLOWLIST.some(domain => host === domain || host.endsWith(`.${domain}`)); }
async function assertPublicUrl(raw, requireAllowlist = true) {
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('المصدر يجب أن يكون HTTP أو HTTPS.');
  if (requireAllowlist && !allowedHost(parsed.hostname.toLowerCase())) throw new Error('النطاق غير موجود في INGEST_ALLOWLIST.');
  const records = await dns.lookup(parsed.hostname, { all: true });
  if (!records.length || records.some(record => isPrivateIPv4(record.address) || isPrivateIPv6(record.address))) throw new Error('تم رفض عنوان شبكة خاص أو محلي.');
  return parsed;
}
async function fetchText(url) {
  await assertPublicUrl(url);
  const response = await fetch(url, {headers:{'user-agent':'NobyLicensedPipeline/1.0 (+operator-configured)','accept':'text/html,application/xhtml+xml'},signal:AbortSignal.timeout(20000)});
  if (!response.ok) throw new Error(`فشل جلب المصدر: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_HTML_BYTES) throw new Error('صفحة المصدر أكبر من الحد المسموح.');
  return bytes.toString('utf8');
}
function htmlText(html) { return clean(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ')); }
function attrValues(html, attribute) { const result = []; const re = new RegExp(`<[^>]+${attribute}=["']([^"']+)["'][^>]*>`, 'gi'); let match; while ((match = re.exec(html))) result.push(match[1]); return result; }
function absoluteUrl(value, base) { try { return new URL(value, base).href; } catch { return ''; } }
function parseJsonLd(html) { const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]; for (const block of blocks) { try { const parsed = JSON.parse(block[1]); return Array.isArray(parsed) ? parsed[0] : parsed; } catch {} } return {}; }
function extractSource(html, sourceUrl) {
  const jsonLd = parseJsonLd(html);
  const title = clean(jsonLd.name || (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || [,''])[1] || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [,''])[1], 255);
  const description = clean(jsonLd.description || (html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)/i) || [,''])[1], 2000);
  const cover = absoluteUrl(jsonLd.image?.url || jsonLd.image || (html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i) || [,''])[1], sourceUrl);
  const candidates = [...attrValues(html, 'data-page'), ...attrValues(html, 'data-src'), ...attrValues(html, 'src')].map(value => absoluteUrl(value, sourceUrl)).filter(Boolean);
  const pages = [...new Set(candidates)].filter(value => /\.(?:jpe?g|png|webp|gif)(?:\?.*)?$/i.test(value)).slice(0, 300);
  return { title, description, cover, pages, sourceText: htmlText(html).slice(0, 30000) };
}
async function ai(messages) {
  if (!AI_KEY) throw new Error('OPENAI_API_KEY غير مضبوط.');
  const response = await fetch(`${AI_BASE}/chat/completions`, {method:'POST',headers:{Authorization:`Bearer ${AI_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:AI_MODEL,temperature:0.2,messages,max_tokens:6000})});
  if (!response.ok) throw new Error(`فشل مزود الذكاء الاصطناعي: HTTP ${response.status}`);
  const payload = await response.json();
  return String(payload.choices?.[0]?.message?.content || '').trim();
}
async function translateAndAudit(source, profile) {
  let text = await ai([{role:'system',content:'أنت مترجم مانجا عربي. احفظ أسماء الشخصيات ونبرة الحوار. أخرج النص العربي فقط دون مقدمات.'},{role:'user',content:`ترجم النص التالي إلى العربية بأسلوب ${profile}:\n${source}`}]);
  let score = 0;
  const audit = [];
  for (let pass = 1; pass <= 3; pass++) {
    const output = await ai([{role:'system',content:'أنت مدقق ترجمة صارم. أخرج JSON صالحاً فقط بالمفاتيح text وscore وissues. score رقم بين 0 و1.'},{role:'user',content:`راجع الترجمة التالية مقابل المصدر. أصلح المعنى والنبرة والاتساق.\nالمصدر:\n${source}\nالترجمة:\n${text}`}]);
    let result; try { result = JSON.parse(output.replace(/^```json\s*|\s*```$/g,'')); } catch { result = {text,score:0,issues:['تعذر تحليل نتيجة المراجعة']}; }
    text = clean(result.text || text);
    score = Math.max(0, Math.min(1, Number(result.score) > 1 ? Number(result.score) / 100 : Number(result.score) || 0));
    audit.push({pass,score,issues:Array.isArray(result.issues)?result.issues.slice(0,10):[]});
    if (score >= 0.92 && audit.at(-1).issues.length === 0) break;
  }
  return { text, score, audit };
}
function ensureSchema(db) { db.exec(`CREATE TABLE IF NOT EXISTS manga (id INTEGER PRIMARY KEY AUTOINCREMENT,title_ar TEXT NOT NULL,title_en TEXT NOT NULL DEFAULT '',category TEXT NOT NULL DEFAULT 'other',status TEXT NOT NULL DEFAULT 'مستمر',rating REAL NOT NULL DEFAULT 0,cover_url TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',published INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS chapters (id INTEGER PRIMARY KEY AUTOINCREMENT,manga_id INTEGER NOT NULL REFERENCES manga(id) ON DELETE CASCADE,number INTEGER NOT NULL,title TEXT NOT NULL,pages_json TEXT NOT NULL DEFAULT '[]',translated_text TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'needs_review',created_at INTEGER NOT NULL,UNIQUE(manga_id,number));`); }
async function main() {
  if (!URL_INPUT || !flag('--license-confirmed') || !option('--license-url')) { usage(); throw new Error('يجب تقديم رابط عام مصرح به مع --license-confirmed و--license-url.'); }
  const sourceUrl = await assertPublicUrl(URL_INPUT);
  const licenseUrl = await assertPublicUrl(option('--license-url'));
  const html = await fetchText(sourceUrl.href);
  const source = extractSource(html, sourceUrl.href);
  if (!source.title || source.pages.length === 0) throw new Error('لم يجد العامل عنواناً وصفحات صور كاملة في المصدر.');
  if (!allowedHost(licenseUrl.hostname.toLowerCase())) throw new Error('رابط الرخصة يجب أن يكون ضمن INGEST_ALLOWLIST.');
  const db = await openLocalDb(DB_FILE); ensureSchema(db);
  let mangaId = Number(option('--manga-id')) || 0;
  if (!mangaId) { const row = db.prepare('INSERT INTO manga(title_ar,title_en,category,status,rating,cover_url,description,published,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(clean(option('--title-ar')||source.title,255),source.title,'other','needs_review',0,source.cover,`${source.description}\nالمصدر المرخص: ${sourceUrl.href}\nالرخصة: ${licenseUrl.href}`,0,now()); mangaId = row.lastInsertRowid; }
  let translatedText = '';
  let status = 'needs_review';
  let audit = [];
  if (flag('--translate')) { const result = await translateAndAudit(source.sourceText, option('--style') || 'حوار عربي طبيعي مرن'); translatedText = result.text; audit = result.audit; status = result.score >= 0.92 ? 'published' : 'needs_review'; }
  const number = Number(option('--chapter-number') || 1);
  db.prepare('INSERT INTO chapters(manga_id,number,title,pages_json,translated_text,status,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(manga_id,number) DO UPDATE SET pages_json=excluded.pages_json,translated_text=excluded.translated_text,status=excluded.status,title=excluded.title').run(mangaId,number,clean(option('--chapter-title')||source.title,255),JSON.stringify(source.pages),translatedText,status,now());
  console.log(JSON.stringify({ok:true,mangaId,chapterNumber:number,pages:source.pages.length,status,audit,source:sourceUrl.href,license:licenseUrl.href},null,2));
}
main().catch(error=>{console.error(`[Noby pipeline] ${error.message}`);process.exit(1)});
