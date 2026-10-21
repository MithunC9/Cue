// Code handling: big files keep their outline (signatures, docstrings, comments, constants)
// instead of full bodies.

const DECL =
  /^\s*(?:export\s+)?(?:async\s+)?(?:def |class |function |fn |func |struct |enum |interface |type |module |namespace |public |private |protected |static |template|#define|@\w|function\s*\[?|classdef |properties|methods)/
const COMMENT = /^\s*(?:#|\/\/|\/\*|\*|%|--|;|'''|""")/
const CONST = /^\s*(?:export\s+)?(?:const\s+)?[A-Z][A-Z0-9_]{2,}\s*[:=]/
const IMPORT = /^\s*(?:import |from \S+ import |#include |using |require\(|library\()/

/** Keeps declarations, docstrings, comments, constants and imports; collapses bodies. */
export function outline(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let inDoc: string | null = null
  let skipped = 0
  const flush = () => {
    if (skipped) out.push(`    … (${skipped} lines)`)
    skipped = 0
  }
  for (const line of lines) {
    const t = line.trim()
    if (inDoc) {
      out.push(line)
      if (t.includes(inDoc)) inDoc = null
      continue
    }
    const docStart = /^(?:[rRuU]?)("""|''')/.exec(t)
    if (docStart) {
      flush()
      out.push(line)
      const rest = t.slice(docStart[0].length)
      if (!rest.includes(docStart[1])) inDoc = docStart[1]
      continue
    }
    if (DECL.test(line) || COMMENT.test(line) || CONST.test(line) || IMPORT.test(line)) {
      flush()
      out.push(line)
    } else if (t) skipped++
  }
  flush()
  return out.join('\n')
}

export const CODE_EXT = new Set([
  '.py', '.pyw', '.pyi', '.m', '.r', '.jl', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.c', '.h', '.cc', '.cpp', '.hpp', '.cxx',
  '.cs', '.java', '.kt', '.go', '.rs', '.sh', '.bash', '.ps1', '.bat', '.cmd', '.f90', '.f', '.for', '.inp', '.sql', '.cmake', '.mk'
])

export const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.rst', '.tex', '.bib', '.yaml', '.yml', '.toml', '.cfg', '.ini', '.json', '.csv', '.tsv', '.log', '.org', '.adoc', '.html', '.htm', '.xml'
])

export const DOC_BINARY_EXT = new Set(['.pdf', '.pptx', '.docx', '.ipynb'])

/** Scan data, images and other binaries that are recorded in the manifest but never read. */
export const RAW_DATA_EXT = new Set([
  '.dcm', '.dicom', '.ima', '.tif', '.tiff', '.aim', '.isq', '.rsq', '.gobj', '.nii', '.gz', '.nrrd', '.nhdr', '.mha', '.mhd', '.raw', '.vol', '.img',
  '.npy', '.npz', '.h5', '.hdf5', '.zarr', '.mat', '.vtk', '.vti', '.stl', '.obj', '.ply', '.odb', '.cae', '.sim', '.png', '.jpg', '.jpeg', '.bmp',
  '.gif', '.zip', '.7z', '.rar', '.tar', '.exe', '.dll', '.so', '.pyd', '.pkl', '.pickle', '.pt', '.pth', '.onnx', '.ckpt', '.bin', '.dat', '.xlsx', '.xls', '.mp4', '.avi', '.mov'
])
