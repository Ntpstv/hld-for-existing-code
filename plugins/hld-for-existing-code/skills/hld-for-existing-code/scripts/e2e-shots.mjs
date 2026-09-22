#!/usr/bin/env node
// Borrows screenshots from a project's own Playwright e2e tests. Those tests already know how to reach deep
// screens (seeded router state, stub data, multi-step flows), so running them with tracing on and pulling the
// screencast frames out of each trace gives real pictures of screens a URL alone cannot open.
//
//   node e2e-shots.mjs <bundle.json> --project <appDir> --specs <file|dir|glob> [...] [-o out.json]
//   node e2e-shots.mjs <bundle.json> --project <appDir> --traces <dir with trace.zip files> [-o out.json]
//
// Only screens without a screenshot are filled unless --overwrite. Needs `unzip` on PATH (macOS/Linux).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

function usage() {
  process.stderr.write(`Usage: node e2e-shots.mjs <bundle.json> --project <appDir> (--specs <path> ... | --traces <dir>)

  --project <dir>     app folder (where \`npx playwright test\` runs)
  --specs <path>      spec files/dirs to run with tracing (repeatable). Pick stub/mock specs only —
                      specs that hit a real backend will do so again.
  --config <file>     Playwright config to use (default: the project's)
  --traces <dir>      skip running; read trace.zip files already under this folder
  --settle <ms>       how long after arriving on a screen to take the frame (default 2500)
  --overwrite         replace screenshots that capture.mjs already took
  -o <file>           output bundle (default: overwrite the input)
`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const opt = { specs: [], settle: 2500, overwrite: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--project') opt.project = path.resolve(argv[++i]);
  else if (a === '--specs') opt.specs.push(argv[++i]);
  else if (a === '--config') opt.config = argv[++i];
  else if (a === '--traces') opt.traces = path.resolve(argv[++i]);
  else if (a === '--settle') opt.settle = Number(argv[++i]);
  else if (a === '--overwrite') opt.overwrite = true;
  else if (a === '-o') opt.out = argv[++i];
  else if (a === '-h' || a === '--help') usage();
  else if (!a.startsWith('-') && !opt.bundle) opt.bundle = a;
  else { process.stderr.write(`unknown argument: ${a}\n`); usage(); }
}
if (!opt.bundle || !opt.project || (!opt.specs.length && !opt.traces)) usage();
opt.out = opt.out || opt.bundle;

const bundle = JSON.parse(fs.readFileSync(opt.bundle, 'utf8'));
if (bundle.schema !== 'web-hld/1') { process.stderr.write('error: not a web-hld/1 bundle\n'); process.exit(1); }

// ── 1. Run the specs with tracing (output kept out of the project) ──────────
let traceRoot = opt.traces;
if (!traceRoot) {
  traceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'web-hld-e2e-'));
  const args = ['playwright', 'test', ...opt.specs, '--trace', 'on', '--reporter', 'line', '--output', traceRoot];
  if (opt.config) args.push('--config', opt.config);
  process.stderr.write(`running: npx ${args.join(' ')}\n`);
  const r = spawnSync('npx', args, { cwd: opt.project, stdio: ['ignore', 'inherit', 'inherit'] });
  process.stderr.write(`playwright exited with ${r.status} (failed tests still leave usable traces)\n`);
}

const zips = [];
(function find(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) find(p); else if (e.name.endsWith('.zip') && e.name.startsWith('trace')) zips.push(p);
  }
})(traceRoot);
process.stderr.write(`${zips.length} trace(s) in ${traceRoot}\n`);

// ── 2. URL → screen ─────────────────────────────────────────────────────────
const patterns = bundle.screens.map(s => ({ s, dynamic: /[:\[]/.test(s.route), re: new RegExp('^' + s.route.split('/').map(seg =>
  /^:|^\[/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/') + '/?$') }));
function screenAt(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const p = (u.hash.startsWith('#/') ? u.hash.slice(1) : u.pathname).split('?')[0] || '/';
  const hits = patterns.filter(x => x.re.test(p)).sort((a, b) => a.dynamic - b.dynamic);
  return hits[0] ? hits[0].s : null;
}

// ── 3. Each trace: timeline of (time, url) and screencast frames per page ──
const best = new Map();          // route → { zip, sha1, width, height, stay, test, url }
for (const zip of zips) {
  const test = path.basename(path.dirname(zip));
  const names = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n');
  for (const name of names.filter(n => /(^|\/)\d*-?trace\.trace$/.test(n) && !/^test\.trace$/.test(n))) {
    const events = execFileSync('unzip', ['-p', zip, name], { encoding: 'utf8', maxBuffer: 1 << 28 })
      .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const byPage = new Map();    // pageId → { points: [{t,url}], frames: [{t,sha1,w,h}] }
    const pageOf = id => { if (!byPage.has(id)) byPage.set(id, { points: [], frames: [] }); return byPage.get(id); };
    let lastPage = null;
    for (const e of events) {
      if (e.type === 'frame-snapshot' && e.snapshot && e.snapshot.isMainFrame !== false) {
        lastPage = e.snapshot.pageId;
        pageOf(e.snapshot.pageId).points.push({ t: e.snapshot.timestamp, url: e.snapshot.frameUrl });
      } else if (e.type === 'screencast-frame') {
        pageOf(e.pageId).frames.push({ t: e.timestamp, sha1: e.sha1, w: e.width, h: e.height });
      } else if (e.type === 'log' && lastPage) {
        const m = /navigat(?:ing|ed) to "([^"]+)"/.exec(e.message || '');
        if (m) pageOf(lastPage).points.push({ t: e.time, url: m[1] });
      }
    }
    for (const { points, frames } of byPage.values()) {
      if (!frames.length || !points.length) continue;
      points.sort((a, b) => a.t - b.t);
      frames.sort((a, b) => a.t - b.t);
      const end = frames[frames.length - 1].t;
      // contiguous stays on one screen
      const stays = [];
      for (const p of points) {
        const s = screenAt(p.url);
        const cur = stays[stays.length - 1];
        if (cur && cur.s === s) continue;
        if (cur) cur.to = p.t;
        stays.push({ s, from: p.t, to: end, url: p.url });
      }
      for (const st of stays) {
        if (!st.s) continue;
        // late enough for data to load, before the test starts interacting further
        const at = Math.min(st.from + opt.settle, st.to - 50);
        const f = [...frames].reverse().find(x => x.t <= at && x.t >= st.from);
        if (!f) continue;
        const stay = st.to - st.from;
        const prev = best.get(st.s.route);
        if (!prev || stay > prev.stay) best.set(st.s.route, { zip, sha1: f.sha1, width: f.w, height: f.h, stay, test, url: st.url });
      }
    }
  }
}

// ── 4. Merge into the bundle ────────────────────────────────────────────────
const shotDir = path.join(path.dirname(path.resolve(opt.out)), 'screenshots');
fs.mkdirSync(shotDir, { recursive: true });
let added = 0, kept = 0;
for (const s of bundle.screens) {
  const b = best.get(s.route);
  if (!b) continue;
  if (s.screenshot && !opt.overwrite) { kept++; continue; }
  const buf = execFileSync('unzip', ['-p', b.zip, `resources/${b.sha1}`], { maxBuffer: 1 << 26 });
  if (!buf.length) continue;
  fs.writeFileSync(path.join(shotDir, (s.route.replace(/[^\w-]+/g, '_').replace(/^_|_$/g, '') || 'root') + '.e2e.jpg'), buf);
  const u = new URL(b.url);
  s.screenshot = { mime: 'image/jpeg', width: b.width, height: b.height, url: u.pathname + u.hash, via: `e2e: ${b.test}`, data: buf.toString('base64') };
  delete s.captureNote;
  added++;
  process.stderr.write(`  shot ${s.route}  (e2e: ${b.test})\n`);
}
bundle.e2eShots = { traces: zips.length, at: new Date().toISOString() };
fs.writeFileSync(opt.out, JSON.stringify(bundle));
const total = bundle.screens.filter(s => s.screenshot).length;
process.stderr.write(`${added} screenshot(s) added from e2e traces (${kept} already had one) · ${total}/${bundle.screens.length} screens now have a picture · wrote ${opt.out}\n`);
