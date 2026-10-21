import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CONFIG } from '../src/main/config'
import { MeetingContext } from '../src/main/context'
import { QuestionDetector, extractQuestion, questionScore } from '../src/main/detector'
import type { Gemini } from '../src/main/gemini/client'
import { QuotaManager } from '../src/main/gemini/quota'

const tier = (t: string) => {
  const s = questionScore(t, 'Mithun').score
  return s >= 3 ? 'clear' : s >= 1.5 ? 'ambiguous' : 'ignore'
}

test('questionScore sorts professor utterances into clear / ambiguous / ignore', () => {
  const cases: [string, string][] = [
    ['How did you validate the segmentation against ground truth?', 'clear'],
    ['Why Otsu and not a global threshold?', 'clear'],
    ['Can you walk me through the registration step', 'clear'],
    ["I'm curious what voxel size you ended up using.", 'clear'],
    ["And what's next for the Abaqus part?", 'clear'],
    ['Okay, that looks good. Quick question though. How long does a full scan take to process?', 'clear'],
    ['Tell me more about the compression device.', 'ambiguous'],
    ['Did you try a U-Net', 'ambiguous'],
    ['So the porosity numbers, where do those come from', 'ambiguous'],
    ['Okay, sounds good.', 'ignore'],
    ['Mm-hmm.', 'ignore'],
    ["That's really interesting.", 'ignore'],
    ["Yeah, I think that's a reasonable approach.", 'ignore'],
    ['Mithun, could you go back one slide?', 'ignore'],
    ['Can you hear me okay?', 'ignore'],
    ["You're on mute.", 'ignore']
  ]
  for (const [text, want] of cases) assert.equal(tier(text), want, `${text} → ${JSON.stringify(questionScore(text, 'Mithun'))}`)
})

function detector(opts: { fast?: { is_question_for_me: boolean; question: string; confidence: number } | 'fail'; mode?: 'ambiguous' | 'always' | 'never' } = {}) {
  const asked: string[] = []
  const fastCalls: string[] = []
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.auto_answer.merge_ms = 30
  cfg.auto_answer.fast = opts.mode ?? 'ambiguous'
  let speaking = false
  const gem = {
    quota: new QuotaManager(() => ({ rpm: 100, rpd: 1000 }), null),
    fastChain: ['lite'],
    addUsage: () => {},
    ai: {
      models: {
        generateContent: async (req: { contents: { parts: { text: string }[] }[] }) => {
          fastCalls.push(req.contents[0].parts[0].text)
          if (opts.fast === 'fail') throw Object.assign(new Error('{"error":{"code":503}}'), { status: 503 })
          return { text: JSON.stringify(opts.fast ?? { is_question_for_me: true, question: 'Q?', confidence: 0.9 }) }
        }
      }
    }
  } as unknown as Gemini
  const d = new QuestionDetector({ gem: () => gem, cfg: () => cfg, ctx: new MeetingContext(), ask: (q) => asked.push(q), themSpeaking: () => speaking })
  return { d, asked, fastCalls, setSpeaking: (v: boolean) => (speaking = v) }
}
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms))

test('clear questions are answered without a FAST call; chit-chat is ignored', async () => {
  const { d, asked, fastCalls } = detector()
  d.onThemUtterance('Okay, sounds good.')
  await wait()
  d.onThemUtterance('Why did you choose Otsu instead of a global threshold?')
  await wait()
  assert.deepEqual(asked, ['Why did you choose Otsu instead of a global threshold?'])
  assert.equal(fastCalls.length, 0)
})

test('a follow-up sentence is merged into one question and one card', async () => {
  const { d, asked, setSpeaking } = detector()
  d.onThemUtterance('Okay so on the segmentation slide.')
  setSpeaking(true)
  d.onThemSpeechStart()
  await wait()
  setSpeaking(false)
  d.onThemUtterance('How did you check it against manual tracing?')
  d.onThemSpeechEnd()
  await wait()
  assert.equal(asked.length, 1)
  assert.match(asked[0], /^How did you check it against manual tracing\?$/)
})

test('ambiguous lines go to FAST, which can reject them or rewrite them standalone', async () => {
  const yes = detector({ fast: { is_question_for_me: true, question: 'What compression device did you use and how was it set up?', confidence: 0.8 } })
  yes.d.onThemUtterance('Tell me more about the compression device.')
  await wait(150)
  assert.equal(yes.fastCalls.length, 1)
  assert.deepEqual(yes.asked, ['What compression device did you use and how was it set up?'])

  const no = detector({ fast: { is_question_for_me: false, question: '', confidence: 0.9 } })
  no.d.onThemUtterance('So the porosity numbers, where do those come from')
  await wait(150)
  assert.deepEqual(no.asked, [])
})

test('when FAST is unavailable only fairly confident lines are answered', async () => {
  const { d, asked } = detector({ fast: 'fail' })
  d.onThemUtterance('Tell me more about the compression device.') // 1.5: not enough alone
  await wait(150)
  d.onThemUtterance('Did you try a U-Net') // 2.0: not enough alone
  await wait(150)
  assert.deepEqual(asked, [])
})

test('the same question twice in a row yields one card', async () => {
  const { d, asked } = detector()
  d.onThemUtterance('How did you validate the segmentation?')
  await wait()
  d.onThemUtterance('How did you validate the segmentation?')
  await wait()
  assert.equal(asked.length, 1)
})

test('extractQuestion drops the preamble and keeps every question', () => {
  assert.equal(
    extractQuestion('Okay, thanks Mithun, that looks good. Quick question though, how did you validate the segmentation against ground truth? And why did you choose Otsu instead of a single global threshold?'),
    'How did you validate the segmentation against ground truth? And why did you choose Otsu instead of a single global threshold?'
  )
  assert.equal(extractQuestion('Nice work. Tell me more about the compression device.'), 'Tell me more about the compression device.')
  assert.equal(extractQuestion('Did you try a U-Net'), 'Did you try a U-Net')
})
