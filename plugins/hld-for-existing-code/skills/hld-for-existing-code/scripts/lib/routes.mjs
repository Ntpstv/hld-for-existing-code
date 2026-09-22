// Screen discovery. One screen = one route that renders a page component.
//   Next.js App Router  — every app/**/page.(tsx|ts|jsx|js)
//   Next.js Pages Router — every pages/** file except _app/_document/_error/api
//   Angular — Routes arrays (forRoot/forChild/provideRouter), following loadChildren/loadComponent
import fs from 'node:fs';
import path from 'node:path';
import { read, readRaw, matchClose, splitTopLevel, extractClasses, isTestFile } from './source.mjs';

export function detectFramework(project) {
  const d = project.deps;
  if (d['@angular/core'] || fs.existsSync(path.join(project.root, 'angular.json'))) return 'angular';
  if (d.next) return 'nextjs';
  return null;
}

// ─── Next.js ────────────────────────────────────────────────────────────────

export function nextScreens(project) {
  const screens = [];
  const roots = ['src/app', 'app'].map(d => path.join(project.root, d)).filter(d => fs.existsSync(d));
  for (const appDir of roots) {
    for (const f of project.files) {
      if (!f.startsWith(appDir + path.sep) || !/[\\/]page\.(tsx|ts|jsx|js)$/.test(f)) continue;
      const segs = path.relative(appDir, path.dirname(f)).split(path.sep).filter(Boolean);
      if (segs.some(s => s.startsWith('_') || s.startsWith('@') || /^\(\.{1,3}\)/.test(s))) continue;   // private, parallel, intercepting
      const groups = segs.filter(s => /^\(.+\)$/.test(s)).map(s => s.slice(1, -1));
      const routeSegs = segs.filter(s => !/^\(.+\)$/.test(s));
      screens.push(nextScreen(project, f, '/' + routeSegs.join('/'), groups[0], appDir));
    }
  }
  const pagesRoots = ['src/pages', 'pages'].map(d => path.join(project.root, d)).filter(d => fs.existsSync(d));
  for (const pagesDir of pagesRoots) {
    for (const f of project.files) {
      if (!f.startsWith(pagesDir + path.sep) || !/\.(tsx|jsx|ts|js)$/.test(f)) continue;
      const relp = path.relative(pagesDir, f).replace(/\.(tsx|jsx|ts|js)$/, '');
      const segs = relp.split(path.sep);
      if (segs[0] === 'api' || /^_(app|document|error)$/.test(segs[segs.length - 1]) || /^(404|500)$/.test(segs[segs.length - 1])) continue;
      if (segs[segs.length - 1] === 'index') segs.pop();
      screens.push(nextScreen(project, f, '/' + segs.join('/'), null, pagesDir));
    }
  }
  return screens;
}

function nextScreen(project, pageFile, route, group, appDir) {
  const files = [pageFile];
  // Thin wrapper: `import X from "@/screens/x"; export default X;` or `export { default } from ...`
  const imports = project.imports(pageFile);
  const src = read(pageFile);
  const def = /export\s+default\s+(?:[\w$]+\s*\(\s*)?([A-Za-z_$][\w$]*)/.exec(src);
  let primary = pageFile;
  const target = (def && imports.get(def[1])) || imports.get('default');
  if (target && target.file && !target.file.startsWith(path.dirname(pageFile) + path.sep + 'node_modules')) {
    files.push(target.file); primary = target.file;
  }
  // Pull in the screen's own local modules (components/hooks next to it), two hops deep
  const home = path.dirname(primary);
  const inScope = f => f && f.startsWith(home + path.sep) && !isTestFile(f) && (home !== appDir || path.dirname(f) === home);
  const queue = [primary];
  for (let hop = 0; hop < 2; hop++) {
    for (const f of queue.splice(0)) {
      for (const imp of project.imports(f).values()) {
        if (inScope(imp.file) && !files.includes(imp.file) && files.length < 20) { files.push(imp.file); queue.push(imp.file); }
      }
    }
  }
  const layoutTitle = /export\s+const\s+metadata[^=]*=\s*\{[\s\S]*?title\s*:\s*['"`]([^'"`]+)/.exec(src);
  const dynamicTitle = /title\s*:\s*['"`]([^'"`]+)['"`]/.exec(/generateMetadata[\s\S]{0,400}/.exec(src)?.[0] || '');
  const compName = componentName(read(primary)) || pascal(route);
  return {
    route: normRoute(route), journey: group || firstSeg(route), name: compName,
    files, primary, kind: 'jsx', title: (layoutTitle || dynamicTitle)?.[1] || '',
  };
}

function componentName(src) {
  const m = /export\s+default\s+(?:function\s+)?(?:[\w$]+\s*\(\s*)?([A-Z][\w$]*)/.exec(src)
    || /(?:const|function)\s+([A-Z][\w$]*(?:Screen|Page|View|Container))\b/.exec(src);
  return m ? m[1] : '';
}

// ─── Angular ────────────────────────────────────────────────────────────────

export function angularScreens(project) {
  const screens = [];
  const redirects = [];
  const visitedArrays = new Set();

  const rootSources = [];
  for (const f of project.files) {
    const src = read(f);
    for (const m of src.matchAll(/\b(?:RouterModule\.forRoot|provideRouter)\s*\(\s*/g)) {
      const k = m.index + m[0].length;
      rootSources.push({ file: f, expr: src.slice(k, k + 200) });
    }
  }
  for (const { file, expr } of rootSources) {
    const arr = routesArrayFrom(project, file, expr);
    if (arr) walkRoutes(project, arr.file, arr.body, '', screens, redirects, visitedArrays, null);
  }
  // No root found (library / partial checkout): take every Routes array on its own
  if (!rootSources.length) {
    for (const f of project.files) {
      const src = read(f);
      for (const m of src.matchAll(/:\s*Routes\s*=\s*\[/g)) {
        const open = m.index + m[0].length - 1;
        const close = matchClose(src, open);
        if (close > 0) walkRoutes(project, f, src.slice(open + 1, close), '', screens, redirects, visitedArrays, null);
      }
    }
  }
  return { screens, redirects };
}

/** `routes` identifier, inline `[...]`, or an imported constant → { file, body } */
function routesArrayFrom(project, file, expr) {
  const src = read(file);
  expr = expr.trim();
  if (expr.startsWith('[')) {
    const abs = src.indexOf(expr.slice(0, 60));
    const close = matchClose(src, abs);
    return close > 0 ? { file, body: src.slice(abs + 1, close) } : null;
  }
  const id = /^([A-Za-z_$][\w$]*)/.exec(expr);
  if (!id) return null;
  return findRoutesConst(project, file, id[1]);
}

function findRoutesConst(project, file, name, depth = 0) {
  if (!file || depth > 3) return null;
  const src = read(file);
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*\\[`).exec(src);
  if (decl) {
    const open = decl.index + decl[0].length - 1;
    const close = matchClose(src, open);
    return close > 0 ? { file, body: src.slice(open + 1, close) } : null;
  }
  const imp = project.imports(file).get(name);
  if (imp && imp.file) return findRoutesConst(project, imp.file, imp.imported === 'default' ? defaultExportName(imp.file) || name : imp.imported, depth + 1);
  return null;
}

function defaultExportName(file) {
  const m = /export\s+default\s+([A-Za-z_$][\w$]*)/.exec(read(file));
  return m ? m[1] : null;
}

function prop(obj, key) {
  for (const p of splitTopLevel(obj)) {
    const m = new RegExp(`^['"]?${key}['"]?\\s*:\\s*([\\s\\S]*)$`).exec(p);
    if (m) return m[1].trim();
  }
  return null;
}

function strVal(v) { const m = /^(['"`])([\s\S]*)\1$/.exec((v || '').trim()); return m ? m[2] : null; }

function walkRoutes(project, file, body, prefix, screens, redirects, visited, inheritedTitle) {
  const key = `${file}::${prefix}::${body.length}`;
  if (visited.has(key)) return;
  visited.add(key);
  for (const item of splitTopLevel(body)) {
    let obj = item;
    if (!obj.startsWith('{')) {                                  // spread of another routes const
      const spread = /^\.\.\.([A-Za-z_$][\w$]*)$/.exec(obj);
      if (spread) { const r = findRoutesConst(project, file, spread[1]); if (r) walkRoutes(project, r.file, r.body, prefix, screens, redirects, visited, inheritedTitle); }
      continue;
    }
    obj = obj.slice(1, matchClose(obj, 0));
    const p = strVal(prop(obj, 'path')) ?? '';
    const full = joinRoute(prefix, p);
    const redirectTo = strVal(prop(obj, 'redirectTo'));
    if (redirectTo !== null) { redirects.push({ from: full, to: redirectTo.startsWith('/') ? redirectTo : joinRoute(prefix, redirectTo) }); continue; }
    const titleRaw = prop(obj, 'title');
    const dataRaw = prop(obj, 'data');
    const title = strVal(titleRaw) || (dataRaw && strVal(prop(dataRaw.replace(/^\{|\}$/g, ''), 'title'))) || (dataRaw && strVal(prop(dataRaw.replace(/^\{|\}$/g, ''), 'breadcrumb'))) || '';

    const children = prop(obj, 'children');
    const compId = prop(obj, 'component');
    const loadComp = prop(obj, 'loadComponent');
    const loadChildren = prop(obj, 'loadChildren');

    let comp = null;
    if (compId && /^[A-Za-z_$][\w$]*$/.test(compId)) comp = resolveClass(project, file, compId);
    if (loadComp) comp = lazyTarget(project, file, loadComp, true);

    const hasChildren = !!(children || loadChildren);
    if (comp && !(hasChildren && isShell(comp))) {
      screens.push(angularScreen(project, comp, full, title || inheritedTitle || ''));
    }
    if (children && children.startsWith('[')) {
      walkRoutes(project, file, children.slice(1, matchClose(children, 0)), full, screens, redirects, visited, null);
    } else if (children) {
      const r = findRoutesConst(project, file, children.trim());
      if (r) walkRoutes(project, r.file, r.body, full, screens, redirects, visited, null);
    }
    if (loadChildren) {
      const target = lazyTarget(project, file, loadChildren, false);
      if (target) {
        for (const r of childRoutesOf(project, target)) walkRoutes(project, r.file, r.body, full, screens, redirects, visited, title || null);
      }
    }
  }
}

/** `() => import('./x').then(m => m.Y)` → { file, name } */
function lazyTarget(project, file, expr, isComponent) {
  const imp = /import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/.exec(expr);
  if (!imp) {
    const id = /^([A-Za-z_$][\w$]*)$/.exec(expr.trim());   // loadChildren: SomeModule (old eager style)
    return id ? resolveClass(project, file, id[1]) : null;
  }
  const target = project.resolveImport(file, imp[1]);
  if (!target) return null;
  const name = /\.then\s*\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\1\.([A-Za-z_$][\w$]*)/.exec(expr)?.[2] || 'default';
  if (isComponent) return { file: target, name: name === 'default' ? defaultExportName(target) : name };
  return { file: target, name };
}

function resolveClass(project, file, name) {
  const src = read(file);
  if (new RegExp(`\\bclass\\s+${name}\\b`).test(src)) return { file, name };
  const imp = project.imports(file).get(name);
  if (imp && imp.file) return { file: imp.file, name: imp.imported === 'default' ? name : imp.imported };
  return null;
}

/** Routes contributed by a lazily loaded module or routes file. */
function childRoutesOf(project, target) {
  const out = [];
  const src = read(target.file);
  const direct = target.name && target.name !== 'default' ? findRoutesConst(project, target.file, target.name) : null;
  if (direct) return [direct];
  // NgModule: forChild(routes) in the module file or in any module it imports (XRoutingModule)
  const candidates = [target.file];
  for (const imp of project.imports(target.file).values()) if (imp.file && /routing|routes/i.test(imp.file)) candidates.push(imp.file);
  for (const f of candidates) {
    const s = read(f);
    for (const m of s.matchAll(/RouterModule\.forChild\s*\(\s*/g)) {
      const r = routesArrayFrom(project, f, s.slice(m.index + m[0].length, m.index + m[0].length + 200));
      if (r) out.push(r);
    }
  }
  if (!out.length) {
    const def = /export\s+default\s+\[/.exec(src);
    if (def) { const open = def.index + def[0].length - 1; out.push({ file: target.file, body: src.slice(open + 1, matchClose(src, open)) }); }
  }
  return out;
}

function isShell(comp) {
  const info = componentInfo(comp);
  return /<router-outlet/.test(info.template);
}

const compCache = new Map();
export function componentInfo(comp) {
  const key = `${comp.file}#${comp.name}`;
  if (compCache.has(key)) return compCache.get(key);
  const src = read(comp.file);
  const cls = extractClasses(src).find(c => c.name === comp.name);
  const dec = cls && cls.decorators.find(d => d.name === 'Component');
  let template = '', templateFile = null, selector = '';
  if (dec) {
    const turl = /templateUrl\s*:\s*['"`]([^'"`]+)['"`]/.exec(dec.args);
    if (turl) { templateFile = path.resolve(path.dirname(comp.file), turl[1]); template = readRaw(templateFile); }
    const inline = /template\s*:\s*`([\s\S]*?)`/.exec(dec.args);
    if (inline) template = inline[1];
    selector = /selector\s*:\s*['"`]([^'"`]+)['"`]/.exec(dec.args)?.[1] || '';
  }
  const info = { cls, template, templateFile, selector };
  compCache.set(key, info);
  return info;
}

function angularScreen(project, comp, route, title) {
  const info = componentInfo(comp);
  const files = [comp.file];
  if (info.templateFile) files.push(info.templateFile);
  return {
    route: normRoute(route), journey: firstSeg(route), name: comp.name,
    files, primary: comp.file, kind: 'angular', title, comp,
  };
}

/** Child components used in a template that live beside the screen (same folder tree). */
export function localChildComponents(project, screen, selectorIndex) {
  const home = path.dirname(screen.primary);
  const out = [];
  const info = componentInfo(screen.comp);
  for (const [sel, comp] of selectorIndex) {
    if (!comp.file.startsWith(home + path.sep) || comp.file === screen.primary) continue;
    if (new RegExp(`<${sel.replace(/[-]/g, '\\-')}[\\s>/]`).test(info.template)) out.push(comp);
  }
  return out;
}

export function buildSelectorIndex(project) {
  const idx = new Map();
  for (const f of project.files) {
    if (!/\.component\.ts$/.test(f) && !/@Component\s*\(/.test(read(f))) continue;
    for (const c of extractClasses(read(f))) {
      const dec = c.decorators.find(d => d.name === 'Component');
      const sel = dec && /selector\s*:\s*['"`]([\w-]+)['"`]/.exec(dec.args)?.[1];
      if (sel && !idx.has(sel)) idx.set(sel, { file: f, name: c.name });
    }
  }
  return idx;
}

// ─── Route helpers ──────────────────────────────────────────────────────────

export function joinRoute(prefix, p) {
  return ('/' + [prefix, p].filter(Boolean).join('/')).replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
}

export function normRoute(r) {
  r = ('/' + (r || '')).replace(/\/{2,}/g, '/');
  return r.length > 1 ? r.replace(/\/$/, '') : r;
}

function firstSeg(route) {
  const s = normRoute(route).split('/').filter(Boolean).find(x => !/^[:[{*]/.test(x));
  return s || 'root';
}

function pascal(route) {
  return (route.split('/').filter(Boolean).map(s => s.replace(/[^\w]/g, '')).map(s => s[0]?.toUpperCase() + s.slice(1)).join('') || 'Root') + 'Page';
}

/** Segment pattern: dynamic segments ([id], :id, {id}, *) become '*'. */
export function routePattern(route) {
  return normRoute(route).split('/').filter(Boolean).map(s => /^(\[.*\]|:.+|\{.*\}|\*\*?)$/.test(s) ? '*' : s);
}

/** Finds the screen a navigation target names, or null. Prefers the most literal match. */
export function makeRouteMatcher(screens, redirects = []) {
  const pats = screens.map(s => ({ s, p: routePattern(s.route), catchAll: /\[\.\.\.|\*\*/.test(s.route) }));
  return (target) => {
    let t = normRoute(target.replace(/[?#].*$/, ''));
    for (let i = 0; i < 3; i++) { const r = redirects.find(x => normRoute(x.from) === t); if (!r || r.to.includes('**')) break; t = normRoute(r.to); }
    const tp = routePattern(t);
    let best = null, bestScore = -1;
    for (const { s, p, catchAll } of pats) {
      if (!catchAll && p.length !== tp.length) continue;
      if (catchAll && tp.length < p.length - 1) continue;
      let score = 0, ok = true;
      for (let i = 0; i < Math.min(p.length, tp.length); i++) {
        if (p[i] === tp[i] && p[i] !== '*') score += 2;
        else if (p[i] === '*' || tp[i] === '*') score += 0;
        else { ok = false; break; }
      }
      if (ok && score > bestScore) { best = s; bestScore = score; }
    }
    return best;
  };
}
