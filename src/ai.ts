import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai'
import {
  SystemMessage, HumanMessage, AIMessage, ToolMessage,
  type BaseMessage, type AIMessageChunk,
} from '@langchain/core/messages'
import type { Note, ChatMessage } from './db'
import { getAllEmbeddings, putEmbedding, getSetting, putSetting, putEditLog, type NoteEmbedding } from './db'

export interface AIActions {
  createNote(title: string, body: string, folderName?: string): number
  appendToNote(noteId: number, text: string): boolean
  replaceNoteBody(noteId: number, body: string): boolean
  openNote(noteId: number): boolean
  deleteNote(noteId: number): boolean
  moveNote(noteId: number, folderName: string | null): boolean
}

// Human-in-the-loop: a proposed edit awaiting user approval
export interface PendingAction {
  tool: 'create_note' | 'append_to_note' | 'replace_note_body' | 'delete_note'
  title: string   // short human-readable description
  preview: string // markdown content that would be written
  oldPreview?: string // previous body, for diff display on rewrites
}

// Return ok=true to apply; content overrides the proposed text when the user edited it
export interface ApprovalDecision { ok: boolean; content?: string }
export type ApprovalGate = (action: PendingAction) => Promise<ApprovalDecision>

// LLM backend config — env wins over the key passed from the UI.
// Base URL lets you target any OpenAI-compatible server (Azure, Ollama, vLLM, OpenRouter...).
export const envApiKey = (import.meta.env.VITE_OPENAI_API_KEY as string | undefined) || ''
const envModel = (import.meta.env.VITE_OPENAI_MODEL as string | undefined) || 'gpt-4o-mini'
const envBaseURL = (import.meta.env.VITE_OPENAI_BASE_URL as string | undefined) || undefined
const envEmbedModel = (import.meta.env.VITE_OPENAI_EMBED_MODEL as string | undefined) || 'text-embedding-3-small'
// Cheap model for lightweight jobs (tagging); falls back to the main model
const envTagModel = (import.meta.env.VITE_OPENAI_TAG_MODEL as string | undefined) || ''

export function createLLM(apiKey: string, model = envModel) {
  return new ChatOpenAI({
    apiKey: envApiKey || apiKey || 'not-needed', // local backends often ignore the key
    model,
    temperature: 0.4,
    ...(envBaseURL ? { configuration: { baseURL: envBaseURL } } : {}),
  })
}

function createEmbedder(apiKey: string) {
  return new OpenAIEmbeddings({
    apiKey: envApiKey || apiKey || 'not-needed',
    model: envEmbedModel,
    ...(envBaseURL ? { configuration: { baseURL: envBaseURL } } : {}),
  })
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

// RAG: keep the embedding cache in sync with notes, then return the top-k
// semantically relevant notes for the query. Throws if the backend has no
// embeddings endpoint — callers should fall back gracefully.
export async function retrieveRelevantNotes(
  apiKey: string,
  query: string,
  notes: Note[],
  k = 6,
): Promise<Note[]> {
  if (notes.length === 0) return []
  const embedder = createEmbedder(apiKey)
  const cache = new Map((await getAllEmbeddings()).map((e) => [e.id, e]))

  const stale = notes.filter((n) => cache.get(n.id)?.updatedAt !== n.updatedAt)
  if (stale.length > 0) {
    const vectors = await embedder.embedDocuments(
      stale.map((n) => `${n.title}\n\n${n.body.slice(0, 3000)}`)
    )
    stale.forEach((n, i) => {
      const e: NoteEmbedding = { id: n.id, updatedAt: n.updatedAt, vector: vectors[i] }
      cache.set(n.id, e)
      putEmbedding(e) // fire-and-forget
    })
  }

  const qv = await embedder.embedQuery(query)
  return notes
    .map((n) => ({ n, score: cosine(qv, cache.get(n.id)?.vector ?? []) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .filter((x) => x.score > 0.1)
    .map((x) => x.n)
}

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'create_note',
      description: 'Create a new note in the notepad. Optionally place it in a folder (created if missing). Returns the new note id.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Note title' },
          body: { type: 'string', description: 'Note body in markdown' },
          folderName: { type: 'string', description: 'Optional folder name to place the note in' },
        },
        required: ['title', 'body'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'append_to_note',
      description: 'Append markdown text to the end of an existing note.',
      parameters: {
        type: 'object',
        properties: {
          noteId: { type: 'number', description: 'Id of the note to append to' },
          text: { type: 'string', description: 'Markdown text to append' },
        },
        required: ['noteId', 'text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'replace_note_body',
      description: 'Replace the entire body of an existing note (use for rewrites, cleanups, reformatting).',
      parameters: {
        type: 'object',
        properties: {
          noteId: { type: 'number', description: 'Id of the note to rewrite' },
          body: { type: 'string', description: 'New full markdown body' },
        },
        required: ['noteId', 'body'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'open_note',
      description: 'Open/navigate to a note in the editor so the user can see it.',
      parameters: {
        type: 'object',
        properties: {
          noteId: { type: 'number', description: 'Id of the note to open' },
        },
        required: ['noteId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_note',
      description: 'Move a note to the trash (recoverable for 30 days).',
      parameters: {
        type: 'object',
        properties: {
          noteId: { type: 'number', description: 'Id of the note to delete' },
        },
        required: ['noteId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'move_note',
      description: 'Move a note into a folder (created if missing). Pass folderName null/empty to move it out of any folder.',
      parameters: {
        type: 'object',
        properties: {
          noteId: { type: 'number', description: 'Id of the note to move' },
          folderName: { type: 'string', description: 'Target folder name, or empty to unfile' },
        },
        required: ['noteId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_note',
      description: 'Read the FULL content of any note by id. Use this to scan/review notes before giving feedback or editing.',
      parameters: {
        type: 'object',
        properties: {
          noteId: { type: 'number', description: 'Id of the note to read' },
        },
        required: ['noteId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_notes',
      description: 'Semantic search across all notes. Returns the most relevant notes with snippets. Use when the note index preview is not enough.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'review_vault',
      description: 'Walk notes for a status report. mode "all" audits EVERY note (use for status checks, audits, "what needs attention"); "recent" only notes touched in the last 2 days. Returns per-note stats: open/done task counts, word count, staleness, excerpt.',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['all', 'recent'], description: 'Scan scope' },
        },
        required: ['mode'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'save_preference',
      description: 'Remember a lasting user preference about how they like their notes written or organised (e.g. after a rejected edit). Keep it to one short sentence.',
      parameters: {
        type: 'object',
        properties: {
          preference: { type: 'string', description: 'One-sentence preference to remember' },
        },
        required: ['preference'],
      },
    },
  },
]

function buildSystemPrompt(notes: Note[], activeId: number | null, retrieved: Note[] = [], preferences = ''): string {
  const index = notes
    .map((n) => {
      const preview = n.body.replace(/\s+/g, ' ').slice(0, 120)
      return `- id:${n.id} | "${n.title}" | created ${n.createdAt.slice(0, 10)} | updated ${n.updatedAt.slice(0, 10)}${n.id === activeId ? ' | (CURRENTLY OPEN)' : ''}\n  preview: ${preview || '(empty)'}`
    })
    .join('\n')

  const active = notes.find((n) => n.id === activeId)
  const ragNotes = retrieved.filter((n) => n.id !== activeId)
  const ragSection = ragNotes.length
    ? `\nRELEVANT NOTES (retrieved by semantic search for this request):\n${ragNotes
        .map((n) => `--- id:${n.id} "${n.title}" ---\n${n.body.slice(0, 3000) || '(empty)'}`)
        .join('\n\n')}\n`
    : ''

  return `You are Chaboxer AI, embedded in a local-first markdown notes app.
Today's date: ${new Date().toISOString().slice(0, 10)}.

## Operating rules
- You read and write notes ONLY through the tools below — never claim an action succeeded unless the matching tool call returned success. Before saying a task is done, confirm which tool call produced the result.
- Note edits are STAGED for user review (unless agent mode auto-applies). If a tool result says the user REJECTED an edit, do not retry it; call save_preference with what you learned, then ask what they want instead.
- When referencing a note in CHAT replies, ALWAYS use [[noteId|Title]] syntax (e.g. [[${notes[0]?.id ?? 123}|${notes[0]?.title ?? 'Example'}]]) — the client renders it as a clickable deep-link by id. Never just bold a title; ids survive renames, titles may collide.
- Inside NOTE BODIES, use [[Note Title]] wikilinks and #tags — they build the graph view.
- If a request is ambiguous about scope (one note vs whole vault), ask before running a full vault scan.

## Capability manifest
- Notes are markdown: # headings, **bold**, - lists, "- [ ]"/"- [x]" task checkboxes (first-class primitive — briefings depend on them), > quotes, ==highlight==, tables, \`code\`.
- create_note(title, body, folderName?) → creates a note, returns its id; folderName files it (folder created if missing — prefer existing folders from the index).
- append_to_note(noteId, text) / replace_note_body(noteId, body) → staged edits with diff review.
- open_note(noteId) → navigates the editor there; call after creating/editing so the user sees it.
- delete_note(noteId) → soft-delete to 30-day trash (staged). move_note(noteId, folderName) → refile.
- read_note(noteId) → FULL content; use before reviewing or editing any note not already in context.
- search_notes(query) → semantic search when the index preview isn't enough.
- review_vault(mode) → per-note stats for audits: "all" walks EVERY note (use for status checks / "what needs attention" — staleness ≠ recency), "recent" only last-2-days.
- save_preference(text) → persist a lasting user preference (esp. after rejections).
- App features you can reference: graph view (wikilinks/tags = edges), folders, pins, daily journal note per day, Google cloud sync, offline PWA, per-note markdown/PDF/Word export, Ctrl+B/I/E/S shortcuts.

## Report format (reviews/briefings)
- One line per note: verdict (stale | has open tasks | formatting issue | empty | looks good) + [[noteId|Title]] link + one short remark. Scannable report, not prose paragraphs.
- Dates matter: use created/updated for "recent", "today", "this week".
- Keep summaries concise and structured; write note bodies in rich markdown.
${preferences ? `\nLEARNED USER PREFERENCES (follow these):\n${preferences}\n` : ''}

NOTE INDEX (${notes.length} notes):
${index || '(no notes yet)'}
${ragSection}
${active ? `FULL CONTENT OF CURRENTLY OPEN NOTE (id:${active.id}, "${active.title}"):\n${active.body || '(empty)'}` : ''}`
}

// Ask the LLM for tags and wikilinks for one note
export async function suggestTags(
  apiKey: string,
  note: Note,
  allTitles: string[],
): Promise<string> {
  const model = createLLM(apiKey, envTagModel || envModel)
  const res = await model.invoke([
    new SystemMessage(
      `You tag markdown notes. Reply with ONE line only: 2-5 relevant #tags (lowercase, hyphenated) and, if any of these existing note titles are strongly related, [[wikilinks]] to them: ${allTitles.join(', ')}. No explanations.`
    ),
    new HumanMessage(`Title: ${note.title}\n\n${note.body.slice(0, 4000)}`),
  ])
  return (typeof res.content === 'string' ? res.content : '').trim()
}

export async function runAI(
  apiKey: string,
  userInput: string,
  history: ChatMessage[],
  notes: Note[],
  activeId: number | null,
  actions: AIActions,
  requestApproval?: ApprovalGate, // undefined = agent mode (auto-apply)
  onToken?: (text: string) => void, // streaming: called with the answer-so-far
  onProgress?: (activity: string) => void, // live tool activity for the UI
): Promise<string> {
  const model = createLLM(apiKey).bindTools(TOOLS)

  const preferences = (await getSetting('ai-preferences').catch(() => '')) || ''

  // RAG: pull semantically relevant notes into the prompt; ignore failures
  // (e.g. local backends without an embeddings endpoint)
  let retrieved: Note[] = []
  try {
    retrieved = await retrieveRelevantNotes(apiKey, userInput, notes)
  } catch {
    retrieved = []
  }

  // Memory: replay persisted chat history (last 30 messages) for context
  const messages: BaseMessage[] = [new SystemMessage(buildSystemPrompt(notes, activeId, retrieved, preferences))]
  for (const m of history.slice(-30)) {
    messages.push(m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content))
  }
  messages.push(new HumanMessage(userInput))

  // Tool-calling loop
  for (let step = 0; step < 6; step++) {
    // Stream tokens for live display; fall back to invoke if streaming fails
    let response: AIMessageChunk | AIMessage
    try {
      let acc: AIMessageChunk | undefined
      let text = ''
      for await (const chunk of await model.stream(messages)) {
        acc = acc ? acc.concat(chunk) : chunk
        const piece = typeof chunk.content === 'string' ? chunk.content : ''
        if (piece) { text += piece; onToken?.(text) }
      }
      if (!acc) throw new Error('empty stream')
      response = acc
    } catch {
      response = await model.invoke(messages)
    }
    messages.push(response)

    const toolCalls = response.tool_calls ?? []
    if (toolCalls.length === 0) {
      return typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content)
    }

    for (const call of toolCalls) {
      let result = 'ok'
      try {
        const args = call.args as Record<string, unknown>

        // Human-in-the-loop gate for mutating tools
        if (requestApproval && (call.name === 'create_note' || call.name === 'append_to_note' || call.name === 'replace_note_body' || call.name === 'delete_note')) {
          const target = notes.find((n) => n.id === Number(args.noteId))
          const pending: PendingAction =
            call.name === 'create_note'
              ? { tool: call.name, title: `Create note "${String(args.title ?? 'Untitled')}"${args.folderName ? ` in folder "${args.folderName}"` : ''}`, preview: String(args.body ?? ''), oldPreview: '' }
              : call.name === 'append_to_note'
                ? { tool: call.name, title: `Append to "${target?.title ?? `note ${args.noteId}`}"`, preview: target?.body ? `${target.body}\n\n${String(args.text ?? '')}` : String(args.text ?? ''), oldPreview: target?.body ?? '' }
                : call.name === 'delete_note'
                  ? { tool: call.name, title: `Delete "${target?.title ?? `note ${args.noteId}`}" (moves to trash)`, preview: target?.body.slice(0, 500) ?? '' }
                  : { tool: call.name, title: `Rewrite "${target?.title ?? `note ${args.noteId}`}"`, preview: String(args.body ?? ''), oldPreview: target?.body ?? '' }
          const decision = await requestApproval(pending)
          if (!decision.ok) {
            messages.push(new ToolMessage({ content: 'The user REJECTED this edit. Do not retry it; ask what they would like instead.', tool_call_id: call.id ?? '' }))
            continue
          }
          // The user edited the proposed content before applying
          if (decision.content !== undefined) {
            if (call.name === 'create_note' || call.name === 'replace_note_body') args.body = decision.content
            else if (call.name === 'append_to_note') {
              // Diff showed the combined body; strip the old part back out
              const old = target?.body ?? ''
              args.text = decision.content.startsWith(old) ? decision.content.slice(old.length).replace(/^\n+/, '') : decision.content
            }
          }
        }

        const target = notes.find((n) => n.id === Number(args.noteId))
        switch (call.name) {
          case 'create_note': {
            const id = actions.createNote(
              String(args.title ?? 'Untitled'),
              String(args.body ?? ''),
              args.folderName ? String(args.folderName) : undefined,
            )
            putEditLog({ id: Date.now() + Math.random(), noteId: id, tool: call.name, changeType: 'insert', before: '', after: String(args.body ?? ''), createdAt: new Date().toISOString() })
            result = `created note id:${id}`
            break
          }
          case 'append_to_note': {
            const before = target?.body ?? ''
            const ok = actions.appendToNote(Number(args.noteId), String(args.text ?? ''))
            if (ok) putEditLog({ id: Date.now() + Math.random(), noteId: Number(args.noteId), tool: call.name, changeType: 'edit', before, after: before ? `${before}\n\n${String(args.text ?? '')}` : String(args.text ?? ''), createdAt: new Date().toISOString() })
            result = ok ? 'appended' : `error: note ${args.noteId} not found`
            break
          }
          case 'replace_note_body': {
            const before = target?.body ?? ''
            const ok = actions.replaceNoteBody(Number(args.noteId), String(args.body ?? ''))
            if (ok) putEditLog({ id: Date.now() + Math.random(), noteId: Number(args.noteId), tool: call.name, changeType: 'edit', before, after: String(args.body ?? ''), createdAt: new Date().toISOString() })
            result = ok ? 'replaced' : `error: note ${args.noteId} not found`
            break
          }
          case 'open_note':
            result = actions.openNote(Number(args.noteId))
              ? 'opened' : `error: note ${args.noteId} not found`
            break
          case 'delete_note': {
            const before = target?.body ?? ''
            const ok = actions.deleteNote(Number(args.noteId))
            if (ok) putEditLog({ id: Date.now() + Math.random(), noteId: Number(args.noteId), tool: call.name, changeType: 'delete', before, after: '', createdAt: new Date().toISOString() })
            result = ok ? 'moved to trash' : `error: note ${args.noteId} not found`
            break
          }
          case 'move_note':
            result = actions.moveNote(Number(args.noteId), args.folderName ? String(args.folderName) : null)
              ? 'moved' : `error: note ${args.noteId} not found`
            break
          case 'read_note': {
            const note = notes.find((n) => n.id === Number(args.noteId))
            result = note
              ? `"${note.title}" (created ${note.createdAt.slice(0, 10)}, updated ${note.updatedAt.slice(0, 10)}):\n\n${note.body || '(empty)'}`
              : `error: note ${args.noteId} not found`
            break
          }
          case 'search_notes': {
            const found = await retrieveRelevantNotes(apiKey, String(args.query ?? ''), notes, 5)
            result = found.length
              ? found.map((n) => `id:${n.id} "${n.title}"\n${n.body.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n---\n')
              : 'no matching notes'
            break
          }
          case 'review_vault': {
            const mode = String(args.mode ?? 'all')
            const cutoff = Date.now() - 2 * 24 * 3600 * 1000
            const scanned = (mode === 'recent'
              ? notes.filter((n) => new Date(n.updatedAt).getTime() >= cutoff)
              : notes
            ).slice(0, 60)
            result = scanned.length
              ? scanned.map((n) => {
                  const open = (n.body.match(/^\s*[-*] \[ \]/gm) ?? []).length
                  const done = (n.body.match(/^\s*[-*] \[x\]/gim) ?? []).length
                  const words = n.body.trim() ? n.body.trim().split(/\s+/).length : 0
                  const staleDays = Math.floor((Date.now() - new Date(n.updatedAt).getTime()) / 86400000)
                  return `id:${n.id} "${n.title}" | updated ${n.updatedAt.slice(0, 10)} (${staleDays}d ago) | ${words} words | ${open} open / ${done} done tasks\n  excerpt: ${n.body.replace(/\s+/g, ' ').slice(0, 200) || '(empty)'}`
                }).join('\n')
              : 'no notes in scope'
            break
          }
          case 'save_preference': {
            const pref = String(args.preference ?? '').trim()
            if (pref) {
              const existing = (await getSetting('ai-preferences').catch(() => '')) || ''
              await putSetting('ai-preferences', existing ? `${existing}\n- ${pref}` : `- ${pref}`)
              result = 'preference saved'
            } else {
              result = 'error: empty preference'
            }
            break
          }
          default:
            result = `error: unknown tool ${call.name}`
        }
      } catch (err) {
        result = `error: ${err instanceof Error ? err.message : String(err)}`
      }
      // Surface a friendly activity line in the chat UI
      if (onProgress) {
        const friendly: Record<string, string> = {
          create_note: 'Creating note', append_to_note: 'Appending to note',
          replace_note_body: 'Rewriting note', open_note: 'Opening note',
          delete_note: 'Deleting note', move_note: 'Moving note',
          read_note: 'Reading note', search_notes: 'Searching notes',
          review_vault: 'Scanning vault', save_preference: 'Saving preference',
        }
        const failed = result.startsWith('error')
        onProgress(`${failed ? '\u26a0' : '\u2713'} ${friendly[call.name] ?? call.name}${failed ? ` — ${result}` : ''}`)
      }
      messages.push(new ToolMessage({ content: result, tool_call_id: call.id ?? '' }))
    }
  }
  return 'I hit the tool-call limit for this request — the actions so far have been applied.'
}
