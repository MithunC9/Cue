# Cue

A private, real-time meeting copilot for Windows + Zoom. A small dark-glass overlay listens to the call (your mic as **ME**, Zoom's audio as **THEM**), knows your project from your own notes and code, and shows short answers you can glance at in under two seconds, with sources cited. It stays out of your Zoom screen share.

Built for one person's use (a microCT research update with Cornell's SCALE Lab), with Gemini as the model provider.

> **Status: Phase 1 of 8.** The overlay, hotkeys, tray, screen-share hiding check and type-a-question are done. Knowledge prep, screenshots, live audio, auto question detection, slides, session logs and the installer come in later phases (see [Roadmap](#roadmap)).

---

## ⚠️ Read this first: free-tier Gemini key

Cue works with a free Gemini API key, with two trade-offs you should know about.

**1. Privacy.** On the free tier, Google may use your prompts and responses to improve its products, and human reviewers may read them. Cue sends your questions, transcript snippets and pieces of your notes to Gemini. That's **unpublished lab data**. Before you put lab material through a free key, consider asking your professor whether that's OK, or turn on billing for the key (paid usage isn't used for training). Switching later is one line: `gemini.tier: paid` in `config.yaml`.

**2. Limits.** Free keys get a small number of requests per model per day (counted per Google Cloud project, reset at midnight Pacific). Google no longer publishes the exact numbers. Third-party measurements suggest roughly **20 requests/day for Flash models** and **~500/day for Flash-Lite**. Cue handles this by:

- keeping its own per-model request budget (`gemini.quotas` in `config.yaml`; put your real numbers from [AI Studio](https://aistudio.google.com) → *Usage & limits*),
- falling back through a chain of models when one runs out (`gemini-3.6-flash` → `gemini-3.8-flash` → `gemini-3.5-flash-lite`). Each model has its own free quota.
- showing what's left in the status bar (`brain 3/20`, or `brain →3.8-flash 1/20` after a fallback),
- skipping explicit context caching (not available on free keys) and sending only the relevant notes per question (Phase 2),
- filtering locally before any classifier call, so a 45-minute meeting doesn't burn the budget (Phase 5).

**3. Latency.** Measured with a free key on Oct 21, 2026: answer cards took **8–17 s to start streaming**. Google queues free-tier requests under load, and `gemini-3.8-flash` returned "high demand" errors at the same time. A tiny prompt came back in 1.6 s, so it varies a lot. The < 1.5 s first-token target realistically needs a paid key. On the free tier, Cue will lean on instant local matches against your prepared `qa_bank.md` (Phase 2), so anticipated questions show an answer immediately while Gemini catches up.

**Don't run prep and test answers the morning of the meeting.** Prep uses several BRAIN requests. Run it the day before, then let the quota reset overnight.

---

## Setup (Windows)

You need **Windows 10 version 2004 (build 19041) or newer** (Windows 11 recommended), **[Node.js 22 LTS](https://nodejs.org)** and **[Git](https://git-scm.com/download/win)**. Nothing needs Visual Studio Build Tools or Python. Every dependency ships prebuilt Windows binaries.

```powershell
# 1. Check your Windows version (Cue adapts features to the build number)
[System.Environment]::OSVersion.Version
winver

# 2. Get the code
git clone https://github.com/MithunC9/Cue.git
cd Cue
git checkout claude/affectionate-turing-z9iu1n
npm install

# 3. API key: get one at https://aistudio.google.com/apikey
copy .env.example .env
notepad .env          # paste the key after GEMINI_API_KEY=

# 4. Run
npm run dev
```

On first run Cue stores an encrypted copy of the key (Windows DPAPI via Electron `safeStorage`, tied to your Windows account). Once the overlay says *"API key saved encrypted"*, you can delete the key from `.env`. You can also skip `.env` entirely: tray icon → **Set API key…**.

The overlay appears at the top-right of your primary monitor. Cue has no taskbar button; look for the round blue icon in the system tray (you may need the **^** overflow arrow).

### What your Windows build unlocks

| Feature | Needs |
|---|---|
| Hidden from screen share / screenshots (`WDA_EXCLUDEFROMCAPTURE`) | Windows 10 2004, build 19041+ (older builds show a black box instead) |
| Acrylic glass background | Windows 11 22H2, build 22621+ (otherwise plain translucent) |
| Zoom-only audio capture (Phase 4 upgrade path) | build 20348+ / any Windows 11 |

---

## Hotkeys

All configurable in `config.yaml`. If any fails to register (another app already owns it), the overlay says so at the top.

| Key | Action |
|---|---|
| **Ctrl+Alt+Enter** | Answer now (uses the last ~45 s of transcript) |
| **Ctrl+Alt+S** | Screenshot + answer *(Phase 3)* |
| **Ctrl+Alt+H** | Hide / show overlay |
| **Ctrl+Alt+L** | Pause / resume listening *(Phase 4)* |
| **Ctrl+Alt+Shift+arrows** | Move overlay (can slide onto another monitor) |
| **Ctrl+Alt+K** | Clear card and notices |
| **Ctrl+Alt+T** | Type mode: type a question, **Enter** to ask, **Esc** returns focus to Zoom |
| **Ctrl+Alt+P** | Presentation mode *(Phase 6)* |
| **Ctrl+Alt+M** | Click-through on/off (off = you can click the overlay) |

The defaults avoid Zoom's Windows shortcuts (Alt+key, Alt+Shift+key), VS Code's Ctrl+Shift+P and Ctrl+Shift+arrows, and Ctrl+Alt+arrows (screen rotation on some graphics drivers). One known overlap: in VS Code's find widget, Ctrl+Alt+Enter is *Replace All*. While Cue runs, the hotkey goes to Cue.

**Moving the overlay with the mouse:** grab the **⋮⋮** handle at the top-left. It stays grabbable even in click-through mode; the rest of the panel lets clicks pass through to Zoom.

**Focus:** the overlay never takes focus from Zoom or PowerPoint. The only exception is type mode (Ctrl+Alt+T); after you press Enter or Esc, focus goes back to the window you were in.

---

## Verify it's hidden from your Zoom share (do this before the meeting)

Windows can exclude a window from screen capture (`SetWindowDisplayAffinity` with `WDA_EXCLUDEFROMCAPTURE`, which Electron's `setContentProtection(true)` turns on). Most capture tools respect it (Win+Shift+S, the Snipping Tool, OBS, and Zoom in most of its capture modes), but check on your own machine:

1. **Built-in self-test:** tray icon → **Test screen-share hiding**. The overlay flashes magenta for half a second while Cue screenshots your monitor through the same Windows capture APIs, and then reports **PASS** or **FAIL**.
2. **Zoom:** start a meeting with a second device or a friend as a test participant. **Share Screen → Screen** (full screen, not a window). Ask them (or check the second device) whether the overlay is visible. It shouldn't be.
3. **Win+Shift+S:** take a full-screen snip. The overlay shouldn't be in it.
4. **Recording:** record a few seconds with **OBS** (Display Capture) or the **Snipping Tool's** video mode. The overlay shouldn't appear.

### If the overlay shows up in Zoom

- **Zoom Settings → Share Screen → Advanced → Screen capture mode.** Try each option, re-test after each, and keep the one that hides Cue. Start with *Advanced capture without window filtering*, then *Advanced capture with window filtering*, then *Automatic*. *Legacy operating systems* mode is the one most likely to ignore the exclusion.
- **Share only the PowerPoint window** (Share Screen → pick the PowerPoint slideshow window, not "Screen"). A window share never includes other windows, so Cue can't appear no matter what.
- Make sure Windows is build 19041 or newer. On older builds Windows draws a black box where Cue is.
- In the self-test result, `display affinity = EXCLUDEFROMCAPTURE` means Windows accepted the request. If it says anything else, open an issue with the log (tray → *Open log folder*).

---

## Configuration (`config.yaml`)

- **Windows paths:** use single quotes, e.g. `'C:\Users\Mithun\My Repo'`. In double quotes YAML treats `\` as an escape. `%USERPROFILE%` and other `%VARS%` work.
- `meeting`: who you're meeting and the topic (used in the prompts).
- `sources` / `keywords`: what to learn from (Phase 2).
- `gemini.models`: every model ID lives here so you can swap them.
- `gemini.quotas`: your free-tier request budgets per model.
- `ui`: width, corner, which monitor (`primary`, `cursor`, or `1`, `2`, …), material (`auto`, `acrylic`, `mica`, `translucent`), font size.

After editing: tray → **Reload config.yaml** (hotkeys re-register too).

### Models (as of October 2026)

| Role | Default | Notes |
|---|---|---|
| BRAIN | `gemini-3.6-flash` | Answers + prep. Streams; `low` thinking live, `high` for prep. Google now lists 3.6 as "legacy, migration recommended" to `gemini-3.8-flash`, which is first in the fallback chain. Swap the order if you prefer 3.8. |
| FAST | `gemini-3.5-flash-lite` | Question detector and slide matcher; minimal thinking. |
| EARS | `gemini-3.5-transcribe-live` | Live API transcription-only model: text out, never audio, interim + final transcripts. `gemini-3.1-flash-live-preview` is now a legacy native-audio *dialog* model that always answers out loud, so it can't do transcription-only cleanly. |

Cue uses `generateContent` (stateless) rather than the newer Interactions API, which stores conversations server-side by default.

---

## Troubleshooting

- **"Hotkeys not registered: …"**: another app owns that combination. Change it in `config.yaml` and reload.
- **Overlay hidden behind the PowerPoint slideshow**: Cue re-asserts "always on top" every 3 s. If it still hides, press Ctrl+Alt+H twice.
- **Panel looks flat gray instead of glass**: Windows draws acrylic in its "inactive" style because the overlay never takes focus. Set `ui.material: translucent`.
- **"Out of free-tier budget"**: every model in the chain is used up or rate-limited. The status bar shows when. Wait for the minute window, or for midnight Pacific for daily limits.
- **Logs**: tray → *Open log folder* (`%APPDATA%\Cue\logs\cue.log`). API keys are redacted from logs.

---

## Privacy

- The API key lives in `.env` or encrypted in `%APPDATA%\Cue\gemini-key.bin`. It's never logged and only sent to Google.
- `knowledge\` and `sessions\` are git-ignored. Everything stays on your PC except the Gemini API calls.
- The ● Listening indicator in the overlay and the red dot on the tray icon are on whenever audio is captured (Phase 4).

---

## Roadmap

1. ✅ Scaffold, overlay window, hotkeys, screen-share hiding check, type mode with a plain BRAIN call
2. Prep pipeline: `npm run prep` → `brief.md`, `qa_bank.md`, `gaps.md` + local retrieval index; type mode answers from your notes with citations
3. Screenshot + answer
4. Mic + Zoom audio → live ME/THEM transcript
5. Auto question detection → answer cards
6. Presentation mode (slide tracking + talking points)
7. Session logging + `npm run debrief`
8. Polish + `npm run build` → Windows installer / portable `.exe`

## Development

```powershell
npm run dev        # run with hot reload
npm run typecheck
npm test           # unit tests (config, quota/fallback, streaming)
```

Code layout: `src/main` (Electron main: overlay, hotkeys, Gemini), `src/preload` (IPC bridge), `src/renderer` (React overlay UI), `src/prep` (knowledge prep, Phase 2), `src/shared` (types).
