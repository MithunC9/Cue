// PowerPoint (.pptx) and Word (.docx) text extraction straight from the Office Open XML parts.
import { readFileSync } from 'node:fs'
import JSZip from 'jszip'

export interface Slide {
  index: number // 1-based, in presentation order
  title: string
  text: string
  notes: string
}

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')

/** Text of each <a:p> paragraph, runs joined. */
function drawingParagraphs(xml: string): string[] {
  const paras: string[] = []
  for (const p of xml.match(/<a:p[ >][\s\S]*?<\/a:p>/g) ?? []) {
    const runs = [...p.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => unescapeXml(m[1]))
    const line = runs.join('').trim()
    if (line) paras.push(line)
  }
  return paras
}

function shapes(xml: string): string[] {
  return xml.match(/<p:sp>[\s\S]*?<\/p:sp>|<p:sp [\s\S]*?<\/p:sp>/g) ?? []
}

function relTargets(relsXml: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const r of relsXml.matchAll(/<Relationship\s+([^>]*)\/?>/g)) {
    const id = /Id="([^"]+)"/.exec(r[1])?.[1]
    const target = /Target="([^"]+)"/.exec(r[1])?.[1]
    if (id && target) m.set(id, target)
  }
  return m
}

function resolve(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

export async function pptxSlides(file: string): Promise<Slide[]> {
  const zip = await JSZip.loadAsync(readFileSync(file))
  const read = async (p: string) => (await zip.file(p)?.async('string')) ?? ''
  const pres = await read('ppt/presentation.xml')
  const presRels = relTargets(await read('ppt/_rels/presentation.xml.rels'))
  // Slide order comes from <p:sldIdLst>, not from file names.
  const order = [...pres.matchAll(/<p:sldId\s[^>]*r:id="([^"]+)"/g)].map((m) => resolve('ppt/presentation.xml', presRels.get(m[1]) ?? ''))
  const slidePaths = order.length
    ? order
    : Object.keys(zip.files)
        .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
        .sort((a, b) => Number(/(\d+)\.xml/.exec(a)![1]) - Number(/(\d+)\.xml/.exec(b)![1]))
  const slides: Slide[] = []
  for (const [i, sp] of slidePaths.entries()) {
    const xml = await read(sp)
    if (!xml) continue
    let title = ''
    const body: string[] = []
    for (const shape of shapes(xml)) {
      const paras = drawingParagraphs(shape)
      if (!paras.length) continue
      if (!title && /<p:ph[^>]*type="(?:title|ctrTitle)"/.test(shape)) title = paras.join(' ')
      else body.push(...paras)
    }
    // Tables and grouped shapes outside <p:sp>
    for (const gf of xml.match(/<p:graphicFrame[\s\S]*?<\/p:graphicFrame>/g) ?? []) body.push(...drawingParagraphs(gf))
    const rels = relTargets(await read(sp.replace('slides/', 'slides/_rels/') + '.rels'))
    let notes = ''
    for (const target of rels.values()) {
      if (/notesSlide/.test(target)) {
        const nxml = await read(resolve(sp, target))
        notes = shapes(nxml)
          .filter((s) => /<p:ph[^>]*type="body"/.test(s))
          .flatMap(drawingParagraphs)
          .join('\n')
      }
    }
    if (!title && body.length) title = body.shift()!
    slides.push({ index: i + 1, title, text: body.join('\n'), notes })
  }
  return slides
}

export async function docxText(file: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(file))
  const xml = (await zip.file('word/document.xml')?.async('string')) ?? ''
  const out: string[] = []
  for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
    const text = [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)]
      .map((m) => (m[1] !== undefined ? unescapeXml(m[1]) : m[0] === '<w:tab/>' ? '\t' : '\n'))
      .join('')
      .trim()
    if (!text) continue
    const heading = /<w:pStyle w:val="(?:Heading|heading)(\d)"/.exec(p)
    const list = /<w:numPr>|<w:pStyle w:val="List/.test(p)
    out.push(heading ? `${'#'.repeat(Number(heading[1]))} ${text}` : list ? `- ${text}` : text)
  }
  return out.join('\n')
}
