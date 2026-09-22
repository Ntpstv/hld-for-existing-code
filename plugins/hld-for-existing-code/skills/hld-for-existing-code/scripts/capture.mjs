#!/usr/bin/env node
// Screenshots every screen of a web-hld bundle from the running app, so the Figma board shows the real
// screen instead of an outline. Uses Playwright (the project's own copy when it has one).
//
//   node capture.mjs <bundle.json> --base-url http://localhost:4200 [--project <appDir>]
//        [--init seed.js] [--storage-state state.json] [--param id=123 ...]
//        [--viewport 1280x800] [--full-page] [--wait 1500] [--only /prefix ...] [--no-crawl] [--allow-submit]
//        [-o out.json]
//
// Pass 1 opens every route by URL. Pass 2 (crawl) reaches the rest the way a user does: from a screen that
// is already captured, click the button/row the analyzer says leads there, so the app supplies its own router
// state. A screen that still cannot be reached gets no screenshot and a `captureNote` — a picture of the
// wrong page is worse than the outline.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { Project } from './lib/project.mjs';
import { makeEndpointMatcher, trim, parseJsonLoose, redact } from './lib/sample.mjs';

function usage() {
  process.stderr.write(`Usage: node capture.mjs <bundle.json> --base-url <url> [options]

  --base-url <url>        the app, already running (e.g. http://localhost:4200)
  --project <dir>         app folder; Playwright is loaded from its node_modules
  --init <file.js>        script run in every page before the app starts (seed localStorage login etc.)
  --storage-state <file>  Playwright storage state (cookies + localStorage) from a real login
  --param name=value      value for dynamic segments ([id], :id); default "1" (repeatable)
  --viewport WxH          default 1280x800
  --full-page             capture the whole page (height capped at 3x the viewport)
  --wait <ms>             extra settle time after network idle (default 1200)
  --only /prefix          only these routes (repeatable)
  --no-crawl              skip pass 2 (clicking through the flow to reach screens that need router state)
  --allow-submit          let the crawl click save/confirm/delete-like buttons. Only against a stub or
                          throwaway backend — these send real requests.
  --allow-real-data       required when --base-url is not localhost or --storage-state is used: screenshots of a
                          real backend show real people's data and go onto a shared Figma board. API examples are
                          masked either way; screenshots cannot be.
  -o <file>               output bundle (default: update <bundle.json> in place; images go to screenshots/ beside it)

  No stub/mock server? Answer the app's API calls here instead:
  --mock auto             fake data built from the request/response TypeScript types (needs --project)
  --mock-wrapper <file>   JSON envelope the app expects around every response, "$data" marks the body, e.g.
                          {"status":"OK","data":"$data"}
  --record <file>         browse a real backend once (needs --allow-real-data) and save its API responses with
                          personal data masked; no screenshots are taken in this mode
  --replay <file>         answer API calls from such a recording — offline, masked, repeatable

  Browser:
  --browser chrome        use the installed Google Chrome instead of Playwright's own Chromium
  --install-playwright    if no Playwright is found, install it into the skill's runtime/ folder (downloads)
`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const opt = { params: {}, only: [], viewport: [1280, 800], wait: 1200, fullPage: false, crawl: true, allowSubmit: false, browser: 'chromium' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--base-url') opt.baseUrl = argv[++i].replace(/\/$/, '');
  else if (a === '--project') opt.project = argv[++i];
  else if (a === '--init') opt.init = argv[++i];
  else if (a === '--storage-state') opt.storageState = argv[++i];
  else if (a === '--param') { const [k, ...v] = argv[++i].split('='); opt.params[k] = v.join('='); }
  else if (a === '--viewport') opt.viewport = argv[++i].split('x').map(Number);
  else if (a === '--full-page') opt.fullPage = true;
  else if (a === '--wait') opt.wait = Number(argv[++i]);
  else if (a === '--only') opt.only.push(argv[++i]);
  else if (a === '-o') opt.out = argv[++i];
  else if (a === '--no-crawl') opt.crawl = false;
  else if (a === '--allow-submit') opt.allowSubmit = true;
  else if (a === '--allow-real-data') opt.allowRealData = true;
  else if (a === '--mock') opt.mock = argv[++i];
  else if (a === '--mock-wrapper') opt.mockWrapper = argv[++i];
  else if (a === '--record') opt.record = argv[++i];
  else if (a === '--replay') opt.replay = argv[++i];
  else if (a === '--browser') opt.browser = argv[++i];
  else if (a === '--install-playwright') opt.installPlaywright = true;
  else if (a === '-h' || a === '--help') usage();
  else if (!a.startsWith('-') && !opt.bundle) opt.bundle = a;
  else { process.stderr.write(`unknown argument: ${a}\n`); usage(); }
}
if (!opt.bundle || !opt.baseUrl) usage();
if (opt.mock && opt.mock !== 'auto') { process.stderr.write('--mock only supports "auto"\n'); process.exit(1); }
if (opt.mock && !opt.project) { process.stderr.write('--mock auto needs --project <appDir> (it reads the TypeScript types)\n'); process.exit(1); }
if (opt.record && !opt.allowRealData) {
  process.stderr.write('--record browses a real backend: add --allow-real-data once the owner of that data agrees.\n' +
    'Only masked API responses are saved; no screenshots are taken while recording.\n');
  process.exit(2);
}
if (opt.record && opt.allowSubmit) { process.stderr.write('--allow-submit is ignored while recording: nothing is ever submitted to a real backend\n'); opt.allowSubmit = false; }

// A real backend means real people's data in screenshots, which end up on a shared board.
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1|[\w-]+\.localhost)$/i;
const localHost = LOCAL_HOST.test(new URL(opt.baseUrl).hostname);
if ((!localHost || opt.storageState) && !opt.allowRealData && !opt.record) {
  process.stderr.write(`refusing to capture: ${!localHost ? `${opt.baseUrl} is not a local server` : '--storage-state is a real login'}.
Screenshots would contain whatever real data that backend returns (names, ID numbers, phone numbers) and end up
on a shared Figma board. Capture against a local stub/mock instead, or re-run with --allow-real-data once the
owner of that data agrees. (API examples are masked either way; screenshots cannot be.)
`);
  process.exit(2);
}
opt.out = opt.out || opt.bundle;

const SKILL_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const RUNTIME = path.join(SKILL_DIR, 'runtime');
function tryLoadPlaywright() {
  const bases = [opt.project, process.cwd(), RUNTIME, path.dirname(new URL(import.meta.url).pathname)].filter(Boolean);
  for (const b of bases) {
    try { return createRequire(path.join(path.resolve(b), 'package.json'))('playwright'); } catch {}
    try { return createRequire(path.join(path.resolve(b), 'package.json'))('@playwright/test'); } catch {}
  }
  return null;
}
function loadPlaywright() {
  let pw = tryLoadPlaywright();
  if (pw) return pw;
  if (!opt.installPlaywright) {
    process.stderr.write(`error: Playwright not found (not in --project's node_modules nor ${RUNTIME}).
Re-run with --install-playwright to install it into the skill once (npm package + Chromium download, ~150 MB),
or add --browser chrome with --install-playwright to skip the Chromium download and use installed Google Chrome.
`);
    process.exit(1);
  }
  fs.mkdirSync(RUNTIME, { recursive: true });
  if (!fs.existsSync(path.join(RUNTIME, 'package.json'))) fs.writeFileSync(path.join(RUNTIME, 'package.json'), '{"name":"hld-runtime","private":true}\n');
  process.stderr.write(`installing Playwright into ${RUNTIME} …\n`);
  const run = (cmd, args) => { const r = spawnSync(cmd, args, { cwd: RUNTIME, stdio: 'inherit' }); if (r.status !== 0) { process.stderr.write(`failed: ${cmd} ${args.join(' ')}\n`); process.exit(1); } };
  run('npm', ['install', '--no-audit', '--no-fund', 'playwright']);
  if (opt.browser !== 'chrome') run('npx', ['playwright', 'install', 'chromium']);
  pw = tryLoadPlaywright();
  if (!pw) { process.stderr.write('error: Playwright still not loadable after install\n'); process.exit(1); }
  return pw;
}

/** `/orders/:id` / `/products/[id]` → a concrete URL using --param values (default "1"). */
function concretePath(route) {
  return route.split('/').map(seg => {
    const m = /^:(.+)$|^\[\[?(?:\.\.\.)?([^\]]+)\]?\]$/.exec(seg);
    if (!m) return seg;
    const name = m[1] || m[2];
    return encodeURIComponent(opt.params[name] ?? '1');
  }).join('/') || '/';
}

const samePath = (a, b) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

const bundle = JSON.parse(fs.readFileSync(opt.bundle, 'utf8'));
if (bundle.schema !== 'web-hld/1') { process.stderr.write('error: not a web-hld/1 bundle\n'); process.exit(1); }
const shotDir = path.join(path.dirname(path.resolve(opt.out)), 'screenshots');
fs.mkdirSync(shotDir, { recursive: true });

const { chromium } = loadPlaywright();
let browser;
try {
  browser = await chromium.launch(opt.browser === 'chrome' ? { channel: 'chrome' } : {});
} catch (e) {
  // Playwright's own Chromium not downloaded: the installed Google Chrome is a fine substitute
  if (opt.browser !== 'chrome' && /Executable doesn't exist|browserType\.launch/.test(String(e.message))) {
    try { browser = await chromium.launch({ channel: 'chrome' }); process.stderr.write('Playwright Chromium missing — using installed Google Chrome\n'); }
    catch { process.stderr.write('error: no browser available. Run with --install-playwright, or install Google Chrome.\n'); process.exit(1); }
  } else throw e;
}
const context = await browser.newContext({
  viewport: { width: opt.viewport[0], height: opt.viewport[1] },
  deviceScaleFactor: 1,
  ...(opt.storageState ? { storageState: opt.storageState } : {}),
});
if (opt.init) await context.addInitScript({ content: fs.readFileSync(opt.init, 'utf8') });

// Every API call the app makes while we browse becomes that endpoint's example — the real request body
// and the real response, which beat stub files and type skeletons (examples.mjs fills the rest).
const matchEndpoint = makeEndpointMatcher(bundle);
const examples = bundle.apiExamples = bundle.apiExamples || {};
const pendingExamples = [];
const servedBy = new WeakMap();                           // request → 'mock' | 'replay'
context.on('response', res => pendingExamples.push((async () => {
  const req = res.request();
  if (!['xhr', 'fetch'].includes(req.resourceType()) || req.method() === 'OPTIONS') return;
  const key = matchEndpoint(req.method(), new URL(req.url()).pathname);
  if (!key) return;
  const cur = examples[key] = examples[key] || {};
  const served = servedBy.get(req);                       // 'mock' / 'replay' when we answered it ourselves
  if (opt.record) return;                                 // recording keeps its own file, not bundle examples
  if (/^captured/.test(cur.responseFrom || '')) return;
  if (served === 'mock' && cur.response !== undefined && !/^(type|fields)/.test(cur.responseFrom || '')) return;   // a stub/real example beats generated data
  let body;
  try { body = await res.json(); } catch { return; }
  let from = '';
  try { const f = req.frame(); from = f ? new URL(f.url()).pathname : ''; } catch { /* frame gone */ }
  // Personal data is masked before anything is stored — this bundle ends up on a shared board
  const [resp, maskedResp] = redact(trim(body));
  cur.response = resp;
  cur.responseFrom = served === 'mock' ? 'mock (generated from TypeScript types)' : served === 'replay' ? `replay of ${path.basename(opt.replay)} (masked)` : `captured on ${from || 'page'} (HTTP ${res.status()})`;
  cur.masked = maskedResp;
  const sent = parseJsonLoose(req.postData());
  if (sent !== undefined) {
    const [reqBody, maskedReq] = redact(trim(sent));
    cur.request = reqBody; cur.requestFrom = served ? `sent by the app on ${from || 'page'} (answered by ${served})` : `captured on ${from || 'page'}`;
    cur.masked = cur.masked || maskedReq;
  }
})().catch(() => {})));

// A local frontend can still talk to a real backend (environment.ts / .env pointing at SIT or prod). Unless
// --allow-real-data, every off-machine XHR/fetch is blocked; if one of them is the app's own API, the run
// stops before anything is captured or clicked — so --allow-submit can never write to a real backend.
let realApiHit = null;
const blockedHosts = new Set();
const appOrigin = new URL(opt.baseUrl).origin;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

// --replay: recorded responses, keyed by method + path (+ query when recorded with one)
let replayMap = null, replayHits = 0;
if (opt.replay) {
  const rec = JSON.parse(fs.readFileSync(opt.replay, 'utf8'));
  replayMap = new Map();
  for (const e of rec.entries || []) {
    for (const k of [`${e.method} ${e.path}${e.search || ''}`, `${e.method} ${e.path}`]) if (!replayMap.has(k)) replayMap.set(k, e);
  }
  process.stderr.write(`replaying ${rec.entries.length} recorded response(s) from ${opt.replay}\n`);
}
// --mock auto: fake bodies from the response types the analyzer found
let mockProject = null, wrapper = null, mockHits = 0;
if (opt.mock) {
  mockProject = new Project(opt.project);
  if (opt.mockWrapper) wrapper = JSON.parse(fs.readFileSync(opt.mockWrapper, 'utf8'));
}
const endpointInfo = new Map();
for (const s of bundle.screens) for (const a of s.apis || []) endpointInfo.set(`${a.method} ${a.path}`, a);
function wrap(tpl, data) {
  if (tpl === '$data') return data;
  if (Array.isArray(tpl)) return tpl.map(x => wrap(x, data));
  if (tpl && typeof tpl === 'object') return Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, wrap(v, data)]));
  return tpl;
}
function mockBody(key) {
  const a = key && endpointInfo.get(key);
  const data = (a && a.responseType && mockProject.fakeOf(a.responseType)) || {};
  return wrapper ? wrap(wrapper, data) : data;
}
// --record: masked copies of every API response, written at the end
const recording = [];

// One handler for every request: replay → mock → block anything off-machine. A local frontend can still talk
// to a real backend (environment.ts / .env pointing at SIT or prod); unless --allow-real-data, off-machine
// XHR/fetch is blocked, and if it was the app's own API the run stops before anything is captured or clicked.
await context.route('**/*', async route => {
  const req = route.request();
  let u;
  try { u = new URL(req.url()); } catch { return route.continue(); }
  if (!/^https?:$/.test(u.protocol) || !['xhr', 'fetch', 'eventsource', 'websocket'].includes(req.resourceType())) return route.continue();
  const key = matchEndpoint(req.method() === 'OPTIONS' ? (req.headers()['access-control-request-method'] || 'GET') : req.method(), u.pathname);
  const offMachine = !LOCAL_HOST.test(u.hostname);
  const api = key || u.origin !== appOrigin;              // same-origin non-API calls (i18n json, assets) pass through
  if (api && (replayMap || opt.mock) && req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  if (api && replayMap) {
    const hit = replayMap.get(`${req.method()} ${u.pathname}${u.search}`) || replayMap.get(`${req.method()} ${u.pathname}`);
    if (hit) { servedBy.set(req, 'replay'); replayHits++; return route.fulfill({ status: hit.status, headers: { ...CORS, 'content-type': hit.contentType || 'application/json' }, body: hit.body }); }
  }
  if (api && opt.mock) {
    servedBy.set(req, 'mock'); mockHits++;
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(mockBody(key)) });
  }
  if (offMachine && !opt.allowRealData) {
    blockedHosts.add(u.host);
    if (!realApiHit && key) realApiHit = `${req.method()} ${u.origin}${u.pathname}`;
    return route.abort('blockedbyclient');
  }
  return route.continue();
});
if (opt.record) {
  context.on('response', res => pendingExamples.push((async () => {
    const req = res.request();
    if (!['xhr', 'fetch'].includes(req.resourceType()) || req.method() === 'OPTIONS') return;
    const u = new URL(req.url());
    if (!matchEndpoint(req.method(), u.pathname) && u.origin === appOrigin) return;
    let body;
    try { body = await res.json(); } catch { return; }
    const [masked] = redact(capArrays(body));              // masked before it ever touches disk
    recording.push({ method: req.method(), path: u.pathname, search: u.search, status: res.status(), contentType: 'application/json', body: JSON.stringify(masked) });
  })().catch(() => {})));
}
function capArrays(v, depth = 0) {
  if (Array.isArray(v)) return v.slice(0, 20).map(x => capArrays(x, depth + 1));
  if (v && typeof v === 'object' && depth < 12) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capArrays(x, depth + 1)]));
  return v;
}
async function stopIfRealBackend() {
  if (!realApiHit) return;
  process.stderr.write(`\nstopped: the app sent its API calls to a real server — ${realApiHit}
Its data (and anything --allow-submit would click) is real, so nothing was captured or written.
Point the app at a local stub/mock (environment file / .env / proxy config), or re-run with --allow-real-data
once the owner of that data agrees the board may show it.
`);
  await browser.close();
  process.exit(3);
}

const inScope = s => !opt.only.length || opt.only.some(p => s.route === p || s.route.startsWith(p.replace(/\/$/, '') + '/'));
const patterns = bundle.screens.map(s => ({ s, re: new RegExp('^' + s.route.split('/').map(seg =>
  /^:|^\[/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/') + '/?$') }));
/** The screen a URL is showing, most literal match first. */
function screenAt(url) {
  const u = new URL(url);
  const p = (u.hash.startsWith('#/') ? u.hash.slice(1) : u.pathname).split('?')[0] || '/';
  const hits = patterns.filter(x => x.re.test(p));
  hits.sort((a, b) => (b.s.route.match(/[:\[]/g) ? 0 : 1) - (a.s.route.match(/[:\[]/g) ? 0 : 1));
  return hits[0] ? hits[0].s : null;
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(opt.wait);
  await stopIfRealBackend();
}

async function shoot(page, s, via) {
  if (opt.record) { s.screenshot = { recordOnly: true }; return; }   // mark as reached so the crawl moves on
  const file = path.join(shotDir, (s.route.replace(/[^\w-]+/g, '_').replace(/^_|_$/g, '') || 'root') + '.jpg');
  let buf = await page.screenshot({ type: 'jpeg', quality: 72, fullPage: opt.fullPage });
  let { width, height } = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  if (opt.fullPage) {
    height = await page.evaluate(() => document.documentElement.scrollHeight);
    const cap = opt.viewport[1] * 3;
    if (height > cap) { buf = await page.screenshot({ type: 'jpeg', quality: 72, clip: { x: 0, y: 0, width, height: cap } }); height = cap; }
  }
  fs.writeFileSync(file, buf);
  const u = new URL(page.url());
  s.screenshot = { mime: 'image/jpeg', width, height, url: u.pathname + u.hash, via, data: buf.toString('base64') };
  delete s.captureNote;
}

let ok = 0;
const recipes = new Map();            // route → { start, steps: [trigger] } that reaches it

// ── Pass 1: open each route by URL ────────────────────────────────────────
for (const s of bundle.screens) {
  delete s.screenshot; delete s.captureNote;
  if (!inScope(s)) continue;
  const want = concretePath(s.route);
  const page = await context.newPage();
  try {
    await page.goto(opt.baseUrl + want, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await settle(page);
    const at = screenAt(page.url());
    if (at !== s) {
      const u = new URL(page.url());
      s.captureNote = `redirected to ${(u.hash.startsWith('#/') ? u.hash.slice(1) : u.pathname) || 'blank'}`;
      process.stderr.write(`  skip ${s.route} → ${s.captureNote}\n`);
      continue;
    }
    await shoot(page, s, 'url');
    recipes.set(s.route, { start: want, steps: [] });
    ok++;
    process.stderr.write(`  shot ${s.route}\n`);
  } catch (e) {
    s.captureNote = `capture failed: ${String(e.message || e).split('\n')[0].slice(0, 120)}`;
    process.stderr.write(`  fail ${s.route} → ${s.captureNote}\n`);
  } finally {
    await page.close();
  }
}

// ── Pass 2: click through the flow ────────────────────────────────────────
const SUBMIT = /บันทึก|ยืนยัน|ลบ|อนุมัติ|ไม่อนุมัติ|ส่ง|ยกเลิก|ชำระ|save|submit|confirm|delete|remove|approve|reject|pay|send|cancel/i;

/** Locators to try for an action's trigger: `button "ตกลง"`, `link "ทั้งหมด"`, `app-user-list-table "…"`. */
function locatorsFor(page, trigger) {
  const m = /^(\S+)(?:\s+"(.*)")?$/.exec(trigger || '');
  if (!m) return [];
  const [, tag, label] = m;
  const out = [];
  const isComponent = tag.includes('-') && !/^(mat-|p-button|ion-button)/.test(tag);
  // A component's label is often just its tag humanised ("user list table") — not text on the page
  const humanised = label && label === tag.replace(/^[a-z]+-/, '').replace(/-/g, ' ');
  if (label && !humanised) {
    if (tag === 'link' || tag === 'a' || /Link$/.test(tag)) out.push(page.getByRole('link', { name: label }));
    out.push(page.getByRole('button', { name: label }));
    out.push(page.getByText(label, { exact: true }));
    out.push(page.getByText(label));
  }
  if (isComponent) {
    // Rows and cards first: a list component's first <button> is usually a filter or tab, not the row
    for (const inner of ['p-card', '[class*=card]', '.pointer', '[class*=item]', 'tbody tr', '[role=row]', 'li',
                         'a', '[role=button]', 'button', '[class*=row]']) {
      out.push(page.locator(`${tag} ${inner}`));
    }
    out.push(page.locator(tag));
  }
  return out;
}

/**
 * Clicks the trigger and waits for the URL to change. A candidate that clicks but goes nowhere (a filter
 * toggle, a tab) is undone with Escape and the next candidate is tried. Returns true once the page moved.
 */
const TAB_SELECTORS = '[role=tab], .nav-link, .p-tab, p-tab, [class*=tab-item], [class*=tab-button]';

/**
 * Like tryTrigger, but when the trigger is not on the visible part of the page it opens each tab in turn
 * (profile pages keep most actions behind tabs). Returns null, or the tab index that had to be opened
 * (-1 when none) so a recipe can replay it.
 */
async function clickTrigger(page, trigger, tab = undefined) {
  if (tab === undefined || tab === -1) {
    if (await tryTrigger(page, trigger)) return -1;
    if (tab === -1) return null;
  }
  const tabs = page.locator(TAB_SELECTORS);
  const count = Math.min(await tabs.count().catch(() => 0), 8);
  for (let i = 0; i < count; i++) {
    if (tab !== undefined && i !== tab) continue;
    const t = tabs.nth(i);
    try {
      if (!(await t.isVisible({ timeout: 500 }))) continue;
      const before = page.url();
      await t.click({ timeout: 2000 });
      await settle(page);
      if (page.url() !== before) { await page.goBack().catch(() => {}); await settle(page); continue; }   // a link, not a tab
      if (await tryTrigger(page, trigger)) return i;
    } catch { /* next tab */ }
  }
  return null;
}

async function tryTrigger(page, trigger) {
  const seen = new Set();
  for (const loc of locatorsFor(page, trigger)) {
    for (let i = 0; i < 2; i++) {
      const el = loc.nth(i);
      try {
        if (!(await el.isVisible({ timeout: 600 }))) break;
        const box = await el.boundingBox();
        const key = box ? `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)}` : `${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const before = page.url();
        await el.click({ timeout: 3000 });
        const moved = await page.waitForURL(u => u.toString() !== before, { timeout: 4000 }).then(() => true).catch(() => false);
        if (moved) return true;
        await page.keyboard.press('Escape').catch(() => {});
      } catch { /* try the next candidate */ }
    }
  }
  return false;
}

async function replay(page, recipe) {
  await page.goto(opt.baseUrl + recipe.start, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await settle(page);
  for (const step of recipe.steps) {
    if ((await clickTrigger(page, step.trigger, step.tab)) === null) return false;
    await settle(page);
  }
  return true;
}

if (opt.crawl) {
  let progress = true;
  const tried = new Set();
  while (progress) {
    progress = false;
    for (const src of bundle.screens) {
      const recipe = recipes.get(src.route);
      if (!recipe || recipe.steps.length >= 4) continue;
      for (const a of src.actions || []) {
        if (!a.trigger || /^on (init|load)$/.test(a.trigger)) continue;
        if (!opt.allowSubmit && SUBMIT.test(a.trigger)) continue;
        const targets = (a.goesTo || []).map(r => bundle.screens.find(x => x.route === r))
          .filter(t => t && inScope(t) && !t.screenshot);
        if (!targets.length) continue;
        const key = `${src.route}|${a.trigger}`;
        if (tried.has(key)) continue;
        tried.add(key);
        const page = await context.newPage();
        try {
          if (!(await replay(page, recipe))) continue;
          const tab = await clickTrigger(page, a.trigger);
          if (tab === null) { process.stderr.write(`  miss ${src.route} · ${a.trigger}\n`); continue; }
          await settle(page);
          const at = screenAt(page.url());
          if (at && !at.screenshot && inScope(at)) {
            await shoot(page, at, `click ${src.route} → ${a.trigger}`);
            recipes.set(at.route, { start: recipe.start, steps: [...recipe.steps, { trigger: a.trigger, tab }] });
            ok++; progress = true;
            process.stderr.write(`  shot ${at.route}  (via ${src.route} → ${a.trigger})\n`);
          }
        } catch (e) {
          process.stderr.write(`  fail ${src.route} · ${a.trigger}: ${String(e.message || e).split('\n')[0].slice(0, 100)}\n`);
        } finally {
          await page.close();
        }
      }
    }
  }
}
const skipped = bundle.screens.filter(s => inScope(s) && !s.screenshot).length;
await Promise.allSettled(pendingExamples);
await browser.close();

if (opt.record) {
  // Only the masked recording is written — the bundle and screenshots are untouched in this mode
  fs.mkdirSync(path.dirname(path.resolve(opt.record)), { recursive: true });
  fs.writeFileSync(opt.record, JSON.stringify({ recordedFrom: opt.baseUrl, at: new Date().toISOString(), masked: true, entries: recording }, null, 1));
  const reached = bundle.screens.filter(s => s.screenshot && s.screenshot.recordOnly).length;
  process.stderr.write(`recorded ${recording.length} API response(s) from ${reached} screen(s), personal data masked · wrote ${opt.record}
next: run the app against nothing real and capture with --replay ${opt.record}
`);
  process.exit(0);
}

bundle.captured = { baseUrl: opt.baseUrl, at: new Date().toISOString(), viewport: opt.viewport.join('x'),
  data: opt.replay ? `replay of ${path.basename(opt.replay)}` + (opt.mock ? ' + mock' : '') : opt.mock ? 'mock (generated from TypeScript types)' : 'live local server' };
fs.writeFileSync(opt.out, JSON.stringify(bundle));
const mb = (fs.statSync(opt.out).size / 1e6).toFixed(1);
const nEx = Object.values(examples).filter(e => /^captured/.test(e.responseFrom || '')).length;
if (blockedHosts.size) process.stderr.write(`blocked off-machine requests (not the app's API) to: ${[...blockedHosts].join(', ')}\n`);
process.stderr.write(`${nEx} API example(s) captured from live traffic\n`);
if (opt.replay || opt.mock) process.stderr.write(`API calls answered locally: ${replayHits} from the recording, ${mockHits} mocked\n`);
process.stderr.write(`${ok} screenshot(s), ${skipped} skipped · wrote ${opt.out} (${mb} MB) · images in ${shotDir}\n`);
