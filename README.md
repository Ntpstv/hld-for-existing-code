# HLD for existing code

Claude Code plugin that turns an existing **Next.js** or **Angular** web app into an HLD board — every screen
with a real screenshot, a Thai description of each screen and flow, where each button goes, and every API call
with example request/response — as a **Figma board**, a **single HTML page**, or both.

**[English](#english) · [ภาษาไทย](#ภาษาไทย)** · **[Feedback form](https://forms.gle/4FMT8aunDmMzGRXg9)**

---

## English

### 0. Requirements

- **Claude Code**
- **Node.js 18+** (`node -v`)
- **Figma desktop app** — only for the Figma output. Figma in the browser cannot load local plugins.
- For real screenshots: the app must **run on your machine** (`ng serve`, `npm run dev`, …). A stub/mock server is
  optional — see step 4.

### 1. Install (once)

In Claude Code:

```
/plugin marketplace add Ntpstv/hld-for-existing-code
/plugin install hld-for-existing-code@hld-for-existing-code
```

Start a new session; `hld-for-existing-code` appears when you type `/`.

### 2. Generate an HLD

```
ทำ HLD ให้ ~/projects/my-angular-app
```

or `/hld-for-existing-code` followed by the app folder (the one with `package.json`).

Claude first asks which output you want — **Figma**, **HTML** or **both**. Then it:

1. **Analyses the code** — every screen, which button leads where, which API each screen calls
2. **Captures real screenshots** — works out how to run the app from `package.json` / Playwright config; if it
   can't, it tells you what is missing
3. **Writes a Thai description** of every screen and journey
4. **Adds example request/response** for every API, personal data masked
5. **Reports** — screens found, how many have real screenshots, warnings, and the path of every output

### 3. Output

```
~/Desktop/web-hld/
├── figma-plugin/            ← the Figma plugin (created automatically)
└── <project>/
    ├── bundle.json          ← import this in Figma
    ├── board.html           ← open in any browser
    ├── descriptions.json    ← screen/flow descriptions, editable
    └── screenshots/
```

Everything stays outside your project repo.

### 4. No stub server?

Tell Claude the project has no stub. It will pick one of:

- **Replay** (most realistic) — record a dev/SIT backend **once**, only with your permission. Personal data is
  masked before anything is saved; later captures run offline from the recording.
- **Mock** — fake data generated from the TypeScript types, no backend at all. Services without a declared
  response type return empty data, so their lists stay empty.
- **No Playwright?** Claude can use your installed Google Chrome, or install Playwright into the skill once
  (~150 MB download, asks first).

### 5. HTML board

Double-click `~/Desktop/web-hld/<project>/board.html`.

- Left menu: overview, each journey, API
- Click any screen or API for details: large screenshot, goes to / comes from, request/response examples
- Search, light/dark theme; a single file you can send to anyone

### 6. Figma board (Figma desktop app only)

**Install the plugin (once)**

1. Open the **Figma desktop app** and any Figma file
2. Menu → **Plugins → Development → Import plugin from manifest…**
3. Choose `~/Desktop/web-hld/figma-plugin/manifest.json`
   - This folder is created by your first HLD run (step 2).
   - It refreshes itself on every run — never re-import.

**Draw the board (each time)**

1. Open the Figma file to draw in (a new page is a good idea)
2. Menu → **Plugins → Development → HLD for existing code**
3. **Choose file…** → `~/Desktop/web-hld/<project>/bundle.json`
4. **Generate**

You get the board on the current page (screen cards, flow arrows, GOES TO and API panels) and a new
**"API · <project>"** page with one card per endpoint. GOES TO / API rows are clickable links. Generating again
replaces the previous board; anything you drew by hand stays.

### 7. After the code changes

- Run `ทำ HLD ให้ <path>` again — screenshots, descriptions and API examples are kept — then **Generate** again
  in Figma or reopen `board.html`.
- Update the plugin: `/plugin marketplace update hld-for-existing-code`

### ⚠️ For users: before you capture or share

1. **Never capture from SIT / production without permission from whoever owns that data.** The skill stops by
   itself when the app talks to a real server, but `--allow-real-data` (or answering "yes" when Claude asks)
   lets it through. Screenshots cannot be masked — whatever real data the screen shows goes onto the board.
2. **Check the API page before sharing the board.** Personal data in API examples (names, ID/phone numbers,
   emails, addresses, tokens…) is masked by field name and value pattern. A field with an unusual name can
   still slip through.

### Feedback

Used it on a project? Please spend two minutes on the form — accuracy scores, how much time it
saved, and anything that slipped through the masking go straight into the next version:
[https://forms.gle/4FMT8aunDmMzGRXg9](https://forms.gle/4FMT8aunDmMzGRXg9)

---

## ภาษาไทย

### 0. สิ่งที่ต้องมี

- **Claude Code**
- **Node.js 18 ขึ้นไป** (เช็กด้วย `node -v`)
- **Figma desktop app** — เฉพาะถ้าจะเอา output แบบ Figma (Figma บนเว็บเบราว์เซอร์ import plugin ไม่ได้)
- ถ้าจะแคปรูปหน้าจอจริง ต้อง**รันแอปในเครื่องได้** (`ng serve`, `npm run dev` ฯลฯ) มี stub/mock หรือไม่มีก็ได้ (ดูข้อ 4)

### 1. ติดตั้ง (ครั้งเดียว)

ใน Claude Code:

```
/plugin marketplace add Ntpstv/hld-for-existing-code
/plugin install hld-for-existing-code@hld-for-existing-code
```

เปิด session ใหม่ แล้วพิมพ์ `/` จะเห็น `hld-for-existing-code`

### 2. สั่งทำ HLD

```
ทำ HLD ให้ ~/projects/my-angular-app
```

หรือ `/hld-for-existing-code` ตามด้วย path ของแอป (โฟลเดอร์ที่มี `package.json`)

Claude จะ**ถามก่อนว่าต้องการ output แบบไหน** — **Figma**, **HTML** หรือ **ทั้งคู่** แล้วทำตามลำดับ:

1. **วิเคราะห์โค้ด** — หน้าจอทั้งหมด, ปุ่มไหนไปหน้าไหน, แต่ละหน้าเรียก API อะไร
2. **แคปรูปหน้าจอจริง** — หาวิธีรันแอปเองจาก `package.json` / Playwright config ถ้ารันไม่ได้จะบอกว่าติดอะไร
3. **เขียนคำอธิบายภาษาไทย** ของแต่ละหน้าและแต่ละ flow
4. **เติมตัวอย่าง request/response** ของทุก API (ปิดข้อมูลส่วนบุคคลแล้ว)
5. **สรุปผล** — จำนวนหน้าจอ, กี่หน้าได้รูปจริง, คำเตือน และ path ของไฟล์ที่ได้

### 3. ไฟล์ที่ได้

```
~/Desktop/web-hld/
├── figma-plugin/            ← plugin สำหรับ Figma (สร้างให้อัตโนมัติ)
└── <ชื่อโปรเจกต์>/
    ├── bundle.json          ← ไฟล์ที่ใช้ใน Figma
    ├── board.html           ← เปิดในเบราว์เซอร์ได้เลย
    ├── descriptions.json    ← คำอธิบาย แก้เองได้
    └── screenshots/
```

ทุกอย่างอยู่นอก repo ของโปรเจกต์

### 4. ถ้าไม่มี stub server

บอก Claude ได้เลยว่าไม่มี stub Claude จะเลือกวิธีให้:

- **Replay** (สมจริงที่สุด) — อัดจาก dev/SIT **ครั้งเดียว** ต้องได้รับอนุญาตก่อน ข้อมูลส่วนบุคคลถูกปิดก่อนบันทึก
  ครั้งต่อไปแคปแบบ offline จากไฟล์ที่อัดไว้
- **Mock** — สร้างข้อมูลปลอมจาก TypeScript type ไม่ต้องมี backend เลย แต่ service ที่ไม่ได้ประกาศ response type
  จะได้ข้อมูลว่าง รายการในหน้าจอจะว่าง
- **ไม่มี Playwright** — ใช้ Google Chrome ที่มีในเครื่อง หรือให้ Claude ติดตั้ง Playwright ไว้ใน skill ครั้งเดียว
  (ดาวน์โหลดประมาณ 150 MB ถามก่อนเสมอ)

### 5. เปิดแบบ HTML

ดับเบิลคลิก `~/Desktop/web-hld/<ชื่อโปรเจกต์>/board.html`

- เมนูซ้าย: ภาพรวม, แต่ละ journey, API
- คลิกหน้าจอหรือ API เพื่อดูรายละเอียด: รูปใหญ่, ไปต่อที่ไหน, เข้ามาจากไหน, ตัวอย่าง request/response
- มีช่องค้นหาและสลับธีมสว่าง/มืด เป็นไฟล์เดียว ส่งให้ใครเปิดก็ได้

### 6. เปิดใน Figma (ใช้ได้เฉพาะ Figma desktop app)

**ติดตั้ง plugin (ครั้งเดียว)**

1. เปิด **Figma desktop app** แล้วเปิดไฟล์ Figma ไหนก็ได้
2. เมนู → **Plugins → Development → Import plugin from manifest…**
3. เลือก `~/Desktop/web-hld/figma-plugin/manifest.json`
   - โฟลเดอร์นี้ถูกสร้างหลังรัน HLD ครั้งแรก (ข้อ 2)
   - plugin อัปเดตตัวเองทุกครั้งที่รัน ไม่ต้อง import ใหม่

**สร้าง board (ทุกครั้ง)**

1. เปิดไฟล์ Figma ที่จะวาด (แนะนำให้สร้าง page ใหม่)
2. เมนู → **Plugins → Development → HLD for existing code**
3. กด **Choose file…** → เลือก `~/Desktop/web-hld/<ชื่อโปรเจกต์>/bundle.json`
4. กด **Generate**

จะได้ board บน page ปัจจุบัน (การ์ดหน้าจอ, ลูกศร flow, ช่อง GOES TO และ API) และ page ใหม่
**"API · <ชื่อโปรเจกต์>"** ที่มีการ์ดละ endpoint ลิงก์ใน GOES TO และ API คลิกกระโดดไปได้ กด Generate ซ้ำจะแทนที่ board เดิม
ส่วนที่วาดเองด้วยมือจะไม่ถูกลบ

### 7. อัปเดตเมื่อโค้ดเปลี่ยน

- สั่ง `ทำ HLD ให้ <path>` ใหม่ — รูป คำอธิบาย และตัวอย่าง API เดิมจะถูกเก็บไว้ — แล้วกด **Generate** ใน Figma ใหม่
  หรือเปิด `board.html` ใหม่
- อัปเดต plugin: `/plugin marketplace update hld-for-existing-code`

### ⚠️ สำหรับผู้ใช้: ก่อนแคปหรือแชร์

1. **ห้ามแคปจาก SIT / production โดยไม่ได้รับอนุญาตจากเจ้าของข้อมูล** skill จะหยุดเองเมื่อแอปคุยกับ server จริง
   แต่ถ้าใส่ `--allow-real-data` (หรือตอบ "ได้" ตอน Claude ถาม) จะผ่านไปได้ รูปหน้าจอปิดข้อมูลไม่ได้
   ข้อมูลจริงที่อยู่บนหน้าจอจะติดไปอยู่ใน board
2. **ตรวจ page API ก่อนแชร์ board** ข้อมูลส่วนบุคคลในตัวอย่าง API (ชื่อ, เลขบัตร, เบอร์โทร, อีเมล, ที่อยู่, token ฯลฯ)
   ถูกปิดตามชื่อ field และรูปแบบค่า field ที่ตั้งชื่อแปลกๆ อาจหลุดได้

### Feedback

ถ้าลองใช้กับโปรเจกต์แล้ว รบกวนตอบแบบสอบถามสั้นๆ (ประมาณ 2 นาที) ทั้งคะแนนความถูกต้อง เวลาที่ประหยัดได้
และข้อมูลที่หลุดจากการปิดข้อมูล จะถูกนำไปปรับรุ่นถัดไป:
[https://forms.gle/4FMT8aunDmMzGRXg9](https://forms.gle/4FMT8aunDmMzGRXg9)

---

## Supported

| | Supported | Not yet |
|---|---|---|
| **Frameworks** | **Next.js** (App Router, Pages Router) · **Angular** (NgModule and standalone) | Vue / Nuxt, Remix, React Router (Vite SPA), Svelte |
| **Languages** | **TypeScript**, **JavaScript** (`.ts` `.tsx` `.js` `.jsx` `.mjs`), JSX/TSX and Angular HTML templates | — |
| **API calls** | axios (incl. `axios.create`), `fetch`, React Query (`useQuery` / `useMutation`), Angular `HttpClient` | GraphQL, Next.js server actions |
| **UI libraries recognised** | plain HTML, PrimeNG, Angular Material, Ionic | — |
| **Labels (i18n)** | `t("key")`, `'key' \| translate`, JSON files under `locales/` `i18n/` `assets/` — Thai preferred, English fallback | — |
| **Descriptions written by Claude** | Thai by default (other languages on request) | — |
| **Output** | Figma board (Figma desktop app) · single-file HTML page | — |
| **Runs on** | Node 18+ · macOS (tested) · Linux (untested) | Windows: `e2e-shots.mjs` needs `unzip` |

Tested on Angular 19 (52 screens, 68 endpoints) and Next.js 15 App Router. Mobile apps (iOS / Android) are out of
scope.

## For maintainers

- Bump `version` in `plugins/hld-for-existing-code/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`,
  push; users run `/plugin marketplace update hld-for-existing-code`.
- `sync-from-personal.sh` copies a personal copy (`~/.claude/skills/hld-for-existing-code`) into this plugin and
  rewrites its paths.

```
.claude-plugin/marketplace.json
plugins/hld-for-existing-code/
├── .claude-plugin/plugin.json
└── skills/hld-for-existing-code/        SKILL.md, README.md, scripts/, figma-plugin/
```
