#!/usr/bin/env node
// Merges human/Claude-written descriptions into a hld-for-existing-code bundle. Descriptions live in their own file so
// regenerating the bundle (hld-for-existing-code.mjs / capture.mjs) never loses them.
//
//   node annotate.mjs <bundle.json> <descriptions.json> [-o out.json]
//
// descriptions.json:
//   { "journeys": { "<journey>": "what this flow is for" },
//     "screens":  { "<route>":   "what the user does on this screen" } }
import fs from 'node:fs';

const argv = process.argv.slice(2);
const oi = argv.indexOf('-o');
const out = oi >= 0 ? argv.splice(oi, 2)[1] : null;
const [bundlePath, descPath] = argv;
if (!bundlePath || !descPath) {
  process.stderr.write('Usage: node annotate.mjs <bundle.json> <descriptions.json> [-o out.json]\n');
  process.exit(1);
}
const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
const desc = JSON.parse(fs.readFileSync(descPath, 'utf8'));
if (!/^(hld-for-existing-code|web-hld)\/1$/.test(bundle.schema)) { process.stderr.write('error: not a hld-for-existing-code/1 bundle\n'); process.exit(1); }

const routes = new Set(bundle.screens.map(s => s.route));
const journeys = [...new Set(bundle.screens.map(s => s.journey))];
let screens = 0;
for (const s of bundle.screens) {
  const d = (desc.screens || {})[s.route];
  if (typeof d === 'string' && d.trim()) { s.description = d.trim(); screens++; } else delete s.description;
}
bundle.journeys = journeys.map(name => {
  const d = (desc.journeys || {})[name];
  return typeof d === 'string' && d.trim() ? { name, description: d.trim() } : { name };
});

// Keys that match nothing are usually a renamed route — say so instead of silently dropping them
const stale = [
  ...Object.keys(desc.screens || {}).filter(r => !routes.has(r)).map(r => `screen ${r}`),
  ...Object.keys(desc.journeys || {}).filter(j => !journeys.includes(j)).map(j => `journey ${j}`),
];
const missing = bundle.screens.filter(s => !s.description).map(s => s.route);

fs.writeFileSync(out || bundlePath, JSON.stringify(bundle));
process.stderr.write(`${screens}/${bundle.screens.length} screens and ${bundle.journeys.filter(j => j.description).length}/${journeys.length} journeys described · wrote ${out || bundlePath}\n`);
if (missing.length) process.stderr.write(`no description: ${missing.join(', ')}\n`);
if (stale.length) process.stderr.write(`not in bundle (renamed or removed?): ${stale.join(', ')}\n`);
