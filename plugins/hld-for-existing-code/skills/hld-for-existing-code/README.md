# HLD for existing code

Generates a High-Level Design board — in Figma, as a single HTML page, or both — for a **Next.js** or **Angular** front end: every routed
screen, a wireframe outline, where each button/link goes, and every API call behind it.

Works on its own or through Claude Code (`SKILL.md`).

## Feedback

Used it on a project? Two minutes of answers make the next version better:
[https://forms.gle/4FMT8aunDmMzGRXg9](https://forms.gle/4FMT8aunDmMzGRXg9)
ลองใช้แล้วช่วยตอบแบบสอบถามสั้นๆ ให้หน่อยครับ

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

## 1. Analyze

```bash
node <skill-dir>/scripts/webhld.mjs <appDir>
```

`<appDir>` is the folder holding the app's `package.json`. Needs Node 18+, nothing to install.
Output goes to `~/Desktop/web-hld/<project>/bundle.json`; the later steps update that same file, keep
`descriptions.json` beside it, and put images in `screenshots/`.

```
framework: angular  project: my-app
52 screen(s) in 17 journey(s) · 129 screen→screen link(s) · 69 unique endpoint(s)
1 warning(s) — see "warnings" in the bundle
wrote ~/Desktop/web-hld/my-app/bundle.json  (1353 ms)
```

| Option | |
|---|---|
| `-o <file>` | output path (default: `~/Desktop/web-hld/<project>/bundle.json`) |
| `--only /prefix` | only screens under this route (repeatable) |
| `--group auto\|segment\|none` | journeys by first route segment, or one board (`auto`: one board for ≤ 12 screens) |
| `--lang th\|en` | translation file used for labels |
| `--framework nextjs\|angular` | override detection |

## 1b. Real screenshots (optional)

With the app running locally:

```bash
node <skill-dir>/scripts/capture.mjs ~/Desktop/web-hld/<project>/bundle.json --base-url http://localhost:4200 \
  --project <appDir> --init seed-login.js
```

Adds the screenshots to `bundle.json` and saves the images in `screenshots/`. After opening every route by
URL it clicks through the flow to reach screens that need state from the previous page (`--allow-submit` lets it
press save/confirm buttons — stub backends only).

Projects with Playwright e2e specs can fill in the deepest screens from those tests:

```bash
node <skill-dir>/scripts/e2e-shots.mjs ~/Desktop/web-hld/<project>/bundle.json --project <appDir> --specs e2e/<stub specs>
```
 `--init` is a script run
before the app loads, e.g. `localStorage.setItem("authorization", …)` for a test login. Screens that redirect
(auth guard, missing router state) keep the outline and are marked on the board.

## 1c. API examples (optional)

```bash
node <skill-dir>/scripts/examples.mjs ~/Desktop/web-hld/<project>/bundle.json --project <appDir> --stubby <stub dir>
```

Gives each endpoint an example request and response — real traffic recorded by `capture.mjs` first, then
stub files, then a skeleton from the TypeScript types. The plugin draws them on a separate **API** page.

### No stub server

Only the dev server needs to run; the API is answered by capture itself:

```bash
# once, with permission: record a dev/SIT backend (masked, no screenshots, nothing submitted)
node …/capture.mjs bundle.json --base-url http://localhost:4200 --project <app> --record api-recording.json --allow-real-data
# any time after: capture offline from the recording
node …/capture.mjs bundle.json --base-url http://localhost:4200 --project <app> --replay api-recording.json
# or, no backend ever: fake data from the TypeScript types
node …/capture.mjs bundle.json --base-url http://localhost:4200 --project <app> --mock auto --mock-wrapper mock-wrapper.json
```

`--browser chrome` uses the installed Chrome; `--install-playwright` installs Playwright into the skill once.

## Personal data

API examples are masked automatically (names, ID/phone numbers, emails, addresses, birth dates, tokens).
Screenshots are not, so `capture.mjs` only runs against a local server unless you pass `--allow-real-data`.

## HTML instead of (or as well as) Figma

```bash
node <skill-dir>/scripts/html.mjs ~/Desktop/web-hld/<project>/bundle.json
```

Writes `board.html` beside the bundle: one file with every screen, flow arrows, links and the API reference.
Open it in a browser or send it to someone — no Figma needed.

## 2. Load the plugin (once)

Figma **desktop app** → Plugins → Development → **Import plugin from manifest…** →
`~/Desktop/web-hld/figma-plugin/manifest.json` — `webhld.mjs` creates and refreshes this copy on every run,
so re-importing is never needed.

## 3. Generate

Plugins → Development → **HLD for existing code** → **Choose file…** (or paste the JSON) → **Generate**.

Each screen gets a column: title, route and component; the wireframe; **GOES TO** (`→` same journey,
`↗` other journey, `⇱` external, `←` back, `✕` exit — rows naming a screen are clickable); **API**
(method, path, request and response fields); **STORAGE**. Journeys are dashed boxes laid out left to right in
flow order; arrows carry the action name, and a diamond marks a screen with several next screens.
Re-running replaces the previous board and leaves hand-drawn content alone.

## Layout

```
hld-for-existing-code/
├── SKILL.md              # Claude Code skill
├── scripts/
│   ├── webhld.mjs        # CLI entry
│   ├── capture.mjs       # optional real screenshots via Playwright (URL + click-through)
│   ├── examples.mjs      # API request/response examples: captured → stub files → TS types
│   ├── html.mjs          # the board as one self-contained HTML page
│   ├── annotate.mjs      # merge screen/journey descriptions into a bundle
│   ├── e2e-shots.mjs     # optional screenshots borrowed from the project's e2e traces
│   └── lib/
│       ├── source.mjs    # comment stripping, bracket matching, function/class extraction
│       ├── project.mjs   # tsconfig paths, imports, constants, types, i18n
│       ├── routes.mjs    # Next.js / Angular screen discovery, route matching
│       ├── effects.mjs   # navigation, HTTP calls, cross-file call graph
│       └── ui.mjs        # wireframe outline + event bindings (JSX / Angular templates)
└── figma-plugin/         # manifest.json, code.js, ui.html
```

See `SKILL.md` for what the analyzer understands and its limitations.
