// Shared helpers for API examples: endpoint matching and trimming payloads to board size.

/** Regex for a bundle path, `{id}` segments matching anything. */
export function pathRegex(p) {
  return new RegExp('^' + p.split(/(\{[^}]+\})/).map(part =>
    /^\{.*\}$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '/?$');
}

/** Key of the bundle endpoint a concrete URL path hits, or null. Longest literal path wins. */
export function makeEndpointMatcher(bundle) {
  const eps = [];
  for (const s of bundle.screens) for (const a of s.apis || []) {
    const key = `${a.method} ${a.path}`;
    if (!eps.some(e => e.key === key)) eps.push({ key, method: a.method, re: pathRegex(a.path), len: a.path.replace(/\{[^}]+\}/g, '').length });
  }
  eps.sort((a, b) => b.len - a.len);
  return (method, urlPath) => {
    const hit = eps.find(e => e.method === method.toUpperCase() && (e.re.test(urlPath) || endsWithMatch(e.re, urlPath)));
    return hit ? hit.key : null;
  };
}

// The bundle path has the base URL stripped; the request path may still carry a gateway prefix
function endsWithMatch(re, urlPath) {
  const parts = urlPath.split('/');
  for (let i = 1; i < parts.length; i++) if (re.test('/' + parts.slice(i).join('/'))) return true;
  return false;
}

/** Keeps examples readable on a board: 2 array items, 120-char strings, 8 levels. */
export function trim(v, depth = 0) {
  if (depth > 8) return '…';
  if (Array.isArray(v)) return v.slice(0, 2).map(x => trim(x, depth + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = trim(x, depth + 1);
    return out;
  }
  if (typeof v === 'string' && v.length > 120) return v.slice(0, 119) + '…';
  return v;
}

export function parseJsonLoose(text) {
  if (text == null) return undefined;
  if (typeof text === 'object') return text;
  try { return JSON.parse(text); } catch { return undefined; }
}

// ── Personal data ───────────────────────────────────────────────────────────
// Examples end up on a shared Figma board. Captured traffic (and stub files copied from production) can hold
// real people's data, so values are masked by key name and by shape before they are stored.
// Matched against the end of the key, so `secondaryMobileNo`, `staffName`, `careTakerFirstName` are caught too
const SENSITIVE_KEY = /(identifier|citizen(id|no)?|nationalid|idcard(no)?|passport(no)?|taxid|mobile(no|number)?|phone(no|number)?|telno|e?mail(address)?|address(detail)?|postcode|zipcode|(first|last|middle|full|given|family|sur|staff|customer|patient|member|user|officer|person|contact|owner|caretaker|caregiver)name|birth(date|day)?|dateofbirth|dob|token|authorization|password|passcode|otp|secret|sessionid|cookie|account(no|number)|card(no|number)|key|apikey|secret(key)?|signature|credential(s)?|(register|created|updated|modified|approved|assigned|requested|recorded|submitted|checked|verified)by(name)?|staff|officer|doctor|nurse|caretaker|guardian)$|^(cid|auth|moo|soi|road|street|pin)$/i;
const THAI_ID = /\b\d[- ]?\d{4}[- ]?\d{5}[- ]?\d{2}[- ]?\d\b/g;          // 13-digit citizen ID, with or without dashes
const PHONE = /(?<!\d)(\+?66|0)[- ]?\d{1,2}[- ]?\d{3}[- ]?\d{3,4}(?!\d)/g;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g;

function maskString(s) {
  if (!s) return s;
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 8 && digits.length === s.replace(/[\s-]/g, '').length) return '•'.repeat(digits.length - 4) + digits.slice(-4);
  return s.length <= 2 ? '••' : s[0] + '•'.repeat(Math.min(s.length - 1, 6));
}

/** Masks personal data. Returns [value, changed]. */
export function redact(v, key = '') {
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map(x => { const [y, c] = redact(x, key); changed = changed || c; return y; });
    return [out, changed];
  }
  if (v && typeof v === 'object') {
    let changed = false;
    const out = {};
    for (const [k, x] of Object.entries(v)) { const [y, c] = redact(x, k); out[k] = y; changed = changed || c; }
    return [out, changed];
  }
  if (typeof v === 'string') {
    if (SENSITIVE_KEY.test(key) && v && !/^(null|undefined|-)$/.test(v)) return [maskString(v), true];
    const out = v.replace(JWT, '•••jwt•••').replace(EMAIL, m => maskString(m)).replace(THAI_ID, m => maskString(m)).replace(PHONE, m => maskString(m));
    return [out, out !== v];
  }
  if (typeof v === 'number' && SENSITIVE_KEY.test(key)) return [0, true];
  return [v, false];
}
