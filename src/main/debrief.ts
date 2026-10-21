// Debrief after the meeting: summary, action items and promised follow-ups, questions you struggled
// with, and what to add to brief.md next time. One BRAIN call (high thinking).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CueConfig } from './config'
import { streamBrain } from './gemini/brain'
import type { Gemini } from './gemini/client'

export async function writeDebrief(gem: Gemini, cfg: CueConfig, sessionDir: string, knowledgeDir: string): Promise<{ file: string; model: string }> {
  const read = (f: string, max = 400_000) => (existsSync(f) ? readFileSync(f, 'utf8').slice(-max) : '')
  const transcript = read(path.join(sessionDir, 'transcript.md'))
  if (!transcript.includes('**[')) throw new Error(`No transcript lines in ${sessionDir}`)
  const answers = read(path.join(sessionDir, 'answers.md'), 120_000)
  const brief = read(path.join(knowledgeDir, 'brief.md'), 40_000)
  const gaps = read(path.join(knowledgeDir, 'gaps.md'), 20_000)
  const me = cfg.meeting.me
  const prompt = `Write debrief.md for ${me} after this meeting with ${cfg.meeting.with} about "${cfg.meeting.topic}". Markdown, concise, these sections:
1. **Summary**: 5–8 bullets: what was discussed, decided, and the professor's main reactions.
2. **Action items & follow-ups I promised**: every commitment ${me} made ("I'll check…", "I'll send…") and every request from the professor, each with its [hh:mm:ss] timestamp and a suggested deadline.
3. **Questions I struggled with**: where ${me} hedged, said they didn't know, gave a vague answer, or where the card said "Not in your notes". Quote the question, say what a strong answer would have needed, and where to find it.
4. **Feedback & ideas from the professor**: suggestions, concerns, references to look up.
5. **Add to brief.md next time**: specific facts, numbers or decisions that came up and should be in the notes.
6. **Gaps resolved / still open** vs. the gaps list below (if provided).
Use only what's in the transcript and cards. Timestamps from the transcript. Don't invent commitments.

TRANSCRIPT (ME = ${me}, THEM = the professor's side):
${transcript}

ANSWER CARDS SHOWN DURING THE MEETING:
${answers || '(none)'}

BRIEF BEFORE THE MEETING:
${brief || '(none)'}

GAPS BEFORE THE MEETING:
${gaps || '(none)'}`
  const r = await streamBrain(gem, {
    system: `You are a thoughtful research mentor helping a high-school student follow up after a meeting with their professor. Be specific and honest; never fabricate.`,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    thinking: cfg.gemini.thinking.prep,
    chain: gem.brainChain,
    signal: new AbortController().signal,
    maxWaitMs: 70_000,
    retrySameMs: 90_000
  })
  const file = path.join(sessionDir, 'debrief.md')
  writeFileSync(file, `${r.text.trim()}\n\n<!-- generated ${new Date().toISOString()} by ${r.model} -->\n`)
  return { file, model: r.model }
}
