require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const Anthropic = require('@anthropic-ai/sdk');

// Never let one bad request take the whole server down. Without these
// handlers, an error thrown outside a try/catch becomes an "unhandled
// rejection", and Node terminates the process by default — which is exactly
// what makes the browser see a hard "Failed to fetch" with no HTTP response
// at all.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const ENV_PATH = path.join(__dirname, '.env');
const DATA_PATH = path.join(__dirname, 'data.json');

// ---------------------------------------------------------------------------
// Single JSON-file data store. This app is built for one small agency office
// (not a multi-tenant SaaS), so a plain file next to server.js — the same
// pattern used for history.json in the sibling "AI Movie Architect" app — is
// simpler to run, back up, and deploy than standing up a real database.
// Everything lives under one object and is rewritten atomically (write to a
// temp file, then rename) so a crash mid-write can't corrupt it.
// ---------------------------------------------------------------------------
const DEFAULT_DATA = {
  workers: [],       // recruitment / worker pipeline records
  finance: [],        // receivable & payable ledger entries
  training: [],        // pre-departure training session records
  contentHistory: [],   // generated social-media recruitment posts (most recent first)
  importedWorkers: [],   // read-only snapshot imported from the user's other system (KS Recruitment Agency)
  importedJobs: [],       // read-only snapshot of that system's job postings
};

let db = JSON.parse(JSON.stringify(DEFAULT_DATA));
db.importMeta = null; // not an array, so it's set explicitly here rather than via DEFAULT_DATA + the array-enforcement loop below
try {
  const loaded = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  db = Object.assign(JSON.parse(JSON.stringify(DEFAULT_DATA)), { importMeta: null }, loaded);
  for (const key of Object.keys(DEFAULT_DATA)) {
    if (!Array.isArray(db[key])) db[key] = [];
  }
  if (db.importMeta === undefined) db.importMeta = null;
} catch (e) { /* no data.json yet — start empty */ }

function saveData() {
  try {
    const tmpPath = DATA_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2));
    fs.renameSync(tmpPath, DATA_PATH);
  } catch (e) {
    console.error('[data] could not persist data.json:', e.message);
  }
}

// Trim defensively: a stray trailing newline/space in .env (common when a key
// is pasted from a browser or a Windows editor) can otherwise produce an
// invalid HTTP header and break every request to the Anthropic API. `let`
// (not `const`) because /api/set-key below lets the app save a key from the
// browser and start using it immediately, with no restart needed.
let apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
let anthropic = new Anthropic({
  apiKey, // stays server-side only, never sent to the browser
  timeout: 120000, // 2 minutes
});

// ---------------------------------------------------------------------------
// Optional access gate — matters once this app is deployed somewhere public,
// since it holds real financial/personal data. Locally, with SITE_PASSWORD
// unset, the app behaves exactly as before (no login screen at all). Set
// SITE_PASSWORD (in .env, or in your host's environment-variable dashboard)
// and every page/API call requires a matching session cookie first.
// ---------------------------------------------------------------------------
const SITE_PASSWORD = (process.env.SITE_PASSWORD || '').trim();

app.set('trust proxy', 1); // most hosts (Render/Railway/etc.) sit behind a proxy
app.use(session({
  secret: crypto.createHash('sha256').update(SITE_PASSWORD || 'labor-agency-manager-local-default').digest('hex'),
  name: 'lam.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 14, // 2 weeks
  },
}));

const LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="lo" class="dark"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ຈັດການແຮງງານ — Login</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Noto+Sans+Lao:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090B;color:#E4E4E7;font-family:'Inter','Noto Sans Lao',sans-serif;}
  .card{background:rgba(24,24,27,0.9);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:32px;width:100%;max-width:360px;box-shadow:0 20px 60px rgba(0,0,0,0.5);}
  h1{font-size:17px;margin:0 0 4px;background:linear-gradient(90deg,#fff,#EF4444);-webkit-background-clip:text;background-clip:text;color:transparent;}
  p{font-size:12px;color:#A1A1AA;margin:0 0 20px;}
  input{width:100%;box-sizing:border-box;background:rgba(39,39,42,0.6);border:1px solid rgba(255,255,255,0.12);color:#F4F4F5;border-radius:12px;padding:11px 12px;font-size:13px;margin-bottom:12px;}
  input:focus{outline:none;border-color:#EF4444;box-shadow:0 0 0 2px rgba(239,68,68,0.25);}
  button{width:100%;background:linear-gradient(90deg,#DC2626,#7F1D1D);color:#fff;border:none;border-radius:12px;padding:11px;font-size:13px;font-weight:600;cursor:pointer;}
  button:disabled{opacity:0.6;cursor:not-allowed;}
  #err{color:#FB7185;font-size:12px;min-height:16px;margin-top:8px;}
</style></head>
<body>
  <form class="card" id="loginForm">
    <h1>ລະບົບຈັດການແຮງງານ</h1>
    <p>ໃສ່ລະຫັດຜ່ານເພື່ອເຂົ້າໃຊ້ (Enter the access password)</p>
    <input type="password" id="pw" placeholder="Password" autofocus autocomplete="current-password">
    <button type="submit" id="btn">ເຂົ້າສູ່ລະບົບ (Log in)</button>
    <div id="err"></div>
  </form>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      const btn = document.getElementById('btn');
      const err = document.getElementById('err');
      err.innerText = '';
      btn.disabled = true;
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: document.getElementById('pw').value })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Login failed.');
        window.location.href = '/';
      } catch (ex) {
        err.innerText = ex.message;
        btn.disabled = false;
      }
    });
  </script>
</body></html>`;

app.get('/login', (req, res) => {
  if (!SITE_PASSWORD) return res.redirect('/'); // no password configured
  res.type('html').send(LOGIN_PAGE_HTML);
});

app.post('/api/login', express.json(), (req, res) => {
  if (!SITE_PASSWORD) return res.json({ ok: true });
  const submitted = ((req.body && req.body.password) || '').toString();
  if (submitted !== SITE_PASSWORD) {
    return res.status(401).json({ error: 'ລະຫັດຜ່ານບໍ່ຖືກຕ້ອງ (incorrect password).' });
  }
  req.session.authenticated = true;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.use((req, res, next) => {
  if (!SITE_PASSWORD) return next();
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Please log in first.', loginRequired: true });
  }
  return res.redirect('/login');
});

// ---------------------------------------------------------------------------
// Import workers/jobs from a "KS Recruitment Agency" backup JSON export (the
// user's other, already-in-production system that manages the same workers
// in much finer detail — passport/medical/document data, job postings,
// orders, invoices). Registered here, BEFORE the app-wide
// express.json({limit:'1mb'}) below, so this route's own larger json limit
// gets first look at the request body — a real backup (600+ workers with
// photo URLs and full passport/medical detail) runs several MB, well over
// the app's normal request size. Same registration-order pattern as the
// sibling AI Movie Architect app uses for its own oversized image routes.
//
// This is a ONE-WAY, READ-ONLY import: imported records are kept in their
// own separate arrays (`importedWorkers`/`importedJobs`), never merged into
// or overwriting the user's own hand-entered `workers` here. Re-importing a
// fresh backup is always safe — it just replaces the previous imported
// snapshot wholesale, the same way re-running the KS system's own "ສຳຮອງ
// ຂໍ້ມູນ" export and re-uploading it here is meant to be a routine refresh,
// not a one-time migration. The heavy embedded base64 "logo"/"photo1-3" fields on job
// records is stripped on the way in purely to keep data.json from
// ballooning (the agency's own employer logos aren't needed for anything
// this app does with them); nothing else is dropped — every other field is
// kept as-is for full fidelity.
// ---------------------------------------------------------------------------
app.post('/api/import/ks-backup', express.json({ limit: '15mb' }), (req, res) => {
  const body = req.body || {};
  if (!body || typeof body !== 'object' || !Array.isArray(body.workers)) {
    return res.status(400).json({ error: 'ໄຟລ໌ນີ້ບໍ່ແມ່ນ backup ທີ່ຖືກຕ້ອງ (ບໍ່ພົບ "workers" ຢູ່ໃນໄຟລ໌).' });
  }
  const workers = body.workers;
  const jobs = Array.isArray(body.jobs) ? body.jobs : [];

  db.importedWorkers = workers.map((w) => Object.assign({}, w));
  // Drop embedded base64 employer logo/workplace photos — see comment above.
  // These are by far the heaviest fields in a real export (a single job's
  // photo1/photo2/photo3 together can run several hundred KB each, vs. a few
  // bytes for every other field), so stripping them is what actually keeps
  // data.json lean; every other field is kept as-is.
  const HEAVY_JOB_FIELDS = ['logo', 'photo1', 'photo2', 'photo3'];
  db.importedJobs = jobs.map((j) => {
    const copy = Object.assign({}, j);
    HEAVY_JOB_FIELDS.forEach((f) => delete copy[f]);
    return copy;
  });
  db.importMeta = {
    importedAt: nowIso(),
    sourceExportedAt: body.exportedAt || null,
    workerCount: db.importedWorkers.length,
    jobCount: db.importedJobs.length,
  };
  saveData();
  res.json({ ok: true, meta: db.importMeta });
});

app.get('/api/imported-data', (req, res) => {
  res.json({ importedWorkers: db.importedWorkers, importedJobs: db.importedJobs, importMeta: db.importMeta });
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// API key management (same pattern as the sibling AI Movie Architect app):
// saved into .env on disk so it survives a restart, applied live with no
// restart needed.
// ---------------------------------------------------------------------------
app.get('/api/status', (req, res) => {
  res.json({ hasApiKey: Boolean(apiKey), model: MODEL });
});

app.post('/api/set-key', (req, res) => {
  try {
    const submittedKey = ((req.body && req.body.apiKey) || '').toString().trim();
    if (!submittedKey) return res.status(400).json({ error: 'ກະລຸນາວາງ API key.' });
    let envContents = '';
    try { envContents = fs.readFileSync(ENV_PATH, 'utf8'); } catch (e) { /* no .env yet */ }
    const line = `ANTHROPIC_API_KEY=${submittedKey}`;
    if (/^ANTHROPIC_API_KEY=.*$/m.test(envContents)) {
      envContents = envContents.replace(/^ANTHROPIC_API_KEY=.*$/m, line);
    } else {
      envContents = envContents.trim().length ? `${envContents.trim()}\n${line}\n` : `${line}\n`;
    }
    fs.writeFileSync(ENV_PATH, envContents);
    apiKey = submittedKey;
    anthropic = new Anthropic({ apiKey, timeout: 120000 });
    console.log('[set-key] API key saved to .env and applied.');
    res.json({ ok: true });
  } catch (err) {
    console.error('[set-key] error:', err);
    res.status(500).json({ error: 'ບັນທຶກ API key ບໍ່ສຳເລັດ: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function nowIso() { return new Date().toISOString(); }

function requireFields(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || String(body[f]).trim() === '');
  return missing;
}

// ---------------------------------------------------------------------------
// Workers — the recruitment / worker pipeline. A worker moves through fixed
// stages from first application through to working in Thailand. Each stage
// is just a string on the record (not a separate table) so the pipeline can
// be re-ordered or relabeled later without a data migration.
// ---------------------------------------------------------------------------
const WORKER_STAGES = ['applied', 'training', 'documents', 'deployed_waiting', 'working', 'cancelled'];

app.get('/api/workers', (req, res) => {
  res.json({ workers: db.workers });
});

app.post('/api/workers', (req, res) => {
  const body = req.body || {};
  const missing = requireFields(body, ['name', 'phone']);
  if (missing.length) return res.status(400).json({ error: `ກະລຸນາປ້ອນ: ${missing.join(', ')}` });
  const worker = {
    id: crypto.randomUUID(),
    name: String(body.name).trim(),
    phone: String(body.phone).trim(),
    idCardNumber: (body.idCardNumber || '').toString().trim(),
    village: (body.village || '').toString().trim(),
    jobType: (body.jobType || '').toString().trim(),
    destinationCompany: (body.destinationCompany || '').toString().trim(),
    stage: WORKER_STAGES.includes(body.stage) ? body.stage : 'applied',
    documents: Object.assign({ passport: false, healthCheck: false, contract: false, visa: false, workPermit: false }, body.documents || {}),
    notes: (body.notes || '').toString(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  db.workers.unshift(worker);
  saveData();
  res.json({ worker });
});

app.put('/api/workers/:id', (req, res) => {
  const worker = db.workers.find((w) => w.id === req.params.id);
  if (!worker) return res.status(404).json({ error: 'ບໍ່ພົບຂໍ້ມູນແຮງງານນີ້.' });
  const body = req.body || {};
  const fields = ['name', 'phone', 'idCardNumber', 'village', 'jobType', 'destinationCompany', 'notes'];
  for (const f of fields) {
    if (body[f] !== undefined) worker[f] = String(body[f]).trim();
  }
  if (body.stage !== undefined && WORKER_STAGES.includes(body.stage)) worker.stage = body.stage;
  if (body.documents && typeof body.documents === 'object') {
    worker.documents = Object.assign({}, worker.documents, body.documents);
  }
  worker.updatedAt = nowIso();
  saveData();
  res.json({ worker });
});

app.delete('/api/workers/:id', (req, res) => {
  const before = db.workers.length;
  db.workers = db.workers.filter((w) => w.id !== req.params.id);
  if (db.workers.length === before) return res.status(404).json({ error: 'ບໍ່ພົບຂໍ້ມູນແຮງງານນີ້.' });
  // Cascade: also drop this worker's own finance/training records so the
  // ledger and training list don't end up pointing at a deleted person.
  db.finance = db.finance.filter((f) => f.workerId !== req.params.id);
  db.training = db.training.filter((t) => t.workerId !== req.params.id);
  saveData();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Finance — receivable (money owed TO the agency, e.g. worker service fees)
// and payable (money the agency owes OUT, e.g. a sub-agent commission or an
// office expense) ledger entries. Optionally linked to a worker.
// ---------------------------------------------------------------------------
app.get('/api/finance', (req, res) => {
  res.json({ finance: db.finance });
});

app.post('/api/finance', (req, res) => {
  const body = req.body || {};
  const missing = requireFields(body, ['type', 'description', 'amount']);
  if (missing.length) return res.status(400).json({ error: `ກະລຸນາປ້ອນ: ${missing.join(', ')}` });
  if (!['receivable', 'payable'].includes(body.type)) {
    return res.status(400).json({ error: 'type ຕ້ອງເປັນ "receivable" ຫຼື "payable".' });
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'ຈຳນວນເງິນບໍ່ຖືກຕ້ອງ.' });
  const entry = {
    id: crypto.randomUUID(),
    type: body.type,
    workerId: body.workerId || null,
    description: String(body.description).trim(),
    amount,
    currency: (body.currency || 'LAK').toString().trim(),
    status: body.status === 'paid' ? 'paid' : 'unpaid',
    dueDate: (body.dueDate || '').toString(),
    paidDate: body.status === 'paid' ? nowIso() : null,
    createdAt: nowIso(),
  };
  db.finance.unshift(entry);
  saveData();
  res.json({ entry });
});

app.put('/api/finance/:id', (req, res) => {
  const entry = db.finance.find((f) => f.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'ບໍ່ພົບລາຍການນີ້.' });
  const body = req.body || {};
  if (body.description !== undefined) entry.description = String(body.description).trim();
  if (body.amount !== undefined) {
    const amount = Number(body.amount);
    if (Number.isFinite(amount) && amount >= 0) entry.amount = amount;
  }
  if (body.dueDate !== undefined) entry.dueDate = String(body.dueDate);
  if (body.status === 'paid' && entry.status !== 'paid') { entry.status = 'paid'; entry.paidDate = nowIso(); }
  if (body.status === 'unpaid' && entry.status !== 'unpaid') { entry.status = 'unpaid'; entry.paidDate = null; }
  saveData();
  res.json({ entry });
});

app.delete('/api/finance/:id', (req, res) => {
  const before = db.finance.length;
  db.finance = db.finance.filter((f) => f.id !== req.params.id);
  if (db.finance.length === before) return res.status(404).json({ error: 'ບໍ່ພົບລາຍການນີ້.' });
  saveData();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Training — pre-departure training sessions, optionally linked to a worker.
// ---------------------------------------------------------------------------
app.get('/api/training', (req, res) => {
  res.json({ training: db.training });
});

app.post('/api/training', (req, res) => {
  const body = req.body || {};
  const missing = requireFields(body, ['topic']);
  if (missing.length) return res.status(400).json({ error: `ກະລຸນາປ້ອນ: ${missing.join(', ')}` });
  const record = {
    id: crypto.randomUUID(),
    workerId: body.workerId || null,
    // workerSource distinguishes a locally-added worker ('local', the
    // default — looked up live against db.workers each render) from one
    // picked from the read-only KS import ('ks' — those ids live in
    // db.importedWorkers, a different array, so they need their own tag).
    // workerName is a snapshot taken at creation time so the training
    // record still displays a sensible name even if that worker is later
    // deleted locally, or a fresh KS import no longer contains that id.
    workerSource: body.workerSource === 'ks' ? 'ks' : 'local',
    workerName: (body.workerName || '').toString().trim(),
    topic: String(body.topic).trim(),
    date: (body.date || '').toString(),
    completed: Boolean(body.completed),
    notes: (body.notes || '').toString(),
    createdAt: nowIso(),
  };
  db.training.unshift(record);
  saveData();
  res.json({ record });
});

app.put('/api/training/:id', (req, res) => {
  const record = db.training.find((t) => t.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'ບໍ່ພົບລາຍການອົບຮົມນີ້.' });
  const body = req.body || {};
  if (body.topic !== undefined) record.topic = String(body.topic).trim();
  if (body.date !== undefined) record.date = String(body.date);
  if (body.notes !== undefined) record.notes = String(body.notes);
  if (body.completed !== undefined) record.completed = Boolean(body.completed);
  saveData();
  res.json({ record });
});

app.delete('/api/training/:id', (req, res) => {
  const before = db.training.length;
  db.training = db.training.filter((t) => t.id !== req.params.id);
  if (db.training.length === before) return res.status(404).json({ error: 'ບໍ່ພົບລາຍການອົບຮົມນີ້.' });
  saveData();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// AI recruitment content generator — produces a ready-to-post Lao-language
// TikTok/Facebook recruitment caption (plus hashtags) for an open job.
// ---------------------------------------------------------------------------
function buildContentTool() {
  return {
    name: 'submit_recruitment_post',
    description: 'Submit one ready-to-post Lao-language recruitment post for the requested platform.',
    input_schema: {
      type: 'object',
      properties: {
        hook: { type: 'string', description: 'A short, scroll-stopping opening line in Lao (the first 1-2 sentences people see), written to grab attention of a Lao jobseeker on this specific platform.' },
        caption: { type: 'string', description: 'The full post caption in Lao: hook + key job details (role, destination, pay/benefits if given, requirements) + a clear call to action (how to apply/contact). Written in a warm, trustworthy, energetic tone appropriate for recruiting workers, using short paragraphs/line breaks suited to the platform.' },
        hashtags: { type: 'string', description: 'A space-separated list of 6-10 relevant Lao/Thai/English hashtags for reach, e.g. #ຮັບສະໝັກງານ #ໄປເຮັດວຽກໄທ #ງານຖືກກົດໝາຍ.' },
        videoIdeaIfTiktok: { type: 'string', description: 'If the platform is TikTok: 2-3 short bullet-style sentences (as one string) suggesting what the video should show (shots/scenes), since TikTok needs a visual idea, not just a caption. If the platform is Facebook, leave this as an empty string.' },
      },
      required: ['hook', 'caption', 'hashtags', 'videoIdeaIfTiktok'],
    },
  };
}

const CONTENT_SYSTEM_PROMPT = `You are a senior social-media recruitment copywriter working for a licensed Lao labor-export agency that legally recruits Lao workers for jobs in Thailand (factory work, construction, agriculture, services, etc.), handles their pre-departure training, and manages their documents/visas.

Your job is to write a single ready-to-post recruitment advertisement in the LAO LANGUAGE (script), for either TikTok or Facebook as specified, based on the job details the user provides. Follow these rules:
- Write naturally in Lao, in a warm, trustworthy, energetic tone that speaks directly to a Lao jobseeker (often someone in a rural area considering working abroad for the first time) — not a stiff corporate tone.
- Always make clear the recruitment is LEGAL/licensed ("ຖືກກົດໝາຍ") when that fact is relevant, since this reassures jobseekers who are wary of scams.
- Include concrete details the user gave you (job type, destination, pay, benefits, requirements) — never invent numbers or promises the user didn't give you; if pay/benefits aren't given, don't make them up.
- End with a clear, simple call to action telling people exactly how to apply or get in touch.
- Match the platform: TikTok captions are short and punchy with a strong hook since the real content is the video; Facebook captions can be a bit longer and more detailed since Facebook readers expect more information.
- Output ONLY through the submit_recruitment_post tool call.`;

app.post('/api/generate-content', async (req, res) => {
  if (!apiKey) return res.status(400).json({ error: 'ຍັງບໍ່ໄດ້ຕັ້ງ API key. ກະລຸນາເພີ່ມ Anthropic API key ກ່ອນ.' });
  const body = req.body || {};
  const missing = requireFields(body, ['jobTitle', 'platform']);
  if (missing.length) return res.status(400).json({ error: `ກະລຸນາປ້ອນ: ${missing.join(', ')}` });
  if (!['tiktok', 'facebook'].includes(body.platform)) {
    return res.status(400).json({ error: 'platform ຕ້ອງເປັນ "tiktok" ຫຼື "facebook".' });
  }

  const userText = `Write one recruitment post for this job opening:
- Job title / role: ${body.jobTitle}
- Platform: ${body.platform}
- Destination (country/province/employer, if given): ${body.destination || '(not specified)'}
- Pay / benefits (if given): ${body.pay || '(not specified)'}
- Requirements (if given): ${body.requirements || '(not specified)'}
- Extra notes from the agency: ${body.notes || '(none)'}`;

  try {
    const tool = buildContentTool();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1200,
      system: CONTENT_SYSTEM_PROMPT,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: userText }],
    }, { maxRetries: 0 });

    const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === tool.name);
    if (!toolUse) return res.status(502).json({ error: 'Claude ບໍ່ສົ່ງຄຳຕອບແບບທີ່ຄາດໄວ້. ລອງໃໝ່ອີກຄັ້ງ.' });

    const post = toolUse.input;
    const record = {
      id: crypto.randomUUID(),
      jobTitle: body.jobTitle,
      platform: body.platform,
      destination: body.destination || '',
      pay: body.pay || '',
      requirements: body.requirements || '',
      notes: body.notes || '',
      hook: post.hook,
      caption: post.caption,
      hashtags: post.hashtags,
      videoIdeaIfTiktok: post.videoIdeaIfTiktok || '',
      createdAt: nowIso(),
    };
    db.contentHistory.unshift(record);
    if (db.contentHistory.length > 50) db.contentHistory.length = 50;
    saveData();
    res.json({ post: record });
  } catch (err) {
    console.error('[generate-content] error:', err);
    if (err && err.status === 401) {
      return res.status(401).json({ error: 'API key ບໍ່ຖືກຕ້ອງ ຫຼື ໝົດອາຍຸ. ກະລຸນາກວດສອບ ແລະ ຕັ້ງຄ່າໃໝ່.' });
    }
    res.status(500).json({ error: 'ສ້າງຄອນເທນບໍ່ສຳເລັດ: ' + (err && err.message ? err.message : 'unknown error') });
  }
});

app.get('/api/content-history', (req, res) => {
  res.json({ contentHistory: db.contentHistory });
});

app.delete('/api/content-history/:id', (req, res) => {
  db.contentHistory = db.contentHistory.filter((c) => c.id !== req.params.id);
  saveData();
  res.json({ ok: true });
});

// Fallback: serve the SPA shell for any unmatched non-API GET route.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`ລະບົບຈັດການແຮງງານ running on port ${PORT}`);
  console.log(apiKey ? 'ANTHROPIC_API_KEY: found' : 'No API key saved yet — paste one in the app (ຕັ້ງຄ່າ tab) to use the AI content generator.');
  console.log(SITE_PASSWORD ? 'SITE_PASSWORD: set (login required)' : 'SITE_PASSWORD: not set (open access — fine for local use only).');
});
