import { ChatOpenAI } from '@langchain/openai'
import {
  SystemMessage, HumanMessage, AIMessage, ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { Note, ChatMessage } from './db'

export interface AIActions {
  createNote(title: string, body: string, folderName?: string): number
  appendToNote(noteId: number, text: string): boolean
  replaceNoteBody(noteId: number, body: string): boolean
  openNote(noteId: number): boolean
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
]

function buildSystemPrompt(notes: Note[], activeId: number | null): string {
  const index = notes
    .map((n) => {
      const preview = n.body.replace(/\s+/g, ' ').slice(0, 120)
      return `- id:${n.id} | "${n.title}" | created ${n.createdAt.slice(0, 10)} | updated ${n.updatedAt.slice(0, 10)}${n.id === activeId ? ' | (CURRENTLY OPEN)' : ''}\n  preview: ${preview || '(empty)'}`
    })
    .join('\n')

  const active = notes.find((n) => n.id === activeId)

  return `You are Chaboxer AI, an assistant living inside a markdown notepad app.
Today's date: ${new Date().toISOString().slice(0, 10)}.

You can read all the user's notes, summarize and analyse them, and take actions with tools:
create_note, append_to_note, replace_note_body, open_note.

Rules:
- When the user asks you to write/save/take notes, use the tools — don't just answer in chat.
- After creating or editing a note, call open_note so the user sees it.
- Write note bodies in rich markdown (headings, lists, tasks, **bold**, tables where useful).
- When summarizing chats or notes, be concise and structured.
- Dates matter: notes carry created/updated dates; use them when the user asks about "recent", "today", "this week", etc.

NOTE INDEX (${notes.length} notes):
${index || '(no notes yet)'}

${active ? `FULL CONTENT OF CURRENTLY OPEN NOTE (id:${active.id}, "${active.title}"):\n${active.body || '(empty)'}` : ''}`
}

export async function runAI(
  apiKey: string,
  userInput: string,
  history: ChatMessage[],
  notes: Note[],
  activeId: number | null,
  actions: AIActions,
): Promise<string> {
  const model = new ChatOpenAI({
    apiKey,
    model: 'gpt-4o-mini',
    temperature: 0.4,
  }).bindTools(TOOLS)

  // Memory: replay persisted chat history (last 30 messages) for context
  const messages: BaseMessage[] = [new SystemMessage(buildSystemPrompt(notes, activeId))]
  for (const m of history.slice(-30)) {
    messages.push(m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content))
  }
  messages.push(new HumanMessage(userInput))

  // Tool-calling loop
  for (let step = 0; step < 6; step++) {
    const response = await model.invoke(messages)
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
        switch (call.name) {
          case 'create_note': {
            const id = actions.createNote(
              String(args.title ?? 'Untitled'),
              String(args.body ?? ''),
              args.folderName ? String(args.folderName) : undefined,
            )
            result = `created note id:${id}`
            break
          }
          case 'append_to_note':
            result = actions.appendToNote(Number(args.noteId), String(args.text ?? ''))
              ? 'appended' : `error: note ${args.noteId} not found`
            break
          case 'replace_note_body':
            result = actions.replaceNoteBody(Number(args.noteId), String(args.body ?? ''))
              ? 'replaced' : `error: note ${args.noteId} not found`
            break
          case 'open_note':
            result = actions.openNote(Number(args.noteId))
              ? 'opened' : `error: note ${args.noteId} not found`
            break
          default:
            result = `error: unknown tool ${call.name}`
        }
      } catch (err) {
        result = `error: ${err instanceof Error ? err.message : String(err)}`
      }
      messages.push(new ToolMessage({ content: result, tool_call_id: call.id ?? '' }))
    }
  }
  return 'I hit the tool-call limit for this request — the actions so far have been applied.'
}
