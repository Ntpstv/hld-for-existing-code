# HLD for existing code — marketplace

Claude Code plugin marketplace for **HLD for existing code** — HLD boards for Next.js / Angular web apps (real screenshots,
Thai screen/flow descriptions, navigation flow, API examples) as a Figma board, an HTML page, or both.

## Supported

| | Supported | Not yet |
|---|---|---|
| **Frameworks** | **Next.js** (App Router, Pages Router) · **Angular** (NgModule and standalone) | Vue / Nuxt, Remix, React Router (Vite SPA), Svelte |
| **Languages** | **TypeScript**, **JavaScript** (`.ts` `.tsx` `.js` `.jsx` `.mjs`), JSX/TSX and Angular HTML templates | — |
| **API calls** | axios (incl. `axios.create`), `fetch`, React Query (`useQuery` / `useMutation`), Angular `HttpClient` | GraphQL, Next.js server actions |
| **UI libraries recognised** | plain HTML, PrimeNG, Angular Material, Ionic | — |
| **Labels (i18n)** | `t("key")`, `'key' \| translate`, JSON files under `locales/` `i18n/` `assets/` — Thai preferred, English fallback (`--lang`) | — |
| **Descriptions written by Claude** | Thai by default (other languages on request) | — |
| **Output** | Figma board (local plugin) · single-file HTML page | — |
| **Runs on** | Node 18+ · macOS (tested) · Linux (untested) | Windows: `e2e-shots.mjs` needs `unzip` |

Tested on Angular 19 (52 screens, 68 endpoints) and Next.js 15 App Router.
Mobile apps (iOS / Android) are out of scope — this is for web front ends.

## Install

In Claude Code:

```
/plugin marketplace add Ntpstv/hld-for-existing-code
/plugin install hld-for-existing-code@hld-for-existing-code
```

Then ask: `ทำ HLD ให้ <path to app>` (or `/hld-for-existing-code`). Requirements: Node 18+, Figma desktop app for the
Figma output, and — for real screenshots — the app runnable locally with Playwright.

## Update

Bump `version` in `plugins/hld-for-existing-code/.claude-plugin/plugin.json` and in `.claude-plugin/marketplace.json`,
push, and teammates run `/plugin marketplace update hld-for-existing-code`.

## Layout

```
.claude-plugin/marketplace.json
plugins/hld-for-existing-code/
├── .claude-plugin/plugin.json
└── skills/hld-for-existing-code/        SKILL.md, README.md, scripts/, figma-plugin/
```

`sync-from-personal.sh` copies a personal copy (`~/.claude/skills/hld-for-existing-code`) into this plugin and rewrites
its paths, for maintainers who develop there first.
