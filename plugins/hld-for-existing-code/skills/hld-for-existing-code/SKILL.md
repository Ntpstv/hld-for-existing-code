---
name: hld-for-existing-code
description: Generate a high-level design (HLD) board for a web front end (Next.js App/Pages Router or Angular) as a Figma board, a self-contained HTML page, or both — every routed screen with its real screenshot (captured from the app running against a local stub/mock; source-derived outline when a screen cannot be reached), a short Thai description of each screen and journey, where each button/link/action navigates, and every API call behind it with example request/response (personal data masked). Use when asked to "generate an HLD" / "ทำ HLD" for a web app, "ทำ HLD เป็นเว็บ/HTML", "HLD board", "onboard me to <web app>", "map the screens and APIs of <Next/Angular project>", "draw the user flow in Figma", or when picking up an unfamiliar web codebase and needing the screen-by-screen + API picture fast. Also use to re-render an existing bundle as HTML or Figma without re-analysing. Needs Node 18+, the Figma desktop app only for the Figma output, and (for screenshots) the app runnable locally with Playwright. Same idea as the iOS HLDGen tool, for web.
---

# HLD for existing code

> `<skill-dir>` below is this skill's own folder — the base directory shown when the skill loads
> (installed as a plugin it lives in Claude Code's plugin cache, not in `~/.claude/skills`). Use that absolute
> path in every command.

Turns "read a web app's routes, pages, services and templates and work out what each screen does" into one
command plus a Figma import. The extraction is a deterministic Node script, not something re-derived by
reading code each time — the same input always gives the same board, and anyone on the team can run it
without Claude.

**Division of labor**
- `scripts/hld-for-existing-code.mjs` (Node 18+, no dependencies) — discovers screens from the router, follows each
  screen's handlers into hooks/services down to the actual `axios` / `HttpClient` / `fetch` call, resolves
  route and URL constants, and writes a `hld-for-existing-code/1` JSON bundle.
- `scripts/html.mjs` — the same board as one self-contained HTML page, for people without Figma.
- `figma-plugin/` — a local Figma plugin that draws the bundle: one column per screen (header, wireframe,
  GOES TO, API, STORAGE), journeys as dashed boxes, flow arrows labelled with the triggering action, and a
  diamond where a screen branches.
- You — pick the right app folder, run the script, sanity-check the bundle against the source, fix the
  analyzer when it misses an idiom, and hand the bundle to the user for Figma.

Never hand-write or hand-edit screens, destinations or endpoints in the bundle. If something is missing or
wrong, that is an analyzer gap: fix it in `scripts/lib/` (so the next run benefits) or report it as a
limitation. A missing arrow is better than an invented one.

## Step 0 — Ask which output they want

Before doing any work, ask (AskUserQuestion) which output to produce, unless the request already says:

- **Figma** — board drawn by the local Figma plugin (needs the Figma desktop app)
- **HTML** — one self-contained `board.html`, opens in any browser, easy to send
- **Both** (recommended when unsure — same data, HTML is cheap)

The choice only changes Step 4; analysis, screenshots, descriptions and API examples are the same. If the user
only wants an existing bundle re-rendered ("ทำ HTML จาก HLD ของ X"), skip to Step 4 with that bundle.

## Step 1 — Find the app

The script takes the folder holding the app's own `package.json` (with `next` or `@angular/core`). In a
monorepo (`apps/*`, `packages/*`, Nx), ask which app if it is not obvious from the request.

## Step 2 — Run the analyzer

```bash
node <skill-dir>/scripts/hld-for-existing-code.mjs <appDir>
```

Options:
- `--only /orders` (repeatable) — keep screens under a route prefix, for one journey of a big app.
- `--group segment|none|auto` — journeys by first route segment (Next.js route groups `(shop)` win), or one
  board. `auto` (default) uses one board for ≤ 12 screens so the flow arrows show.
- `--lang th|en` — which translation file labels come from (default `th`, falls back to `en`).
- `--framework nextjs|angular` — only when detection fails.

The run prints screens / journeys / links / endpoints and a warning count.

**Where files go.** Everything for one app lives in `~/Desktop/hld-for-existing-code/<project>/` (the default; Figma's file
picker reaches it and it survives restarts) — never in the user's repo or a temp/scratchpad folder:

```
~/Desktop/hld-for-existing-code/
├── figma-plugin/           ← import manifest.json once in Figma; refreshed by every hld-for-existing-code.mjs run
└── <project>/
    ├── bundle.json     ← the one file to import in Figma (later steps update it in place)
    ├── board.html          ← the same board as a web page (Step 4)
    ├── descriptions.json   ← screen/journey descriptions (Step 3c), kept across regenerations
    ├── seed-login.js       ← test-login init script for capture (Step 3b), when one is needed
    └── screenshots/        ← captured images
```

Re-running `hld-for-existing-code.mjs` refreshes the analysis but keeps screenshots, capture notes and API examples for
routes/endpoints that still exist, and re-applies `descriptions.json` (`--fresh` discards them). Re-capture
after UI changes so pictures are not stale. Always end by
telling the user the full path of `bundle.json`.

## Step 3 — Check the bundle before handing it over

Read the JSON (`screens[]`, `warnings[]`) and spot-check two or three screens against their `files`:

- `goesTo[]` — `target` is a screen route; `target: null` with `kind: "route"` means a navigation the
  script could not match (listed in `warnings`). `external` / `back` / `exit` rows are expected.
- `apis[]` — `path` should be a real path. `{name}` segments are runtime values (fine); a path that is
  mostly `{…}` means a URL constant was not resolved — check how the service builds its URL.
- `elements[]` — the wireframe outline. Empty means the template/JSX was not found or not parseable.
- `actions[]` — which handler (and which button) leads where and calls what.

If a screen is clearly wrong, find the idiom that was missed and fix `scripts/lib/`:
`routes.mjs` (screen discovery), `effects.mjs` (navigation + HTTP + call graph), `ui.mjs` (outline and
event bindings), `project.mjs` (imports, constants, types, i18n). Re-run and re-check.

## Step 3b — Real screenshots (do this by default)

A board of outlines alone is not what people expect — they want to see the real screens. Always attempt
this step; skip it only when the user says outlines are enough. Outlines come from the source; real pages
need the app running locally (dev server + mock/stub API, or a test environment the user points you at).

Work out how to run it from the repo before asking: `package.json` scripts, `playwright.config.*`
`webServer` entries (they usually name the dev server *and* the stub/mock server), a sibling stub/mock
folder, `environment*.ts` / `.env*` for the API base URL. Start what is needed in the background, capture,
then stop everything you started and leave the repo and stub folder as you found them.

If the app cannot run here (needs a VPN, real credentials, a backend that isn't available), say so plainly
and ask for a base URL / stub / test login rather than silently handing over an outline-only board.

**No stub/mock server?** Look first for mocks the project already has (MSW handlers, json-server, Angular
in-memory-web-api, a mock mode in `.env`, `page.route()` in its e2e). If there are none, `capture.mjs` can
answer the API itself — only the dev server needs to run:

1. **`--replay <file>`** (most realistic). Record once from a dev/SIT backend, only with the user's explicit
   OK: `--record <project>/api-recording.json --allow-real-data`. Recording takes no screenshots, never
   submits anything, and masks personal data before writing. Then capture with `--replay` against no backend
   at all: screens show that environment's data, masked (names as "ส•••••"). Keep the recording in
   `~/Desktop/hld-for-existing-code/<project>/`, never in the repo.
2. **`--mock auto`** (no backend ever). Fake but realistic data generated from the response TypeScript types
   (names, phones, dates, statuses picked from field names). Read the app's HTTP interceptor / base response
   model and write the envelope it expects to `~/Desktop/hld-for-existing-code/<project>/mock-wrapper.json` for
   `--mock-wrapper` (e.g. `{"status":"OK","data":"$data"}`) — without it the app often
   treats every mocked call as an error. Untyped calls (`http.post(url, body)` with no `<T>`) get `{}`, so their
   lists stay empty: say so in the report, and prefer `--replay` for such projects.
3. Both: `--replay … --mock auto` answers from the recording first and mocks whatever it lacks.

Mocked/replayed responses are labelled as such in the API examples — never as captured traffic.

**No Playwright in the project?** `--browser chrome` uses the installed Google Chrome. With the user's OK to
download, `--install-playwright` installs Playwright (and Chromium unless `--browser chrome`) into
`<skill>/runtime/` once, for every project.

```bash
node <skill-dir>/scripts/capture.mjs <bundle.json> --base-url http://localhost:4200 \
  --project <appDir> [--init seed.js] [--storage-state state.json] [--param id=123] [--wait 2500]
```

- Start the servers the project's own e2e setup uses (read `playwright.config.*` `webServer`, `package.json`
  scripts) in the background, and stop them afterwards. Playwright is taken from the app's `node_modules`.
- Login: prefer the project's existing test seeding (e.g. an e2e auth fixture that writes a fake token
  to localStorage) turned into a small `--init` script. Give that session every permission the app checks
  (collect the feature/role codes from the source, e.g. a permissions constants file): test fixtures often grant one
  permission, and screens then skip their list APIs — lists stay empty, so the crawl has no row to click.
  If lists are still empty, compare the page's network calls with the stub's routes before blaming data.
- A saved real session (`--storage-state`) holds a live token — use one only when the user explicitly says so
  (see *Personal data* below).
- Pass 1 opens each route by URL. Pass 2 (on by default, `--no-crawl` to skip) reaches the rest by clicking
  the trigger the analyzer recorded (`button "ตกลง"`, a row inside `app-user-list-table`) from a screen
  already captured, so the app supplies its own router state. Save/confirm/delete-like triggers are clicked
  only with `--allow-submit` — pass it for a local stub, never for a shared or real backend.
- A screen that redirects elsewhere (guard, missing router state) gets no image and a `captureNote`; the board
  keeps its outline and says why. Never substitute a different page's screenshot.

Screens that need multi-step state (forms, seeded records) are usually reached by the project's own e2e
tests. When the project has stub/mock Playwright specs, borrow their screenshots:

```bash
node <skill-dir>/scripts/e2e-shots.mjs <bundle.json> --project <appDir> \
  --specs e2e/some.e2e.spec.ts [--specs …] [--config playwright.config.ts]
```

It runs the specs with `--trace on` (output in a temp dir, not the repo), pulls the screencast frame taken
~2.5 s after each arrival on a route, and fills screens that still have no picture. Pass only specs that run
against stubs — check the spec names and config (`*.real-api.*`, `E2E_BASE_URL`, `storageState`) first; a spec
that hits a real backend will do so again. `--traces <dir>` reuses traces from an earlier run.
- Report how many screens got images, and that data shown is whatever the stub/test backend returned
  (skeletons mean that endpoint has no stub).

The plugin draws a screenshot in place of the outline when `screenshot` is present.

Save the login script as `~/Desktop/hld-for-existing-code/<project>/seed-login.js` so the next run reuses it.

## Step 3c — Descriptions (screens and flows)

Write what each screen is for and what each journey covers **in Thai** (the team's language — keep route
names, component names, API paths and technical terms such as stub, API, token in English as they appear in
the code), unless the user asks for another language. Put them in a separate file so regenerating the bundle
keeps them:

```json
{ "journeys": { "<journey>": "…" }, "screens": { "<route>": "…" } }
```

Base every sentence on the bundle (elements, actions → goesTo, apis) and the source; when a description rests
on branching logic (which state leads where), read that code first. Say "placeholder" / "unreachable" when
that is what the code shows. Then merge:

```bash
node <skill-dir>/scripts/annotate.mjs <bundle.json> <descriptions.json>
```

It reports routes without a description and description keys that no longer match a route. The plugin shows
screen descriptions under each screen's title and journey descriptions at the top of each journey box.

## Step 3d — API examples (request + response per endpoint)

`capture.mjs` records every API call the app makes while browsing: the real request body and response become
that endpoint's example (`captured`). Fill the rest from the project's mock server and from the types:

```bash
node <skill-dir>/scripts/examples.mjs <bundle.json> --project <appDir> [--stubby <stub yaml|dir>]
```

`--stubby` reads stubby4j mappings (url → response `file`/`body`, `post`/`json` → request). Anything still
missing gets a skeleton from the request/response TypeScript type (`type`). Every example carries its source;
never present a type skeleton or a stub file as real traffic. The plugin puts one card per endpoint on a
separate "API · <project>" page (request, response, source, which screens call it), and each screen's API
rows link to those cards.

## Personal data

The board is shared, so treat everything that goes into `bundle.json` as public within the team.

- Capture against a local stub/mock by default. `capture.mjs` refuses a non-localhost `--base-url` or a
  `--storage-state` login unless `--allow-real-data` is passed — pass it only when the user explicitly asks
  and confirms the board may show that environment's real data. Screenshots cannot be masked.
- A local dev server can still call a real backend (environment file / `.env` / proxy pointing at SIT or
  prod). Without `--allow-real-data`, capture blocks every off-machine XHR/fetch; if one of them is the app's
  own API it stops (exit 3) before capturing or clicking anything and names the host. Fix the app's API
  target to the local stub rather than reaching for `--allow-real-data`.
- API examples (captured traffic and stub files) are masked automatically — when stored, when carried over
  by a re-run, and again when the Figma plugin or `html.mjs` renders them: names, citizen ID / phone numbers,
  emails, addresses, birth dates, tokens (by key name and by value shape). Cards say "personal data masked".
  Never paste raw payloads into descriptions or the report to work around this.
- Never copy real tokens or `--storage-state` files into `~/Desktop/hld-for-existing-code/<project>/`.

## Step 4 — Output: Figma board and/or HTML page

Two renderers read the same `bundle.json`. Produce what the user chose in Step 0.

**HTML** (chosen HTML or Both):

```bash
node <skill-dir>/scripts/html.mjs ~/Desktop/hld-for-existing-code/<project>/bundle.json
```

It writes `~/Desktop/hld-for-existing-code/<project>/board.html` — one self-contained file (screenshots embedded):
an overview (totals + every journey as a one-row mini flow), one page per journey (flow with arrows,
compact cards), a detail drawer per screen/API (screenshot, Thai description, goes to / comes from, API
examples), an API table, search, light/dark, browser back/forward. Opens in any browser; shareable as a file. Do not publish it anywhere (it describes an
internal app) unless the user asks.

**Figma** (chosen Figma or Both). Figma cannot be driven from here; the user imports the bundle. Tell them:

1. One time: Figma **desktop app** → Plugins → Development → **Import plugin from manifest…** →
   `~/Desktop/hld-for-existing-code/figma-plugin/manifest.json` (`hld-for-existing-code.mjs` keeps this copy in sync with the skill on
   every run, so the import never needs repeating; it is outside hidden `~/.claude`, so the picker shows it)
2. Plugins → Development → **HLD for existing code** → **Choose file…** (the bundle path) or paste the JSON →
   **Generate**.

Re-running replaces only what the plugin drew before; anything drawn by hand stays.

## Step 5 — Report

Summarize for the user: the full path of each output produced (`board.html`, `bundle.json` for Figma), how many screens have real screenshots vs outlines (and why the rest could not be
reached), screens and journeys found, the main flows, how many endpoints, and every warning
that matters (unmatched navigations, screens with no UI found, unresolved URLs) — say plainly what the
board does not show rather than implying it is complete.

## What the analyzer understands

**Next.js** — App Router `app/**/page.*` (route groups, `[id]`, `[...slug]`; private `_x`, parallel `@x`
and intercepting routes skipped), Pages Router `pages/**` (minus `_app`, `_document`, `api/`), thin page
wrappers that re-export a screen from elsewhere, the screen's own local components two imports deep,
`router.push/replace`, `redirect()`, `<Link href>`, project helpers named like `navigateTo`/`goToX`,
`window.location`, React Query `useQuery`/`useMutation` hooks (mutations are attributed to the action that
calls `mutate`), axios instances (`axios.create({ baseURL })`), `fetch`, `metadata.title`.

**Angular** — `RouterModule.forRoot/forChild`, `provideRouter`, `children`, `loadChildren` (NgModule or
routes file), `loadComponent`, `redirectTo`, `title`/`data.title`; layout shells with `<router-outlet>` are
skipped; `templateUrl`/inline templates, local child components by selector, `(event)` / custom `@Output`
bindings, `routerLink`, `router.navigate([...])` incl. `relativeTo`, `navigateByUrl`, `Location.back()`,
constructor and `inject()` DI, `HttpClient` calls in services, URL building from `environment.*` and
constant objects (including `url + "/x"` concatenations), `@for`/`*ngFor`, `'key' | translate`.

**Both** — string/constant/enum resolution across files, tsconfig `paths` aliases, request/response field
names from `interface`/`type`/model classes, `localStorage`/`sessionStorage`/`cookies()` keys, i18n JSON
under `locales/`, `i18n/`, `assets/`.

## Known limitations

- Regex and bracket matching, not the TypeScript compiler: unusual formatting can hide a call.
- Name-based call graph: two unrelated functions with the same bare name in different files are merged
  unless the call site imports one of them explicitly.
- Wireframes are an ordered outline (no real positions or CSS), capped at 18 elements — use capture.mjs for
  the real page. Screens that need router state or data from a previous step cannot be captured by URL alone.
- Arrows are drawn only inside a journey and only between neighbouring columns; everything else is still a
  clickable GOES TO row.
- Not covered yet: Vue/Nuxt, Remix, React Router config objects, GraphQL, server actions.
