#!/usr/bin/env node
// web-hld — static analyzer for Next.js / Angular front ends.
// Finds every routed screen, what each action navigates to, and every API call behind it, then
// writes a bundle the web-hld Figma plugin draws as a board. No dependencies; Node 18+.
//
//   node webhld.mjs <projectDir> [-o out.json] [--lang th] [--only /route-prefix ...] [--framework nextjs|angular] [--group auto|segment|none]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { read, extractFunctions, extractClasses, rel } from './lib/source.mjs';
import { Project } from './lib/project.mjs';
import { ApiGraph, httpCalls, navigations, storageUses, dedupeEndpoints } from './lib/effects.mjs';
import { jsxOutline, templateOutline, makeTextResolver } from './lib/ui.mjs';
import { redact } from './lib/sample.mjs';
import {
  detectFramework, nextScreens, angularScreens, componentInfo, buildSelectorIndex,
  localChildComponents, makeRouteMatcher, normRoute, joinRoute,
} from './lib/routes.mjs';

function usage() {
  process.stderr.write(`web-hld — HLD bundle generator for Next.js / Angular

Usage:
  node webhld.mjs <projectDir> [-o out.json] [--lang th|en] [--only /prefix ...] [--framework nextjs|angular]

  <projectDir>   folder holding package.json (monorepo: the app's folder)
  -o             output file (default: ~/Desktop/web-hld/<project>/bundle.json)
  --lang         preferred translation file for labels (default: th, falls back to en)
  --only         keep only screens whose route starts with this prefix (repeatable)
  --fresh        discard screenshots/descriptions/API examples kept from an existing bundle at -o
  --group        journeys: segment (first route segment / Next route group), none (one board),
                 auto (default: none for 12 screens or fewer, else segment)
`);
  process.exit(1);
}

const argv = process.argv.slice(2);
let projectDir = null, out = null, lang = 'th', framework = null, grouping = 'auto', fresh = false;
const only = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-o' || a === '--output') out = argv[++i];
  else if (a === '--lang') lang = argv[++i];
  else if (a === '--only') only.push(normRoute(argv[++i]));
  else if (a === '--framework') framework = argv[++i];
  else if (a === '--group') grouping = argv[++i];
  else if (a === '--fresh') fresh = true;
  else if (a === '-h' || a === '--help') usage();
  else if (!a.startsWith('-') && !projectDir) projectDir = a;
  else { process.stderr.write(`unknown argument: ${a}\n`); usage(); }
}
if (!projectDir) usage();
if (!fs.existsSync(path.join(projectDir, 'package.json'))) {
  process.stderr.write(`error: no package.json in ${projectDir} — pass the app's own folder\n`); process.exit(1);
}

const t0 = Date.now();
const project = new Project(projectDir);
framework = framework || detectFramework(project);
if (!framework) { process.stderr.write('error: neither next nor @angular/core found in package.json (use --framework)\n'); process.exit(1); }
const projectName = project.pkg.name && project.pkg.name !== 'app' ? project.pkg.name : path.basename(project.root);
// One folder per project that Figma's file picker can reach: bundle, descriptions, screenshots, login seed
const homeBase = fs.existsSync(path.join(os.homedir(), 'Desktop')) ? path.join(os.homedir(), 'Desktop') : os.homedir();
out = out || path.join(homeBase, 'web-hld', projectName.replace(/[^\w.-]/g, '_'), 'bundle.json');

const graph = new ApiGraph(project);
const locales = project.loadLocales(lang);
const resolveText = makeTextResolver(locales);

let screens, redirects = [];
if (framework === 'angular') ({ screens, redirects } = angularScreens(project));
else screens = nextScreens(project);

// The same component can be routed twice (`''` and `list`); keep one screen per route.
const byRoute = new Map();
for (const s of screens) if (!byRoute.has(s.route)) byRoute.set(s.route, s);
screens = [...byRoute.values()];
const matchRoute = makeRouteMatcher(screens, redirects);
const selectorIndex = framework === 'angular' ? buildSelectorIndex(project) : null;

const warnings = [];
const results = [];

for (const screen of screens) {
  if (only.length && !only.some(p => screen.route === p || screen.route.startsWith(p + '/') || p === '/')) continue;
  results.push(analyzeScreen(screen));
}

function analyzeScreen(screen) {
  // ── Collect the screen's code units ───────────────────────────────────────
  const units = [];              // { fn, cls, file }
  const templates = [];          // angular templates (screen + local children)
  const jsxSources = [];
  const classFiles = [];
  if (screen.kind === 'angular') {
    const comps = [screen.comp, ...localChildComponents(project, screen, selectorIndex)];
    for (const comp of comps) {
      const info = componentInfo(comp);
      if (!info.cls) continue;
      for (const m of info.cls.methods) units.push({ fn: m, cls: info.cls, file: comp.file });
      if (info.template) templates.push(info.template);
      classFiles.push(comp.file);
    }
  } else {
    for (const f of screen.files) {
      const src = read(f);
      const classes = extractClasses(src);
      for (const fn of extractFunctions(src)) units.push({ fn, cls: fn.cls ? classes.find(c => c.name === fn.cls) : null, file: f });
      if (/\.(tsx|jsx|js)$/.test(f)) jsxSources.push(src);
    }
  }

  // ── UI outline and event bindings ─────────────────────────────────────────
  const outline = { elements: [], bindings: [] };
  for (const t of templates) { const o = templateOutline(t, resolveText); outline.elements.push(...o.elements); outline.bindings.push(...o.bindings); }
  for (const s of jsxSources) { const o = jsxOutline(s, resolveText); outline.elements.push(...o.elements); outline.bindings.push(...o.bindings); }
  outline.elements = outline.elements.slice(0, 18);

  const localNames = new Map();
  for (const u of units) if (!localNames.has(u.fn.name)) localNames.set(u.fn.name, u);

  // ── Effects of one unit, following calls into other local units ───────────
  const effectMemo = new Map();
  const effectsOf = (u, depth = 0, stack = new Set()) => {
    const key = `${u.file}#${u.fn.cls || ''}.${u.fn.name}@${u.fn.start}`;
    if (effectMemo.has(key)) return effectMemo.get(key);
    if (stack.has(key) || depth > 4) return { navs: [], apis: [], storage: [] };
    stack.add(key);
    const navs = navigations(u.fn, u.cls, project);
    const apis = [...httpCalls(u.fn, u.cls, project)];
    for (const mc of mutationCalls || []) if (mc.re.test(u.fn.body)) apis.push(...mc.apis);
    const storage = storageUses(u.fn.body, project);
    const imports = project.imports(u.file);
    for (const ref of graph.refsOf(u.fn.body, u.cls, u.fn)) {
      const bare = ref.includes('.') ? ref.split('.').pop() : ref;
      const local = ref.includes('.') && u.cls && ref.startsWith(u.cls.name + '.') ? localNames.get(bare)
        : !ref.includes('.') ? localNames.get(ref) : null;
      if (local && local !== u) {
        const e = effectsOf(local, depth + 1, stack);
        navs.push(...e.navs); apis.push(...e.apis); storage.push(...e.storage);
        continue;
      }
      if (local === u) continue;
      apis.push(...endpointsFor(ref, imports));
    }
    stack.delete(key);
    const r = { navs, apis: dedupeEndpoints(apis), storage: [...new Set(storage)] };
    if (depth === 0) effectMemo.set(key, r);
    return r;
  };

  // A bare imported name reaches only the file it was imported from; everything else is global.
  function endpointsFor(ref, imports) {
    if (!ref.includes('.') && imports.has(ref) && imports.get(ref).file) {
      const file = imports.get(ref).file;
      const name = imports.get(ref).imported === 'default' ? ref : imports.get(ref).imported;
      const defs = (graph.defs.get(name) || []).filter(d => d.file === file);
      if (defs.length) return defs.flatMap(d => [...d.direct, ...d.refs.filter(r => r !== name).flatMap(r => graph.endpoints(r))]);
    }
    return graph.endpoints(ref);
  }

  // ── Mutation hooks: `const add = useAddToCart()` / `const { mutate: save } = useSave()` ──
  // Their endpoints fire when an action calls add.mutate()/save(), so they belong to that action.
  const mutationCalls = [];            // { re, apis }
  const isMutationHook = name => /Mutation$/.test(name) || (graph.defs.get(name) || []).some(d => d.mutation);
  if (screen.kind === 'jsx') {
    for (const u of units) {
      for (const m of u.fn.body.matchAll(/\b(?:const|let)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*(use[A-Z][\w$]*)\s*\(/g)) {
        if (!isMutationHook(m[2])) continue;
        const apis = endpointsFor(m[2], project.imports(u.file));
        if (m[1].startsWith('{')) {
          for (const part of m[1].slice(1, -1).split(',')) {
            const [orig, alias] = part.split(':').map(s => s.trim());
            if (/^mutate(Async)?$/.test(orig)) mutationCalls.push({ re: new RegExp(`(?<![.\\w$])${alias || orig}\\s*\\(`), apis });
          }
        } else mutationCalls.push({ re: new RegExp(`\\b${m[1]}\\.mutate(Async)?\\s*\\(`), apis });
      }
    }
  }
  const mutationHooks = new Set();
  for (const u of units) for (const m of u.fn.body.matchAll(/=\s*(use[A-Z][\w$]*)\s*\(/g)) if (isMutationHook(m[1])) mutationHooks.add(m[1]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const actions = [];
  const boundHandlers = new Map();      // handler name → trigger label
  for (const b of outline.bindings) {
    if (b.handler && !boundHandlers.has(b.handler)) boundHandlers.set(b.handler, triggerLabel(b));
  }
  const calledLocally = new Set();
  for (const u of units) for (const r of graph.refsOf(u.fn.body, u.cls, u.fn)) {
    const bare = r.includes('.') ? r.split('.').pop() : r;
    if (localNames.has(bare) && localNames.get(bare) !== u) calledLocally.add(bare);
  }
  const LIFECYCLE = /^(ngOnInit|ngAfterViewInit|ngOnChanges|constructor|ionViewWillEnter|ionViewDidEnter|componentDidMount)$/;
  const isComponentFn = u => /^[A-Z]/.test(u.fn.name) && !u.cls;
  const isHookFn = u => /^use[A-Z]/.test(u.fn.name) && !u.cls;

  for (const u of units) {
    if (isComponentFn(u) || isHookFn(u)) continue;
    const bound = boundHandlers.has(u.fn.name);
    const lifecycle = LIFECYCLE.test(u.fn.name);
    if (!bound && !lifecycle && calledLocally.has(u.fn.name)) continue;
    const e = effectsOf(u);
    if (!e.navs.length && !e.apis.length && !bound) continue;
    actions.push({
      name: lifecycle ? 'on init' : u.fn.name,
      trigger: bound ? boundHandlers.get(u.fn.name) : lifecycle ? 'on init' : null,
      ...e,
    });
  }

  // JSX: data hooks called in a component body and useEffect callbacks run on load
  if (screen.kind === 'jsx') {
    const load = { navs: [], apis: [], storage: [] };
    for (const u of units) {
      if (!isComponentFn(u) && !isHookFn(u)) continue;
      const body = u.fn.body;
      const imports = project.imports(u.file);
      for (const m of body.matchAll(/\b(use[A-Z][\w$]*)\s*\(/g)) {
        if (/^use(State|Ref|Memo|Callback|Context|Reducer|Id|Transition|DeferredValue|Router|Pathname|SearchParams|Params|Translation|Form|Effect|LayoutEffect|ImperativeHandle|SyncExternalStore|Selector|Dispatch|Store|Show\w*)$/.test(m[1])) continue;
        if (mutationHooks.has(m[1])) continue;                  // fires from an action, not on load
        const local = localNames.get(m[1]);
        if (local && isHookFn(local)) { const e = effectsOf(local); load.apis.push(...e.apis); continue; }
        load.apis.push(...endpointsFor(m[1], imports));
      }
      for (const m of body.matchAll(/\buse(?:Layout)?Effect\s*\(\s*(?:async\s*)?\(\s*\)\s*=>\s*\{/g)) {
        const open = m.index + m[0].length - 1;
        const close = matchBody(body, open);
        const fn = { name: 'useEffect', cls: null, params: '', body: body.slice(open + 1, close), start: u.fn.start + open };
        const e = effectsOf({ fn, cls: null, file: u.file });
        load.navs.push(...e.navs); load.apis.push(...e.apis); load.storage.push(...e.storage);
      }
    }
    if (load.navs.length || load.apis.length) actions.unshift({ name: 'on load', trigger: 'on load', navs: load.navs, apis: dedupeEndpoints(load.apis), storage: load.storage });
  }

  // Inline handlers: onClick={() => router.push('/x')} / (click)="router.navigate(['/x'])" / routerLink / href
  for (const b of outline.bindings) {
    if (b.handler && localNames.has(b.handler)) continue;
    // `onClick={closeWebView}` — an imported function bound directly reads as calling it
    const code = b.handler ? `${b.handler}()` : b.inline || '';
    const hrefExpr = b.href;
    const fn = { name: 'inline', cls: null, params: '', body: hrefExpr ? `navigateTo(${hrefExpr})` : code, start: 0 };
    const cls = screen.kind === 'angular' ? componentInfo(screen.comp).cls : null;
    const navs = navigations(fn, cls, project);
    let apis = [];
    for (const ref of graph.refsOf(fn.body, cls, fn)) {
      const local = localNames.get(ref.includes('.') ? ref.split('.').pop() : ref);
      if (local) { const e = effectsOf(local); navs.push(...e.navs); apis.push(...e.apis); }
      else apis.push(...graph.endpoints(ref));
    }
    if (!navs.length && !apis.length) continue;
    actions.push({ name: triggerLabel(b), trigger: triggerLabel(b), navs, apis: dedupeEndpoints(apis), storage: [] });
  }

  // ── Aggregate ─────────────────────────────────────────────────────────────
  const goesTo = new Map();
  const actionOut = [];
  for (const a of actions) {
    const label = a.trigger && a.trigger !== a.name ? `${a.name} · ${a.trigger}` : a.name;
    const targets = [];
    for (const n of a.navs) {
      let key, row;
      if (n.kind === 'route') {
        // `navigate(['edit-profile'], { relativeTo })` — no leading slash: try root, then beside this screen
        const hit = matchRoute(n.route) || (!n.route.startsWith('/') &&
          (matchRoute(joinRoute(screen.route, n.route)) || matchRoute(joinRoute(screen.route.replace(/\/[^/]*$/, ''), n.route))));
        key = hit ? `route:${hit.route}` : `raw:${n.route}`;
        row = { kind: 'route', target: hit ? hit.route : null, raw: n.route };
      } else if (n.kind === 'external') { key = `ext:${n.url}`; row = { kind: 'external', target: null, raw: n.url }; }
      else { key = n.kind; row = { kind: n.kind, target: null, raw: n.raw }; }
      if (row.target === screen.route) continue;                 // self-navigation (refresh / tab switch)
      if (!goesTo.has(key)) goesTo.set(key, { ...row, via: [] });
      const g = goesTo.get(key);
      if (!g.via.includes(a.name)) g.via.push(a.name);
      targets.push(row.target || row.raw);
    }
    actionOut.push({ name: a.name, trigger: a.trigger, label, goesTo: [...new Set(targets)],
      apis: a.apis.map(e => `${e.method} ${e.path}`) });
  }
  const apis = dedupeEndpoints(actions.flatMap(a => a.apis)).map(e => ({
    method: e.method, path: e.path, base: e.base || '',
    requestType: e.requestType || '', responseType: e.responseType || '',
    requestFields: e.requestFields || [], responseFields: project.typeFields(e.responseType),
    via: e.via,
  }));
  const storage = [...new Set(actions.flatMap(a => a.storage))];

  const heading = outline.elements.find(e => e.kind === 'heading' && e.label);
  const title = resolveText(screen.title) || (heading ? heading.label : '');
  if (!outline.elements.length) warnings.push(`${screen.route}: no UI elements found (${rel(project.root, screen.primary)})`);

  return {
    id: screen.route, route: screen.route, journey: screen.journey, name: screen.name, title,
    files: [...new Set([...screen.files, ...classFiles])].map(f => rel(project.root, f)),
    elements: outline.elements.map(({ kind, label }) => ({ kind, label })),
    actions: actionOut.filter(a => a.goesTo.length || a.apis.length),
    goesTo: [...goesTo.values()],
    apis, storage,
  };
}

function triggerLabel(b) {
  if (b.event === 'href' || b.event === 'routerLink') return b.label ? `link "${b.label}"` : 'link';
  return b.label && b.label !== b.tag ? `${b.tag} "${b.label}"` : b.tag;
}

function matchBody(src, open) {
  let d = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return k; }
  }
  return src.length;
}

// Arrows are only drawn inside a journey, so a small app split one-screen-per-journey shows no flow.
if (grouping === 'none' || (grouping === 'auto' && results.length <= 12)) for (const s of results) s.journey = projectName;

// ── Write ───────────────────────────────────────────────────────────────────
for (const s of results) for (const g of s.goesTo) {
  if (g.kind === 'route' && !g.target) warnings.push(`${s.route}: navigation to "${g.raw}" matches no screen`);
}
const bundle = {
  schema: 'web-hld/1',
  project: projectName,
  framework,
  generatedAt: new Date().toISOString(),
  screens: results.sort((a, b) => a.journey.localeCompare(b.journey) || a.route.localeCompare(b.route)),
  warnings,
};
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
// Re-running the analysis must not throw away what later steps added. Screenshots, capture notes and API
// examples carry over for routes/endpoints that still exist; descriptions come from descriptions.json beside
// the bundle (the source of truth), else from the old bundle.
let kept = '';
if (!fresh && fs.existsSync(out)) {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* unreadable: start clean */ }
  if (prev && prev.schema === 'web-hld/1') {
    const old = new Map((prev.screens || []).map(s => [s.route, s]));
    let shots = 0;
    for (const s of bundle.screens) {
      const o = old.get(s.route);
      if (!o) continue;
      if (o.screenshot) { s.screenshot = o.screenshot; shots++; }
      if (o.captureNote) s.captureNote = o.captureNote;
      if (o.description) s.description = o.description;
    }
    const live = new Set(bundle.screens.flatMap(s => (s.apis || []).map(a => `${a.method} ${a.path}`)));
    const ex = Object.fromEntries(Object.entries(prev.apiExamples || {}).filter(([k]) => live.has(k)));
    // A bundle from before masking existed (or restored from an old copy) must not carry raw data forward
    for (const cur of Object.values(ex)) for (const k of ['request', 'response']) {
      if (cur[k] === undefined || /^(type|fields)/.test(cur[`${k}From`] || '')) continue;
      const [r, m] = redact(cur[k]); cur[k] = r; cur.masked = cur.masked || m;
    }
    if (Object.keys(ex).length) bundle.apiExamples = ex;
    if (prev.journeys) bundle.journeys = prev.journeys.filter(j => bundle.screens.some(s => s.journey === j.name));
    for (const k of ['captured', 'e2eShots']) if (prev[k]) bundle[k] = prev[k];
    kept = `kept from previous bundle: ${shots} screenshot(s), ${Object.keys(ex).length} API example(s) (--fresh to discard)`;
  }
}
const descFile = path.join(path.dirname(path.resolve(out)), 'descriptions.json');
if (fs.existsSync(descFile)) {
  try {
    const d = JSON.parse(fs.readFileSync(descFile, 'utf8'));
    for (const s of bundle.screens) if (d.screens && typeof d.screens[s.route] === 'string') s.description = d.screens[s.route];
    const names = [...new Set(bundle.screens.map(s => s.journey))];
    bundle.journeys = names.map(name => (d.journeys && d.journeys[name]) ? { name, description: d.journeys[name] } : { name });
    kept += `${kept ? ' · ' : ''}descriptions applied from ${path.basename(descFile)}`;
  } catch { process.stderr.write(`warning: could not read ${descFile}\n`); }
}

fs.writeFileSync(out, JSON.stringify(bundle, null, 2));

const nApis = new Set(results.flatMap(s => s.apis.map(a => `${a.method} ${a.path}`))).size;
const nLinks = results.reduce((n, s) => n + s.goesTo.filter(g => g.target).length, 0);
const journeys = new Set(results.map(s => s.journey)).size;
process.stderr.write(`framework: ${framework}  project: ${projectName}\n`);
process.stderr.write(`${results.length} screen(s) in ${journeys} journey(s) · ${nLinks} screen→screen link(s) · ${nApis} unique endpoint(s)\n`);
if (warnings.length) process.stderr.write(`${warnings.length} warning(s) — see "warnings" in the bundle\n`);
if (kept) process.stderr.write(kept + '\n');

// Keep a copy of the Figma plugin next to the bundles, where Figma's file picker can reach it (~/.claude is
// hidden). Refreshed on every run so an import done once always loads the current plugin.
{
  const src = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'figma-plugin');
  const dest = path.join(homeBase, 'web-hld', 'figma-plugin');
  try {
    fs.mkdirSync(dest, { recursive: true });
    let updated = 0;
    for (const f of fs.readdirSync(src)) {
      const a = path.join(src, f), b = path.join(dest, f);
      const buf = fs.readFileSync(a);
      if (!fs.existsSync(b) || !buf.equals(fs.readFileSync(b))) { fs.writeFileSync(b, buf); updated++; }
    }
    if (updated) process.stderr.write(`Figma plugin updated: ${path.join(dest, 'manifest.json')}\n`);
  } catch (e) { process.stderr.write(`warning: could not copy the Figma plugin to ${dest}: ${e.message}\n`); }
}
process.stderr.write(`wrote ${out}  (${Date.now() - t0} ms)\n`);
