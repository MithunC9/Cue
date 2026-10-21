// AI chat history about the project: Claude Code (.jsonl), Codex CLI (.jsonl), and claude.ai /
// ChatGPT exports (conversations.json). Keeps only user + assistant prose with timestamps; drops tool
// calls, tool output, file dumps, diffs and long code blocks.
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { readText } from './text'

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  at?: string // ISO timestamp
}

export interface ChatSession {
  origin: 'claude-code' | 'codex' | 'claude.ai' | 'chatgpt'
  id: string
  title: string
  file: string
  cwd?: string
  started?: string
  messages: ChatMessage[]
}

/** Strips harness noise and long code/diff blocks; short snippets stay (they're often the decision). */
export function cleanChatText(text: string, maxCodeLines = 12): string {
  let t = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/g, '')
    .replace(/<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr)>[\s\S]*?<\/(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr)>/g, '')
  t = t.replace(/```([\w+-]*)\n([\s\S]*?)```/g, (block, lang: string, body: string) => {
    const lines = body.split('\n').length
    const isDiff = lang === 'diff' || /^[+-]{3} /m.test(body) || /^@@ /m.test(body)
    if (isDiff) return `[diff omitted: ${lines} lines]`
    return lines > maxCodeLines ? `[${lang || 'code'} block omitted: ${lines} lines]` : block
  })
  return t.replace(/\n{3,}/g, '\n\n').trim()
}

function* walkFiles(dir: string, match: (f: string) => boolean, depth = 0): Generator<string> {
  if (depth > 6 || !existsSync(dir)) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const p = path.join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) yield* walkFiles(p, match, depth + 1)
    else if (match(name)) yield p
  }
}

function jsonLines(file: string): unknown[] {
  const out: unknown[] = []
  for (const line of readText(file).split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // partially written last line; skip
    }
  }
  return out
}

type Block = { type?: string; text?: string }
const textBlocks = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[])
    .filter((b) => b && (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}
const hasToolResult = (content: unknown) => Array.isArray(content) && (content as Block[]).some((b) => b?.type === 'tool_result')

/** Claude Code: %USERPROFILE%\.claude\projects\<encoded-path>\<session>.jsonl */
export function claudeCodeSessions(dir: string): ChatSession[] {
  const sessions: ChatSession[] = []
  for (const file of walkFiles(dir, (f) => f.endsWith('.jsonl'))) {
    const msgs: ChatMessage[] = []
    let cwd: string | undefined
    let title = ''
    for (const raw of jsonLines(file)) {
      const r = raw as {
        type?: string
        isMeta?: boolean
        isSidechain?: boolean
        cwd?: string
        timestamp?: string
        summary?: string
        message?: { role?: string; content?: unknown }
      }
      if (r.cwd && !cwd) cwd = r.cwd
      if (r.type === 'summary' && r.summary && !title) title = r.summary
      if ((r.type !== 'user' && r.type !== 'assistant') || r.isMeta || r.isSidechain || !r.message) continue
      if (r.type === 'user' && hasToolResult(r.message.content)) continue // tool output, not you
      const text = cleanChatText(textBlocks(r.message.content))
      if (!text || text.startsWith('Caveat: The messages below')) continue
      const role = r.type
      // Assistant turns are streamed as several records; merge consecutive ones.
      const prev = msgs[msgs.length - 1]
      if (prev && prev.role === role && role === 'assistant') prev.text += '\n' + text
      else msgs.push({ role, text, at: r.timestamp })
    }
    if (msgs.length) {
      sessions.push({
        origin: 'claude-code',
        id: path.basename(file, '.jsonl'),
        title: title || msgs.find((m) => m.role === 'user')?.text.slice(0, 80) || path.basename(file),
        file,
        cwd,
        started: msgs[0].at,
        messages: msgs
      })
    }
  }
  return sessions
}

/** Codex CLI: %USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl (old and new line formats). */
export function codexSessions(dir: string): ChatSession[] {
  const sessions: ChatSession[] = []
  for (const file of walkFiles(dir, (f) => f.endsWith('.jsonl'))) {
    const msgs: ChatMessage[] = []
    let cwd: string | undefined
    let started: string | undefined
    for (const raw of jsonLines(file)) {
      const r = raw as { timestamp?: string; type?: string; payload?: Record<string, unknown> } & Record<string, unknown>
      const p = (r.payload ?? r) as { type?: string; role?: string; content?: unknown; cwd?: string; timestamp?: string }
      if (r.type === 'session_meta' || (p.cwd && !p.role)) {
        cwd ??= p.cwd
        started ??= (p.timestamp as string) ?? r.timestamp
        continue
      }
      if (p.type !== 'message' || (p.role !== 'user' && p.role !== 'assistant')) continue
      const text = cleanChatText(textBlocks(p.content))
      if (!text) continue
      msgs.push({ role: p.role, text, at: r.timestamp ?? started })
    }
    if (msgs.length) {
      sessions.push({
        origin: 'codex',
        id: path.basename(file, '.jsonl'),
        title: msgs.find((m) => m.role === 'user')?.text.slice(0, 80) ?? path.basename(file),
        file,
        cwd,
        started: started ?? msgs[0].at,
        messages: msgs
      })
    }
  }
  return sessions
}

const isoFromEpoch = (s: unknown) => (typeof s === 'number' ? new Date(s * 1000).toISOString() : typeof s === 'string' ? s : undefined)

/** claude.ai or ChatGPT data export (conversations.json, or the folder containing it). */
export function exportSessions(fileOrDir: string): ChatSession[] {
  const file = existsSync(fileOrDir) && statSync(fileOrDir).isDirectory() ? path.join(fileOrDir, 'conversations.json') : fileOrDir
  if (!existsSync(file)) return []
  const data = JSON.parse(readText(file)) as unknown[]
  if (!Array.isArray(data)) return []
  const sessions: ChatSession[] = []
  for (const conv of data as Record<string, unknown>[]) {
    if (Array.isArray(conv.chat_messages)) {
      // claude.ai
      const messages: ChatMessage[] = []
      for (const m of conv.chat_messages as { sender?: string; text?: string; content?: unknown; created_at?: string }[]) {
        const role = m.sender === 'human' ? 'user' : m.sender === 'assistant' ? 'assistant' : null
        const text = cleanChatText(m.text || textBlocks(m.content))
        if (role && text) messages.push({ role, text, at: m.created_at })
      }
      if (messages.length)
        sessions.push({ origin: 'claude.ai', id: String(conv.uuid ?? sessions.length), title: String(conv.name || 'Untitled'), file, started: messages[0].at, messages })
    } else if (conv.mapping && typeof conv.mapping === 'object') {
      // ChatGPT
      type Node = { message?: { author?: { role?: string }; content?: { content_type?: string; parts?: unknown[] }; create_time?: number } }
      const nodes = Object.values(conv.mapping as Record<string, Node>)
        .map((n) => n.message)
        .filter((m): m is NonNullable<Node['message']> => !!m && (m.author?.role === 'user' || m.author?.role === 'assistant'))
        .filter((m) => m.content?.content_type === 'text')
        .sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0))
      const messages: ChatMessage[] = []
      for (const m of nodes) {
        const text = cleanChatText((m.content?.parts ?? []).filter((x) => typeof x === 'string').join('\n'))
        if (text) messages.push({ role: m.author!.role as 'user' | 'assistant', text, at: isoFromEpoch(m.create_time) })
      }
      if (messages.length)
        sessions.push({ origin: 'chatgpt', id: String(conv.id ?? conv.conversation_id ?? sessions.length), title: String(conv.title || 'Untitled'), file, started: isoFromEpoch(conv.create_time), messages })
    }
  }
  return sessions
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/**
 * A session is relevant if it ran inside one of the repos, mentions a repo path, or hits at least
 * `minHits` distinct keywords.
 */
export function isRelevant(s: ChatSession, repos: string[], keywords: string[], minHits = 2): { keep: boolean; why: string } {
  const repoNorm = repos.map(norm).filter(Boolean)
  if (s.cwd && repoNorm.some((r) => norm(s.cwd!).startsWith(r))) return { keep: true, why: 'ran in repo' }
  // Same repo checked out somewhere else (another drive, renamed parent folder): match on the folder name.
  const repoNames = repos.map((r) => path.basename(norm(r))).filter((n) => n.length > 2)
  if (s.cwd && repoNames.some((n) => norm(s.cwd!).split('/').includes(n))) return { keep: true, why: 'ran in a folder named like the repo' }
  const all = s.messages.map((m) => m.text).join('\n')
  const lower = all.toLowerCase().replace(/\\/g, '/')
  if (repoNorm.some((r) => lower.includes(r))) return { keep: true, why: 'mentions repo path' }
  const names = repoNames.filter((n) => n.length > 3)
  const hits = keywords.filter((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(all))
  if (names.some((n) => lower.includes(n)) && hits.length >= 1) return { keep: true, why: 'mentions repo name' }
  if (hits.length >= minHits) return { keep: true, why: `keywords: ${hits.slice(0, 4).join(', ')}` }
  return { keep: false, why: hits.length ? `only ${hits.length} keyword` : 'no repo path or keywords' }
}
