import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');
const PERSIST_PATH = path.join(DATA_DIR, 'clues.json');

const MAX_TEAMS = Number(process.env.MAX_TEAMS || 20);
const MAX_STEPS = Number(process.env.MAX_STEPS || 20);
const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);   // 1 min default
const MAX_ATTEMPTS = Number(process.env.RATE_LIMIT_MAX_ATTEMPTS || 20); // 20 req/min default

const app = express();
app.use(cors({
  origin: '*', // dev; tighten in prod if needed
  exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
}));
app.use(express.json());

// ---- GitHub commit helpers ----
async function githubGetSha({ token, repo, path, branch }) {
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
  if (resp.status === 404) return null; // new file
  if (!resp.ok) throw new Error(`GitHub GET failed: ${resp.status}`);
  const json = await resp.json();
  return json.sha || null;
}

async function githubUpsertFile({ token, repo, path, branch, contentBuffer, message, committer }) {
  const sha = await githubGetSha({ token, repo, path, branch });
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`;
  const body = {
    message,
    branch,
    content: Buffer.from(contentBuffer).toString('base64'),
    sha: sha || undefined,
    committer: committer || undefined,
  };
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(()=> '');
    throw new Error(`GitHub PUT failed: ${resp.status} ${txt}`);
  }
  return await resp.json();
}


/**
 * Store shape:
 *   clueMap key = `${team}-${step}`
 *   value = { in: normalizedInputClue, out: outputClue, pin: normalizedPIN }
 *
 *   teamPins map keeps one canonical PIN per team for fast checks:
 *   teamPins.get(team) -> normalizedPIN
 */
let clueMap = new Map();
let teamPins = new Map();

const upload = multer({ storage: multer.memoryStorage() });

const normalize = (s) => (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const normalizePin = (s) => (s || '').trim(); // do not lowercase pins (they may be case-sensitive if you want). Change to .toLowerCase() if desired.

function loadFromDisk() {
  try {
    if (!fs.existsSync(PERSIST_PATH)) return;
    const obj = JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf8'));
    const m = new Map();
    const tp = new Map();
    for (const [k, v] of Object.entries(obj)) {
      m.set(k, v);
      const team = Number(k.split('-')[0]);
      if (v?.pin) tp.set(team, v.pin);
    }
    clueMap = m;
    teamPins = tp;
    console.log(`Loaded ${clueMap.size} clues from disk`);
  } catch (e) {
    console.error('Failed to load clues.json:', e.message);
  }
}

function saveToDisk() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = {};
    for (const [k, v] of clueMap.entries()) obj[k] = v;
    fs.writeFileSync(PERSIST_PATH, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save clues.json:', e.message);
  }
}

function requireAdminSecret(req, res, next) {
  const need = !!process.env.ADMIN_SECRET;
  if (!need) return next();
  const provided = req.get('x-admin-secret');
  if (!provided || provided !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized: invalid admin secret' });
  }
  next();
}

// Rate-limit /api/verify by team PIN + IP (so one team cannot rate-limit another)
const verifyLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_ATTEMPTS,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const pin = normalizePin(req.body?.teamPin || 'unknown');
    const ip = ipKeyGenerator(req); // IPv6-safe
    return `${pin}:${ip}`;
  },
  message: { ok: false, error: 'Too many attempts. Please wait and try again.' },
});

// Status
app.get('/api/status', (req, res) => {
  res.json({ ok: true, count: clueMap.size, teams: new Set([...clueMap.keys()].map(k => Number(k.split('-')[0]))).size });
});

// Upload CSV (now requires team_pin column)
app.post('/api/upload', requireAdminSecret, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded (field "file")' });
    const rows = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true });

    const m = new Map();
    const tp = new Map();

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const tn = Number(r.team_number);
      const sn = Number(r.step_number);
      const pinRaw = r.team_pin;
      const input = normalize(r.input_clue);
      const output = String(r.output_clue ?? '');

      if (!Number.isInteger(tn) || tn < 1 || tn > MAX_TEAMS) throw new Error(`Row ${i + 2}: Invalid team_number (1..${MAX_TEAMS})`);
      if (!Number.isInteger(sn) || sn < 1 || sn > MAX_STEPS) throw new Error(`Row ${i + 2}: Invalid step_number (1..${MAX_STEPS})`);
      if (!pinRaw) throw new Error(`Row ${i + 2}: team_pin is required`);
      if (!input) throw new Error(`Row ${i + 2}: input_clue is required`);
      if (!output) throw new Error(`Row ${i + 2}: output_clue is required`);

      const key = `${tn}-${sn}`;
      if (m.has(key)) throw new Error(`Duplicate team/step at row ${i + 2}: ${key}`);

      const pin = normalizePin(pinRaw);
      const existingPin = tp.get(tn);
      if (existingPin && existingPin !== pin) {
        throw new Error(`Row ${i + 2}: team_pin mismatch for team ${tn} (pins must be consistent for a team)`);
      }
      tp.set(tn, pin);

      m.set(key, { in: input, out: output, pin });
    }

    clueMap = m;
    teamPins = tp;
    saveToDisk();

        let committed = false, commitError = null;
        try {
          const token = process.env.GITHUB_TOKEN;
          const repo  = process.env.GITHUB_REPO;   // "user/repo"
          const path  = process.env.GITHUB_PATH;   // e.g. "ops/prod-clues.csv"
          const branch= process.env.GITHUB_BRANCH || 'main';
          if (token && repo && path) {
            const committer = (process.env.GITHUB_COMMITTER_NAME && process.env.GITHUB_COMMITTER_EMAIL)
              ? { name: process.env.GITHUB_COMMITTER_NAME, email: process.env.GITHUB_COMMITTER_EMAIL }
              : undefined;

            // commit the EXACT CSV that admin uploaded
            await githubUpsertFile({
              token, repo, path, branch,
              contentBuffer: req.file.buffer,
              message: `chore(clues): update via admin upload (${new Date().toISOString()})`,
              committer,
            });
            committed = true;
          }
        } catch (e) {
          commitError = e.message || 'commit failed';
        }

        return res.json({ ok: true, count: clueMap.size, teams: teamPins.size, stepsMax: MAX_STEPS, committed, commitError });

    // res.json({ ok: true, count: clueMap.size, teams: teamPins.size, stepsMax: MAX_STEPS });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'Failed to parse CSV' });
  }
});

// Verify (requires teamNumber, stepNumber, inputClue, teamPin)
app.post('/api/verify', verifyLimiter, (req, res) => {
  const { teamNumber, stepNumber, inputClue, teamPin } = req.body || {};

  const tn = Number(teamNumber);
  const sn = Number(stepNumber);
  const pin = normalizePin(teamPin);
  if (!Number.isInteger(tn) || tn < 1 || tn > MAX_TEAMS) {
    return res.status(400).json({ ok: false, error: `Invalid teamNumber (1..${MAX_TEAMS})` });
  }
  if (!Number.isInteger(sn) || sn < 1 || sn > MAX_STEPS) {
    return res.status(400).json({ ok: false, error: `Invalid stepNumber (1..${MAX_STEPS})` });
  }
  if (!pin) {
    return res.status(400).json({ ok: false, error: 'teamPin is required' });
  }

  // Check that PIN matches the team’s registered PIN
  const canonicalPin = teamPins.get(tn);
  if (!canonicalPin) {
    return res.status(404).json({ ok: false, error: 'Unknown team' });
  }
  if (pin !== canonicalPin) {
    return res.status(401).json({ ok: false, error: 'Invalid team PIN' });
  }

  const key = `${tn}-${sn}`;
  const rec = clueMap.get(key);
  if (!rec) return res.status(404).json({ ok: false, error: 'No clue configured for this team/step' });

  if (normalize(inputClue) !== rec.in) {
    return res.status(400).json({ ok: false, error: 'Incorrect input clue for this team/step' });
  }
  return res.json({ ok: true, outputClue: rec.out });
});

// Minimal /admin page (unchanged, still supports secret)
app.get('/admin', (req, res) => {
  const needSecret = !!process.env.ADMIN_SECRET;
  const html = `
<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Admin Upload</title>
<style>body{font-family:system-ui; padding:24px} .card{max-width:640px;margin:0 auto;border:1px solid #eee;border-radius:8px;padding:16px}
label{display:block;margin:8px 0 4px} input,button{padding:8px} .ok{color:green} .err{color:#b00020}</style>
</head><body><div class="card">
<h2>Upload Clues CSV</h2>
<form id="f">
${needSecret ? '<label>Admin Secret</label><input id="sec" type="password" placeholder="ADMIN_SECRET" required />' : '<p><em>No ADMIN_SECRET set. Upload is open.</em></p>'}
<label>CSV File (with team_pin)</label><input id="file" type="file" accept=".csv" required />
<button>Upload</button><div id="msg" style="margin-top:8px"></div>
</form></div>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = document.getElementById('file').files[0];
  if (!file) return;
  const fd = new FormData(); fd.append('file', file);
  const headers = {};
  const secEl = document.getElementById('sec');
  if (secEl) headers['x-admin-secret'] = secEl.value.trim();
  const resp = await fetch('/api/upload', { method: 'POST', body: fd, headers });
  const data = await resp.json();
  const msg = document.getElementById('msg');
  if (data.ok) { msg.className='ok'; msg.textContent = 'Uploaded. Count=' + data.count + ', Teams=' + data.teams; }
  else { msg.className='err'; msg.textContent = data.error || 'Upload failed'; }
});
</script></body></html>`;
  res.set('content-type', 'text/html; charset=utf-8').send(html);
});

const PORT = process.env.PORT || 4000;
loadFromDisk();
app.listen(PORT, () => console.log(`Backend running on ${PORT}`));
