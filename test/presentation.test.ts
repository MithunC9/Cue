import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hamming, matchSlide } from '../src/main/presentation'

const slides = [
  { index: 1, title: 'microCT Pipeline Progress', text: 'Mithun · SCALE Lab', notes: '' },
  { index: 2, title: 'Pipeline overview', text: 'DICOM loading → segmentation → per-slice CSV → registration', notes: '' },
  { index: 3, title: 'Segmentation', text: 'Per-slice Otsu after Gaussian smoothing\nDice 0.91 vs manual tracing', notes: '' },
  { index: 4, title: 'Compression states', text: 'TD-309 at 0/10/20% strain\nRigid ICP registration', notes: '' },
  { index: 5, title: 'Next steps: Abaqus FEM', text: 'Tetrahedral mesh export\nMaterial properties from intensity', notes: '' }
]

test('matchSlide copes with noisy OCR and prefers the next slide on ties', () => {
  const noisy = 'Segmentation EEE * Per-slice Otsu after Gaussian smoothi Se ee * Dice 0.91 vs ma'
  const m = matchSlide(noisy, slides, 2)!
  assert.equal(m.index, 3)
  assert.ok(m.score - m.runnerUp > 0.3)
  assert.equal(matchSlide('Next steps: Abaqus FEN. - Tetrahedral mesh export', slides, null)!.index, 5)
  assert.ok(matchSlide('Zoom gallery view Participants Chat', slides, 3)!.score < 0.2, 'a non-slide screen scores low')
  assert.equal(matchSlide('', slides, null), null)
})

test('hamming distance on 64-bit hashes', () => {
  assert.equal(hamming(0n, 0n), 0)
  assert.equal(hamming(0b1011n, 0b0001n), 2)
  assert.equal(hamming((1n << 64n) - 1n, 0n), 64)
})
