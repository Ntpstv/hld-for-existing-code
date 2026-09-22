// What a function does: HTTP calls (resolved to method + path), navigations, storage.
// The project-wide ApiGraph joins screen → hook/service → axios/HttpClient/fetch call across files.
import { read, extractFunctions, extractClasses, matchClose, callArgs, splitTopLevel, paramTypes, skipString } from './source.mjs';

const HTTP_VERBS = 'get|post|put|patch|delete|head|request|options';
const HTTP_OBJ = /^(axios|http|httpClient|client|\$http|ky|fetcher|request|instance|api|\w*(Axios|Api|API|Client|Http|HttpClient|Request|Fetcher))$/;
const BASE_NAME = /url|host|base|api|domain|endpoint|server|origin|prefix|path/i;

/**
 * Evaluates a string-ish expression to a path. Unknown parts become `{name}` placeholders so the
 * shape of the URL survives even when a segment is only known at runtime.
 * ctx: { project, locals: Map(name → expr), fields: Map(name → {init}), params: Map }
 */
export function evalStr(expr, ctx, depth = 0) {
  expr = (expr || '').trim().replace(/\s+as\s+[\w$.<>\[\]]+$/, '').replace(/!$/, '');
  if (!expr || depth > 6) return { value: '', literal: false };
  while (expr.startsWith('(') && matchClose(expr, 0) === expr.length - 1) expr = expr.slice(1, -1).trim();

  const terms = splitTopLevel(expr, '+');
  if (terms.length > 1) {
    const parts = terms.map(t => evalStr(t, ctx, depth + 1));
    return { value: parts.map(p => p.value).join(''), literal: parts.some(p => p.literal) };
  }
  const q = expr[0];
  if ((q === '"' || q === "'") && expr.endsWith(q)) return { value: expr.slice(1, -1), literal: true };
  if (q === '`' && expr.endsWith('`')) {
    let out = '', k = 1, literal = false;
    while (k < expr.length - 1) {
      if (expr[k] === '$' && expr[k + 1] === '{') {
        const close = matchClose(expr, k + 1);
        out += evalStr(expr.slice(k + 2, close), ctx, depth + 1).value;
        k = close + 1; continue;
      }
      out += expr[k]; literal = true; k++;
    }
    return { value: out, literal };
  }
  // `[a, b]` — Angular router.navigate commands
  if (q === '[' && expr.endsWith(']')) {
    const segs = splitTopLevel(expr.slice(1, -1)).filter(s => !s.startsWith('{'));   // drop matrix params
    const parts = segs.map(s => evalStr(s, ctx, depth + 1));
    const joined = parts.map(p => p.value).join('/').replace(/\/{2,}/g, '/');
    return { value: joined, literal: parts.some(p => p.literal) };
  }
  // `cond ? 'a' : 'b'` — keep the first branch, it is still a real destination
  const tern = /^[^?]+\?\s*([\s\S]+?)\s*:\s*[\s\S]+$/.exec(expr);
  if (tern && !expr.startsWith('`')) return evalStr(tern[1], ctx, depth + 1);
  // `x.toString()`, `String(x)`, `encodeURIComponent(x)` keep the argument's name
  const call = /^(?:String|encodeURIComponent|encodeURI|Number)\s*\(([\s\S]*)\)$/.exec(expr);
  if (call) return evalStr(call[1], ctx, depth + 1);
  const ident = /^([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)(?:\(\))?$/.exec(expr);
  if (ident) {
    const name = ident[1].replace(/\?\./g, '.');
    if (/^(environment|env|process\.env|import\.meta\.env)\b/.test(name)) {
      return { value: `{${name.split('.').pop()}}`, literal: false };
    }
    if (ctx.locals && ctx.locals.has(name)) {
      const inner = ctx.locals.get(name);
      ctx.locals.delete(name);                        // guard against `url = url + x`
      const r = evalStr(inner, ctx, depth + 1);
      ctx.locals.set(name, inner);
      return r;
    }
    const thisField = /^this\.([A-Za-z_$][\w$]*)$/.exec(name);
    if (thisField && ctx.fields && ctx.fields.has(thisField[1]) && ctx.fields.get(thisField[1]).init) {
      return evalStr(ctx.fields.get(thisField[1]).init, { ...ctx, fields: new Map() }, depth + 1);
    }
    const c = ctx.project.constValue(name.replace(/^this\./, ''));
    if (typeof c === 'string') return { value: c, literal: true };
    const last = name.split('.').pop();
    return { value: `{${last}}`, literal: false };
  }
  // Anything more complex (`phone?.replace(/\D/g, '')`, `a ?? b`) is named after its leading identifier
  const lead = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*/.exec(expr);
  const segs = lead ? lead[0].split(/\??\./) : [];
  if (segs.length > 1 && expr[lead[0].length] === '(') segs.pop();      // `phone.replace(…)` → phone
  return { value: `{${segs.filter(x => x !== 'this').pop() || 'value'}}`, literal: false };
}

/** `{apiUrl}api/v1/x` → { base: '{apiUrl}', path: '/api/v1/x' } */
export function splitBase(url) {
  let base = '';
  let rest = url.replace(/^https?:\/\/[^/]+/, m => { base = m; return ''; });
  const lead = /^(\{[^}]+\})+/.exec(rest);
  if (lead && [...lead[0].matchAll(/\{([^}]+)\}/g)].every(x => BASE_NAME.test(x[1]))) {
    base += lead[0]; rest = rest.slice(lead[0].length);
  }
  rest = rest.split('?')[0];
  if (!rest.startsWith('/') && !rest.startsWith('{')) rest = '/' + rest;
  return { base, path: rest.replace(/\/{2,}/g, '/') };
}

/** Local `const x = expr` declarations inside a body. */
export function localDecls(body) {
  const locals = new Map();
  for (const m of body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*/g)) {
    const start = m.index + m[0].length;
    let k = start;
    while (k < body.length) {
      const c = body[k];
      if (c === '"' || c === "'" || c === '`') { k = skipString(body, k); continue; }
      if (c === '(' || c === '[' || c === '{') { const e = matchClose(body, k); if (e < 0) break; k = e + 1; continue; }
      if (c === ';') break;
      if (c === '\n') {
        // the declaration continues when this line ends, or the next begins, with an operator
        const before = body.slice(start, k).trimEnd();
        const after = body.slice(k + 1).trimStart();
        if (before && !/[=+\-*/%?:,(&|]$/.test(before) && !/^[+\-*/%?:.&|]/.test(after)) break;
      }
      k++;
    }
    if (!locals.has(m[1])) locals.set(m[1], body.slice(start, k).trim());
  }
  // `url = url + x` reassignments are ignored; the declaration is the useful shape
  return locals;
}

function genericArg(src, k) {
  if (src[k] !== '<') return { type: '', next: k };
  let d = 0, j = k;
  for (; j < src.length; j++) {
    if (src[j] === '<') d++;
    else if (src[j] === '>' && src[j - 1] !== '=') { d--; if (d === 0) break; }
    else if (src[j] === '(' || src[j] === ';') return { type: '', next: k };
  }
  return { type: src.slice(k + 1, j).trim(), next: j + 1 };
}

/** Direct HTTP calls in one function body. */
export function httpCalls(fn, cls, project) {
  const body = fn.body;
  const out = [];
  const fields = cls ? cls.fields : new Map();
  const ctx = { project, locals: localDecls(body), fields };
  const params = paramTypes(fn.params);
  const httpFields = new Set([...fields].filter(([, f]) => /HttpClient|HttpService|AxiosInstance/.test(f.type || '') || /inject\(\s*HttpClient/.test(f.init || '')).map(([n]) => n));

  const re = new RegExp(`([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)\\s*\\.\\s*(${HTTP_VERBS})\\s*(?=[<(])`, 'g');
  for (const m of body.matchAll(re)) {
    const obj = m[1];
    const last = obj.split('.').pop();
    const isThis = obj.startsWith('this.');
    const ok = project.axiosInstances.has(last) || HTTP_OBJ.test(last) || (isThis && httpFields.has(last));
    if (!ok || /^(router|searchParams|params|headers|map|storage|cache|queryClient|formData|localStorage|sessionStorage|cookies|form|control|route)$/i.test(last)) continue;
    let k = m.index + m[0].length;
    const g = genericArg(body, k);
    k = g.next;
    while (/\s/.test(body[k])) k++;
    if (body[k] !== '(') continue;
    const { args } = callArgs(body, k);
    if (!args.length) continue;
    let method = m[2].toUpperCase();
    let urlExpr = args[0];
    if (method === 'REQUEST') {                                   // http.request('POST', url) / axios.request({ url, method })
      if (/^['"]/.test(args[0]) && args[1]) { method = args[0].slice(1, -1).toUpperCase(); urlExpr = args[1]; }
      else {
        const u = /\burl\s*:\s*([^,}]+)/.exec(args[0]); const mm = /\bmethod\s*:\s*['"](\w+)/.exec(args[0]);
        if (!u) continue; urlExpr = u[1]; method = mm ? mm[1].toUpperCase() : 'GET';
      }
    }
    const url = evalStr(urlExpr, ctx);
    if (!url.literal && !/\{[^}]*(url|path|endpoint)[^}]*\}/i.test(url.value)) continue;   // nothing about the endpoint is known
    let base = project.axiosBase.has(last) ? evalStr(project.axiosBase.get(last), ctx).value : '';
    const split = splitBase(url.value);
    const bodyArg = /^(POST|PUT|PATCH)$/.test(method) ? args[1] : undefined;
    out.push({
      method, path: split.path, base: split.base || base,
      responseType: /^[A-Z]$|^(any|unknown|object)$/.test(g.type) ? '' : g.type || '',
      ...requestInfo(bodyArg, params, project),
      via: fn.cls ? `${fn.cls}.${fn.name}` : fn.name,
    });
  }

  for (const m of body.matchAll(/\bfetch\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const { args } = callArgs(body, open);
    if (!args.length) continue;
    const url = evalStr(args[0], ctx);
    if (!url.literal) continue;
    const mm = args[1] ? /\bmethod\s*:\s*['"](\w+)/.exec(args[1]) : null;
    let b = null;
    if (args[1] && args[1].startsWith('{')) {
      const bodyProp = splitTopLevel(args[1].slice(1, matchClose(args[1], 0))).find(p => /^body\s*:/.test(p));
      if (bodyProp) {
        let v = bodyProp.replace(/^body\s*:\s*/, '').trim();
        const js = /^JSON\.stringify\s*\(([\s\S]*)\)$/.exec(v); if (js) v = splitTopLevel(js[1])[0] || '';
        b = [null, v];
      }
    }
    const split = splitBase(url.value);
    out.push({ method: mm ? mm[1].toUpperCase() : 'GET', path: split.path, base: split.base, responseType: '',
      ...requestInfo(b ? b[1] : undefined, params, project), via: fn.cls ? `${fn.cls}.${fn.name}` : fn.name });
  }
  return out;
}

function requestInfo(arg, params, project) {
  if (!arg) return { requestType: '', requestFields: [] };
  arg = arg.trim();
  const as = /\bas\s+([A-Za-z_$][\w$.<>\[\]]*)\s*$/.exec(arg);
  if (as) return { requestType: as[1], requestFields: project.typeFields(as[1]) };
  if (arg.startsWith('{')) {
    const close = matchClose(arg, 0);
    const keys = splitTopLevel(arg.slice(1, close)).map(p => {
      if (p.startsWith('...')) {
        const t = params.get(p.slice(3).trim());
        return t ? project.typeFields(t) : [];
      }
      return [/^['"]?([A-Za-z_$][\w$-]*)/.exec(p)?.[1]];
    }).flat().filter(Boolean);
    return { requestType: '', requestFields: [...new Set(keys)] };
  }
  const id = /^([A-Za-z_$][\w$]*)$/.exec(arg);
  if (id && params.has(id[1]) && params.get(id[1])) {
    const t = params.get(id[1]).split('|').map(x => x.trim()).filter(x => x && x !== 'undefined' && x !== 'null').join(' | ');
    return { requestType: t, requestFields: project.typeFields(t) };
  }
  return { requestType: '', requestFields: [] };
}

const NAV_CALL = /(?:([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\.\s*)?\b(push|replace|navigate|navigateByUrl|navigateTo|navigateBack|redirect|permanentRedirect|goTo|goto|routeTo|open|assign)\s*(?:<[^>]*>)?\s*\(/g;
const EXIT_CALL = /(?:([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\.\s*)?\b(back|goBack|closeWebView|closeWindow|close|dismiss|exitApp|backToEntryPage|popToRoot)\s*\(\s*\)/g;

/** Navigations performed by one function body. Each → { raw, route?, url?, kind } */
export function navigations(fn, cls, project) {
  const body = fn.body;
  const ctx = { project, locals: localDecls(body), fields: cls ? cls.fields : new Map() };
  const out = [];
  for (const m of body.matchAll(NAV_CALL)) {
    const obj = (m[1] || '').replace(/^this\./, '');
    const verb = m[2];
    const objLast = obj.split('.').pop();
    // array.push / str.replace / window.open need a navigation-looking receiver
    if ((verb === 'push' || verb === 'replace') && !/router|history|navigation|nav$|navigator/i.test(objLast)) continue;
    if (verb === 'open' && !/^window$/.test(obj)) continue;
    if (verb === 'assign' && !/location$/.test(obj)) continue;
    if (verb === 'navigate' && obj && !/router|navigation|nav|navCtrl/i.test(objLast)) continue;
    const open = m.index + m[0].length - 1;
    const { args } = callArgs(body, open);
    if (!args.length) { if (verb === 'navigateBack') out.push({ kind: 'back', raw: 'navigateBack()' }); continue; }
    const r = evalStr(args[0], ctx);
    if (!r.literal && !/^\{/.test(r.value)) continue;
    push(out, r.value, `${m[0].replace(/\s+/g, '')}${args[0].slice(0, 40)})`, verb === 'open' || verb === 'assign');
  }
  // Project wrappers: navigateNoAnimateTo(NAVIGATION.X), redirectToLogin('/x'), goToPage(ROUTES.Y)
  for (const m of body.matchAll(/(?<![.\w$])([a-z][\w$]*(?:Navigate|navigate|Redirect|redirect|GoTo|goTo|RouteTo|routeTo)[\w$]*|(?:navigate|redirect|goTo|routeTo)[A-Z][\w$]*)\s*\(/g)) {
    if (/^(navigate|navigateTo|navigateBack|navigateByUrl|redirect|goTo|routeTo)$/.test(m[1])) continue;   // handled above
    const open = m.index + m[0].length - 1;
    const { args } = callArgs(body, open);
    if (!args.length) continue;
    const r = evalStr(args[0], ctx);
    if (!r.literal || !/^(\/|https?:)/.test(r.value)) continue;
    push(out, r.value, `${m[1]}(${args[0].slice(0, 40)})`, false);
  }
  for (const m of body.matchAll(/\b(?:window\.)?location(?:\.href)?\s*=\s*([^;\n]+)/g)) {
    const r = evalStr(m[1], ctx);
    if (r.literal) push(out, r.value, m[0].trim(), true);
  }
  for (const m of body.matchAll(EXIT_CALL)) {
    const obj = (m[1] || '').replace(/^this\./, '');
    if (m[2] === 'back' && !/router|history|location|navigation|nav/i.test(obj)) continue;
    if ((m[2] === 'close' || m[2] === 'dismiss') && !/dialog|modal|window|webview|sheet/i.test(obj)) continue;
    out.push({ kind: /back/i.test(m[2]) ? 'back' : 'exit', raw: m[0].replace(/\s+/g, '') });
  }
  return out;
}

function push(out, value, raw, forceExternal) {
  if (/^(https?:|mailto:|tel:|intent:|[a-z][\w+.-]*:\/\/)/i.test(value)) out.push({ kind: 'external', url: value, raw });
  else if (forceExternal && !value.startsWith('/')) out.push({ kind: 'external', url: value, raw });
  else out.push({ kind: 'route', route: value.split(/[?#]/)[0] || '/', raw });
}

/**
 * Project-wide call graph for endpoints. Keys are bare function names (`getPassbook`, `useGetPassbook`)
 * and `Class.method` for class members; references between them are followed transitively.
 */
export class ApiGraph {
  constructor(project) {
    this.project = project;
    this.defs = new Map();           // key → [{ direct, refs }]
    this.classOf = new Map();        // className → class info (fields for DI)
    for (const f of project.files) this.#indexFile(f);
    this.memo = new Map();
  }

  #indexFile(file) {
    const src = read(file);
    const classes = extractClasses(src);
    for (const c of classes) if (!this.classOf.has(c.name)) this.classOf.set(c.name, c);
    for (const fn of extractFunctions(src)) {
      const cls = fn.cls ? classes.find(c => c.name === fn.cls) : null;
      const key = fn.cls ? `${fn.cls}.${fn.name}` : fn.name;
      const direct = httpCalls(fn, cls, this.project);
      const refs = this.refsOf(fn.body, cls, fn);
      if (!this.defs.has(key)) this.defs.set(key, []);
      this.defs.get(key).push({ direct, refs, file, mutation: /\b(useMutation|createMutation|injectMutation)\s*[<(]/.test(fn.body) });
    }
  }

  /** Names a body refers to that could lead to an endpoint. */
  refsOf(body, cls, fn) {
    const refs = new Set();
    for (const m of body.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*(?:<[^()]*?>)?\s*\(/g)) if (m[1].length > 1 && !m[1].startsWith('$')) refs.add(m[1]);
    // queryFn: fetchX / mutationFn: postX / .then(getX) — function passed by reference
    for (const m of body.matchAll(/(?:queryFn|mutationFn|fn|loader|action)\s*:\s*([A-Za-z_$][\w$]*)\b/g)) refs.add(m[1]);
    for (const m of body.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*\(/g)) if (cls) refs.add(`${cls.name}.${m[1]}`);
    for (const m of body.matchAll(/\b(this\.)?([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*(?:<[^()]*?>)?\s*\(/g)) {
      const holder = m[2], method = m[3];
      let type = null;
      if (cls && cls.fields.has(holder)) type = cls.fields.get(holder).type;
      if (!type && fn) { const pt = paramTypes(fn.params).get(holder); if (pt) type = pt.replace(/<.*$/, ''); }
      if (!type) { const inj = new RegExp(`\\b${holder}\\s*=\\s*inject\\(\\s*([A-Za-z_$][\\w$]*)`).exec(body); if (inj) type = inj[1]; }
      if (!type && /^[A-Z]/.test(holder)) type = holder;          // static call: ApiService.getX()
      if (type) refs.add(`${type}.${method}`);
    }
    return [...refs];
  }

  /** All endpoints reachable from `key`, deduplicated. */
  endpoints(key, depth = 0, stack = new Set()) {
    if (this.memo.has(key)) return this.memo.get(key);
    if (depth > 6 || stack.has(key) || !this.defs.has(key)) return [];
    stack.add(key);
    const found = [];
    for (const d of this.defs.get(key)) {
      found.push(...d.direct);
      for (const r of d.refs) if (r !== key) found.push(...this.endpoints(r, depth + 1, stack));
    }
    stack.delete(key);
    const uniq = dedupeEndpoints(found);
    if (depth === 0) this.memo.set(key, uniq);
    return uniq;
  }
}

export function dedupeEndpoints(list) {
  const seen = new Map();
  for (const e of list) {
    const k = `${e.method} ${e.path}`;
    if (!seen.has(k)) seen.set(k, { ...e });
    else {
      const prev = seen.get(k);
      if (!prev.responseType && e.responseType) prev.responseType = e.responseType;
      if (!prev.requestType && e.requestType) prev.requestType = e.requestType;
      if (!(prev.requestFields || []).length && (e.requestFields || []).length) prev.requestFields = e.requestFields;
    }
  }
  return [...seen.values()];
}

export function storageUses(body, project) {
  const out = new Set();
  const ctx = { project, locals: localDecls(body), fields: new Map() };
  for (const m of body.matchAll(/\b(localStorage|sessionStorage)\s*\.\s*(getItem|setItem|removeItem)\s*\(\s*([^,)]+)/g)) {
    out.add(`${m[1]}.${m[2].replace('Item', '')}(${evalStr(m[3], ctx).value})`);
  }
  for (const m of body.matchAll(/\bcookies\(\)\s*\.\s*(get|set|delete)\s*\(\s*([^,)]+)/g)) {
    out.add(`cookie.${m[1]}(${evalStr(m[2], ctx).value})`);
  }
  return [...out];
}
