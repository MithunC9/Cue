# Cue

A private, real-time meeting copilot for **Windows + Zoom**. A small dark-glass overlay listens to the call (your mic as **ME**, Zoom's audio as **THEM**), knows your project from your own code, notes, slides and AI chat history, follows your slides, and shows short, grounded answers with sources when you're asked something. It stays out of your Zoom screen share.

Built for one person's use: a microCT research update with Cornell's SCALE Lab. Gemini is the model provider.

```
┌──────────────────────────────────────────┐
│ ⋮⋮ Cue  PRESENTING          ▬▬ ● Listening│
│ THEM …how did you validate the segmentation│
│      against ground truth?                │
│ ME   Sure, so I compared my masks with…   │
├──────────────────────────────────────────┤
│ HEARD How did you validate the segmentation│
│ PREPARED · live answer coming…            │
│ **I compared my masks to 20 manually      │
│   traced slices: Dice 0.91.**             │
│ • Lab tech traced the slices, not me      │
│ • Per-slice Otsu after Gaussian σ = 1.0   │
│ ↳ If pushed: top slices are darker (beam  │
│   hardening), so one global threshold…    │
│ sources: lab notes/lab_notebook.docx:1-5  │
├──────────────────────────────────────────┤
│ SLIDE 3/5 Segmentation                    │
│ • … 3 talking points · Likely Q → answer  │
├──────────────────────────────────────────┤
│ ● 7.1s  brain 3/20  fast 4/500  free tier │
└──────────────────────────────────────────┘
```

---

## ⚠️ Read this first: free-tier Gemini key

Cue works with a free key, with three trade-offs.

**1. Privacy.** On the free tier Google may use your prompts and responses to improve its products, and human reviewers may read them. Cue sends questions, transcript snippets and pieces of your notes to Gemini, and that is **unpublished lab data**. Consider asking your professor whether that's OK, or turn on billing for the key (paid usage isn't used to train models). Switching is one line: `gemini.tier: paid` in `config.yaml`.

**2. Limits.** Free keys get a small number of requests per model per day (per Google Cloud project, reset at midnight Pacific). Google no longer publishes the numbers; third-party measurements suggest about **20/day for Flash models** and **~500/day for Flash-Lite**. Explicit context caching is **not available** on free keys (verified: the free cache limit is 0 tokens). Cue copes by:
- keeping its own per-model budget (`gemini.quotas`; put your real numbers from [AI Studio](https://aistudio.google.com) → Usage & limits),
- falling back `gemini-3.6-flash` → `gemini-3.8-flash` → `gemini-3.5-flash-lite` when a model is out of quota or overloaded (each has its own free quota),
- retrieving only the relevant notes for each question (local search plus embeddings) instead of caching everything,
- deciding locally whether something was a question, calling the FAST classifier only for unclear lines,
- showing what's left in the status bar (`brain 3/20`, or `brain →3.8-flash 1/20` after a fallback).

**3. Latency.** Measured with your key on Oct 21, 2026: live answers took **7–40 s to start**, and for much of the afternoon `gemini-3.6-flash` and `gemini-3.8-flash` answered "503 overloaded", so most answers came from `gemini-3.5-flash-lite`. A tiny prompt came back in 1.6 s, so it varies a lot. If a model is silent for 12 s, Cue moves on to the next one (`gemini.first_token_timeout_ms`). The < 1.5 s target realistically needs a paid key. On the free tier Cue covers the wait:
- **Prepared answers.** A question that matches your `qa_bank.md` by words or by meaning shows the prepared answer **instantly** (measured 0.3 s), then the live answer replaces it.
- **"From your notes."** For other questions, the 1–2 most relevant lines from your notes show at once, with sources.
- **Presentation mode** uses talking points written during prep, so it makes no API calls during the meeting.

**Run prep the day before**, not the morning of the meeting: it uses several requests, and quotas reset at midnight Pacific.

---

## Setup (Windows)

Requirements: **Windows 10 version 2004 (build 19041) or newer** (Windows 11 recommended), **[Node.js 22 LTS](https://nodejs.org)**, **[Git](https://git-scm.com/download/win)**. No Visual Studio Build Tools or Python are needed: every native piece ships prebuilt (koffi for a few Windows calls, WebAssembly OCR).

```powershell
# 1. Check your Windows version (Cue adapts to the build number)
[System.Environment]::OSVersion.Version
winver

# 2. Get the code
git clone https://github.com/MithunC9/Cue.git
cd Cue
git checkout claude/affectionate-turing-z9iu1n
npm install

# 3. API key (https://aistudio.google.com/apikey)
Set-Content .env "GEMINI_API_KEY=<your key>" -Encoding ascii

# 4. Run
npm run dev
```

On first run Cue also stores an encrypted copy of the key (Windows DPAPI via Electron `safeStorage`). After the overlay says *"API key saved encrypted"* you can delete `.env`. You can also skip `.env`: tray icon → **Set API key…**.

The overlay appears top-right on your primary monitor. There's no taskbar button; look for the round blue icon in the system tray (maybe under the **^** arrow). Right-click it for everything.

### Windows settings
- **Microphone access:** Settings → Privacy & security → **Microphone** → turn on *Microphone access* and **Let desktop apps access your microphone**.
- **Sound output:** Cue hears Zoom by capturing everything Windows plays on the default output device. In Zoom → Settings → **Audio** → Speaker, choose **Same as System**. During the meeting, mute other apps (YouTube, Discord, notification sounds) or they'll be transcribed as THEM.
- **Headphones** are recommended. On speakers, set `audio.headphones: false` so Cue drops mic lines that just repeat the other side.

### What your Windows build unlocks

| Feature | Needs |
|---|---|
| Hidden from screen share / screenshots (`WDA_EXCLUDEFROMCAPTURE`) | Windows 10 2004, build 19041+ (older builds show a black box) |
| Acrylic glass background | Windows 11 22H2, build 22621+ (otherwise plain translucent) |
| Zoom-only audio capture (future upgrade, not built) | build 20348+ / Windows 11 |

---

## Before the meeting

1. **Fill in `config.yaml`**: `meeting` (professor's name, topic) and `sources` (repo, notes folder, slide deck, your Claude Code project folder). Use single quotes for Windows paths.
2. **Run prep** the night before: `npm run prep`, or tray → **Prepare knowledge**. It prints a token count, then writes to `knowledge\`:
   - `brief.md`: one page in first person: what you built vs. what existed, pipeline stages, design decisions and why (mined from your chat logs, with dates), real numbers with citations, what works, open problems, next steps toward Abaqus, glossary.
   - `qa_bank.md`: ~40 likely questions with 2–3-bullet answers and citations; ungrounded ones are marked **⚠️ UNVERIFIED**.
   - `gaps.md`: what you should know cold that your sources don't answer, with where to find it.
   - `slides_prep.json`: 3 talking points + the most likely question for each slide.
   - `manifest.json`: everything read, skipped and inventoried (raw DICOM/TIFF/AIM data is listed by folder, count and size, never read).

   Read all three files. Fix gaps, then run `npm run prep -- --only=qa` (or `--force` for everything) to refresh. `npm run prep -- --no-llm` only indexes and shows the token count, with no API calls.
3. **Check the screen-share hiding** (below).
4. **Rehearse with a friend** on Zoom: share your full screen, have them ask a few `qa_bank` questions and a curveball, and watch the cards.

### Verify Cue is hidden from your Zoom share
Windows can exclude a window from capture (`SetWindowDisplayAffinity` + `WDA_EXCLUDEFROMCAPTURE`, turned on by Electron's `setContentProtection(true)`). Win+Shift+S, the Snipping Tool, OBS and Zoom generally respect it, but check on your machine:

1. **Built-in self-test:** tray → **Test screen-share hiding**. The overlay flashes magenta for half a second while Cue screenshots the monitor through the same Windows capture APIs, then shows PASS or FAIL.
2. **Zoom:** in a test meeting, **Share Screen → Screen** (the full screen). Ask the other person whether they can see the overlay.
3. **Win+Shift+S:** full-screen snip.
4. **Recording:** a few seconds with OBS (Display Capture) or the Snipping Tool's video mode.

**If the overlay shows up in Zoom:**
- Zoom → Settings → **Share Screen → Advanced → Screen capture mode**. Try *Advanced capture without window filtering*, then *Advanced capture with window filtering*, then *Automatic*, re-testing each time. *Legacy operating systems* is the one most likely to ignore the exclusion.
- **Share only the PowerPoint window** instead of the whole screen. A window share never contains other windows.
- Windows must be build 19041+. The self-test reports the affinity Windows applied (`EXCLUDEFROMCAPTURE` is the good one).

---

## During the meeting

Press **Ctrl+Alt+L** to start listening (Cue also offers when it sees a Zoom meeting window). The header shows **● Listening** in red with two level meters (ME blue, THEM amber), and the tray icon gets a red dot.

| Key | Action |
|---|---|
| **Ctrl+Alt+Enter** | Answer now (uses the last ~45 s of transcript) |
| **Ctrl+Alt+S** | Screenshot + answer (what's on screen + transcript) |
| **Ctrl+Alt+H** | Hide / show overlay |
| **Ctrl+Alt+L** | Start / pause listening |
| **Ctrl+Alt+Shift+arrows** | Move overlay (can slide onto another monitor) |
| **Ctrl+Alt+K** | Clear card and notices |
| **Ctrl+Alt+T** | Type mode: type a question, **Enter** asks, **Esc** returns focus to Zoom |
| **Ctrl+Alt+P** | Presentation mode on/off |
| **Ctrl+Alt+M** | Click-through on/off |

All are configurable. They avoid Zoom's Windows shortcuts (Alt+key, Alt+Shift+key), VS Code's Ctrl+Shift+P and Ctrl+Shift+arrows, and Ctrl+Alt+arrows. Known overlap: in VS Code's find widget Ctrl+Alt+Enter is *Replace All*; while Cue runs, Cue gets it. Hotkeys that fail to register are listed at the top of the overlay.

**Auto-answer.** When the other side finishes a question (about a 1 s pause), a card appears on its own. Clear questions go straight to an answer. Unclear lines ("tell me more about…") are checked by FAST first. "Okay", "sounds good" and meeting logistics ("go back a slide", "you're on mute") are ignored. Follow-up sentences merge into one card. Toggle it in the tray.

**Answer cards** (≤ 70 words, first person):
```
**One-line answer you'd say first**
• 2–4 specifics (numbers, file/function names, methods)
↳ If pushed: one deeper point
sources: file paths
```
If your notes don't cover it, the first line is **Not in your notes** (amber), followed by an honest bridge ("I haven't tested that yet; my guess is X because Y; I'll follow up"). Cue keeps what you built separate from what the lab or others built.

**Presentation mode (Ctrl+Alt+P)** follows the slide on `presentation.display`. It uses a perceptual hash every 3 s and local OCR when the picture changes, asking FAST only when unsure. It shows that slide's 3 talking points and the most likely question with its prepared answer. Questions about the current slide use it first.

**The overlay never takes focus.** The only exception is type mode, which hands focus back to the window you were in. The **⋮⋮** handle moves it with the mouse even in click-through mode.

---

## After the meeting

Each meeting is logged in `sessions\YYYY-MM-DD_HHMM\`: `transcript.md` (timestamped ME/THEM lines, slide changes) and `answers.md` (every card, what triggered it, the model and latency). Screenshots are saved only if `sessions.save_screenshots: true`.

`npm run debrief` (or tray → **Debrief this meeting**) writes `debrief.md`: summary, action items and every follow-up you promised (with timestamps), questions you struggled with and what a strong answer needed, the professor's feedback, and suggested additions to `brief.md`.

---

## Models (October 2026)

| Role | Default | Why |
|---|---|---|
| BRAIN | `gemini-3.6-flash` (+ fallbacks `gemini-3.8-flash`, `gemini-3.5-flash-lite`) | Answers, prep, screenshots, debrief. Streams; `low` thinking live, `high` for prep. Google now lists 3.6 as "legacy, migration recommended" to 3.8. Swap them in `config.yaml` if you prefer. |
| FAST | `gemini-3.5-flash-lite` | Question classifier and slide matcher (minimal thinking, JSON output). |
| EARS | `gemini-3.5-transcribe-live` | Live API transcription-only model: text out, never audio; interim words every ~0.5 s, final ~0.4 s after you stop. `gemini-3.1-flash-live-preview` (your original pick) is now a legacy native-audio *dialog* model that always talks back, so it can't do transcription-only cleanly. Setting it as `ears` still works (its audio is discarded). |
| fallback EARS | `gemini-3.5-transcribe` | One request per utterance (~2 s), used only if Live fails repeatedly. |
| Embeddings | `gemini-embedding-001` | Matches questions to notes and prepared answers by meaning. |

Cue uses `generateContent` (stateless) rather than the newer Interactions API, which stores conversations server-side by default.

**Long meetings:** the Live API closes a connection after ~60 s without audio and caps connections at ~10 minutes (goAway ~9 min). Cue connects when someone starts talking, rotates connections between sentences, and if a connection drops mid-sentence it reconnects and replays that sentence. A 12-minute soak test crossed the 10-minute limit without losing a line.

---

## Building an installer

```powershell
npm run build
```
This writes `release\Cue Setup 0.1.0.exe` (installer) and `release\Cue-portable-0.1.0.exe` (single file). They're unsigned, so Windows SmartScreen will warn: click **More info → Run anyway**.

For the installed or portable app, `config.yaml`, `knowledge\` and `sessions\` live **next to Cue.exe** (or set the `CUE_HOME` environment variable). A default `config.yaml` is created on first run. Use tray → **Prepare knowledge** instead of `npm run prep`; no Node needed.

---

## Configuration reference (`config.yaml`)

| Section | What it controls |
|---|---|
| `meeting` | Your name, who you're meeting, topic (used in every prompt) |
| `sources`, `keywords` | What prep reads; keywords also filter chat logs and help transcription |
| `gemini` | Tier, model IDs and fallback chains, thinking levels, free-tier request budgets, prices (paid) |
| `knowledge` | Notes per question, instant prepared answers, embeddings |
| `auto_answer` | Auto cards on/off, when to ask FAST, merge window |
| `audio` | Live vs chunked transcription, language, extra vocabulary, mic, Zoom loopback, headphones |
| `presentation`, `screenshot` | Which monitor to follow / capture |
| `sessions` | Save screenshots |
| `ui` | Width, corner, monitor, material, font size, start in click-through |
| `hotkeys` | All shortcuts |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Microphone blocked" | Windows Settings → Privacy & security → Microphone → allow desktop apps. Pick the right mic in tray → Microphone. |
| THEM never shows up | Zoom → Audio → Speaker: **Same as System**; check the amber THEM meter moves when they talk; make sure Windows' default output device is what you're listening on. |
| ME and THEM duplicate each other | You're on speakers: set `audio.headphones: false`, or use headphones. |
| "transcription retrying" | Network or Live API hiccup; it reconnects by itself. If it persists, Cue switches to per-utterance transcription and says so. |
| Overlay visible in Zoom share | See *Verify Cue is hidden* above (Zoom capture mode, or share the PowerPoint window). |
| Overlay behind the slideshow | Cue re-asserts "always on top" every 3 s; press Ctrl+Alt+H twice. |
| "Out of free-tier budget" | Every model in the chain is used up; the status bar shows which. Wait for the minute window, or midnight Pacific. Prepared answers still work. |
| Answers slow | Free-tier queueing (see the latency note). Prepared/notes cards cover the wait; a paid key fixes it. |
| Slide not recognized | Set `presentation.display` to the monitor with the slideshow; make sure `sources.deck` is the same deck and prep ran after the last edit. |
| Panel looks flat gray | Windows draws acrylic in its inactive style because the overlay never takes focus: set `ui.material: translucent`. |
| A hotkey doesn't work | Another app owns it; the overlay lists it. Change it in `config.yaml` → tray → Reload config.yaml. |
| Logs | tray → Open log folder (`%APPDATA%\Cue\logs\cue.log`). API keys are redacted. |

---

## Privacy

- API key: `.env` or encrypted in `%APPDATA%\Cue\gemini-key.bin`. It's never logged and only sent to Google.
- `knowledge\`, `sessions\` and `.env` are git-ignored. Everything stays on your PC except Gemini API calls.
- **● Listening** (red) and the tray's red dot are on whenever audio is captured; nothing is captured otherwise.

---

## How it works

- `src/main`: Electron main process. Overlay window (`overlay.ts`), hotkeys, tray, answer engine (`answers.ts`), knowledge and retrieval (`knowledge.ts`, `retrieval.ts`, `liveKnowledge.ts`), question detection (`detector.ts`), presentation mode (`presentation.ts`), session logs (`session.ts`), Gemini client with quota/fallback (`gemini/`), audio (`audio/`: the capture window and Live transcription).
- `src/renderer`: the overlay UI (React) and the hidden audio window (mic + WASAPI loopback → 16 kHz worklet → voice activity detection).
- `src/prep`: `npm run prep` (extractors for code, md/txt/csv, pdf, pptx, docx, ipynb, Claude Code / Codex / claude.ai / ChatGPT chats) and `npm run debrief`.

## Development

```powershell
npm run dev        # run with hot reload
npm run typecheck
npm test           # 37 unit tests: config, quota/fallback, streaming, extractors, retrieval, VAD,
                   # Live session handling, question detection, slide matching, session logs
npm run prep -- --no-llm
```

Debug switches (environment variables): `CUE_HOME` (folder with config.yaml/knowledge/sessions), `CUE_SELFTEST=1` (run the capture self-test at start), `CUE_AUTOLISTEN=1` (start listening at start), `CUE_TEST_ME_WAV` / `CUE_TEST_THEM_WAV` = `path.wav@seconds` (play a WAV into the pipeline instead of the mic / Zoom audio).

## What was tested where

Everything above was built and tested in a Linux sandbox. That covered the real Gemini API with a free key, real speech through the full audio pipeline, a virtual display with real global hotkey presses, OCR on rendered slides, a packaged build, and 37 unit tests. **These need a check on your Windows PC**, because they depend on Windows itself:
- screen-capture exclusion in your Zoom share (use the checklist above),
- WASAPI loopback of Zoom's audio,
- focus going back to Zoom after type mode,
- the acrylic background,
- Zoom meeting-window detection.
