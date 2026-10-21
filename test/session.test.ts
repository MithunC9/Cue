import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { DEFAULT_CONFIG } from '../src/main/config'
import { SessionLog, folderName, latestSession } from '../src/main/session'

test('session log: lazy folder, timestamped ME/THEM transcript, answer cards, screenshots only when enabled', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cue-sessions-'))
  const cfg = structuredClone(DEFAULT_CONFIG)
  const log = new SessionLog(root, () => cfg)
  assert.equal(log.dir, null, 'nothing written before there is something to log')
  const at = new Date(2026, 9, 21, 14, 32, 5).getTime()
  log.transcript({ id: 1, speaker: 'THEM', text: 'How did you validate it?', final: true, at })
  log.transcript({ id: 2, speaker: 'ME', text: 'partial', final: false, at })
  log.slide(3, 'Segmentation')
  log.answer({ id: 1, trigger: 'auto', question: 'How did you validate it?', text: '**Dice 0.91**', model: 'm', firstTokenMs: 1200, prepared: true, at })
  assert.equal(log.screenshot(Buffer.from('jpg')), null)
  cfg.sessions.save_screenshots = true
  const shot = log.screenshot(Buffer.from('jpg'))!
  assert.ok(existsSync(shot))
  const transcript = readFileSync(path.join(log.dir!, 'transcript.md'), 'utf8')
  assert.match(transcript, /\*\*\[14:32:05\] THEM:\*\* How did you validate it\?/)
  assert.doesNotMatch(transcript, /partial/, 'interim lines are not logged')
  assert.match(transcript, /slide 3: Segmentation/)
  const answers = readFileSync(path.join(log.dir!, 'answers.md'), 'utf8')
  assert.match(answers, /## \[14:32:05\] HEARD: How did you validate it\?/)
  assert.match(answers, /first token 1\.2 s · prepared answer shown first/)
  assert.equal(latestSession(root), log.dir)
  assert.equal(folderName(at), '2026-10-21_1432')
})
