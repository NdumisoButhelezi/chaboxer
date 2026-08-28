import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  getAllNotes, putNote, deleteNoteDB,
  getAllFolders, putFolder, deleteFolderDB,
  getChatHistory, putChatMessage, clearChatHistory,
  getSetting, putSetting,
  type Note, type Folder, type ChatMessage,
} from './db'
import type { AIActions, PendingAction, ApprovalDecision } from './ai'
import type { User } from 'firebase/auth'
import { renderMarkdown } from './markdown'
import GraphView from './GraphView'
import './App.css'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DEFAULT_AI_MODEL = (import.meta.env.VITE_OPENAI_MODEL as string | undefined) || 'stealth/ox-alpha'

// Simple LCS line diff for the AI approval card
function lineDiff(oldText: string, newText: string): { type: ' ' | '+' | '-'; line: string }[] {
  const a = oldText.split('\n'), b = newText.split('\n')
  const m = a.length, n = b.length
  if (m * n > 250000) {
    // too large for O(m*n) — show as full replace
    return [...a.map((line) => ({ type: '-' as const, line })), ...b.map((line) => ({ type: '+' as const, line }))]
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: { type: ' ' | '+' | '-'; line: string }[] = []
  let i = 0, j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ type: ' ', line: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: '-', line: a[i] }); i++ }
    else { out.push({ type: '+', line: b[j] }); j++ }
  }
  while (i < m) out.push({ type: '-', line: a[i++] })
  while (j < n) out.push({ type: '+', line: b[j++] })
  return out
}

const FileIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
)

const FolderIcon = ({ open }: { open: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {open
      ? <path d="M6 14l1.45-4.34A2 2 0 0 1 9.36 8H22l-2.55 7.66A2 2 0 0 1 17.55 17H2a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2" transform="scale(0.92) translate(1,1)" />
      : <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />}
  </svg>
)

function App() {
  const [notes, setNotes] = useState<Note[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [activeId, setActiveId] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [search, setSearch] = useState('')
  const [preview, setPreview] = useState(false)
  const [renamingFolder, setRenamingFolder] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [showGraph, setShowGraph] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [showTrash, setShowTrash] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [slashMenu, setSlashMenu] = useState<{ pos: number } | null>(null)
  const [lightTheme, setLightTheme] = useState(false)
  const [fontSize, setFontSize] = useState<'s' | 'm' | 'l'>('m')
  const [recording, setRecording] = useState(false)
  const [tagBusy, setTagBusy] = useState(false)
  const recognitionRef = useRef<{ stop(): void } | null>(null)
  const [mobileView, setMobileView] = useState<'list' | 'editor'>('list')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(300)
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const [openTabs, setOpenTabs] = useState<number[]>([])
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  // AI chat state
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [agentActivity, setAgentActivity] = useState<string[]>([])
  const [aiMenuOpen, setAiMenuOpen] = useState(false)
  // Session browser: null = closed, otherwise list of past sessions
  const [sessionList, setSessionList] = useState<{ id: number; title: string; count: number; last: string }[] | null>(null)
  // Voice: dictation into the chat input + optional spoken replies
  const [listening, setListening] = useState(false)
  const [speakReplies, setSpeakReplies] = useState(false)
  const speakRef = useRef(speakReplies)
  speakRef.current = speakReplies
  const chatRecRef = useRef<{ stop(): void } | null>(null)
  // Agent mode: true = auto-apply AI edits, false = review each edit (human in the loop)
  const [agentMode, setAgentMode] = useState(false)
  const agentModeRef = useRef(agentMode)
  agentModeRef.current = agentMode
  const [pendingAction, setPendingAction] = useState<{ action: PendingAction; resolve: (d: ApprovalDecision) => void } | null>(null)
  const [approvalDraft, setApprovalDraft] = useState<string | null>(null) // non-null = user is editing the proposal
  const [chatSession, setChatSession] = useState(0)
  const chatSessionRef = useRef(chatSession)
  chatSessionRef.current = chatSession
  const [apiKey, setApiKey] = useState('')
  const [keyInput, setKeyInput] = useState('')
  const [aiModel, setAiModel] = useState(DEFAULT_AI_MODEL)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const notesRef = useRef<Note[]>([])
  const foldersRef = useRef<Folder[]>([])
  notesRef.current = notes
  foldersRef.current = folders

  // Cloud auth state
  const [user, setUser] = useState<User | null>(null)
  const [cloudReady, setCloudReady] = useState(false)
  const [syncing, setSyncing] = useState(false)

  const activeNote = notes.find((n) => n.id === activeId)
  // Google returns the full display name; use the familiar first name in the sidebar.
  const notesOwner = user?.displayName?.trim().split(/\s+/)[0] || 'My'

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault()
      setInstallPrompt(e as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const handleInstall = async () => {
    if (!installPrompt) return
    await installPrompt.prompt()
    const { outcome } = await installPrompt.userChoice
    if (outcome === 'accepted') setInstallPrompt(null)
  }

  useEffect(() => {
    getAllNotes().then((saved) => {
      // Purge trash older than 30 days
      const cutoff = Date.now() - 30 * 24 * 3600 * 1000
      const expired = saved.filter((n) => n.deletedAt && new Date(n.deletedAt).getTime() < cutoff)
      expired.forEach((n) => deleteNoteDB(n.id))
      setNotes(saved.filter((n) => !expired.includes(n)))
      // First run: seed tutorial notes that demo folders, markdown, links, tags & graph
      getSetting('tutorial-seeded').then((done) => {
        if (done || saved.length > 0) return
        putSetting('tutorial-seeded', '1')
        const now = new Date().toISOString()
        const folder: Folder = { id: Date.now() - 10, name: 'Getting Started', createdAt: now }
        putFolder(folder)
        setFolders((prev) => [...prev, folder])
        const seeded: Note[] = [
          {
            id: Date.now(),
            title: 'Welcome to Chaboxer',
            body: [
              '# Welcome! \u{1F44B}',
              '',
              'This is your **markdown notepad** with folders, AI, cloud sync and a graph view. Here\u2019s the tour \u2014 open these notes too: [[Markdown Cheatsheet]] and [[Power Features]].',
              '',
              '## The basics',
              '- Click **New page** to create a note \u2014 it saves automatically',
              '- Click **New folder**, then **drag notes into folders** to organise',
              '- Double-click a folder name to rename it',
              '- Use the **search box** to find anything by title or content',
              '- Hit **Preview** in the toolbar to render your markdown beautifully',
              '',
              '## Try this right now',
              '- [ ] Toggle **Preview** on this note',
              '- [ ] Click the [[Markdown Cheatsheet]] link in preview',
              '- [ ] Open **Graph view** in the sidebar to see these notes connected',
              '- [ ] Sign in with Google to sync notes to your other devices',
              '',
              '#tutorial',
            ].join('\n'),
            date: today(), folderId: folder.id, createdAt: now, updatedAt: now,
          },
          {
            id: Date.now() + 1,
            title: 'Markdown Cheatsheet',
            body: [
              '# Markdown Cheatsheet',
              '',
              '**bold** \u2192 `**bold**` \u00b7 *italic* \u2192 `*italic*` \u00b7 ~~strike~~ \u2192 `~~strike~~` \u00b7 ==highlight== \u2192 `==highlight==`',
              '',
              '## Headings',
              'Start a line with `#`, `##`, `###`...',
              '',
              '## Lists',
              '- Bullet: start with `-`',
              '1. Numbered: start with `1.`',
              '- [ ] Task: `- [ ]` (Enter continues the list automatically!)',
              '- [x] Done task: `- [x]`',
              '',
              '## More',
              '> Quote: start with `>`',
              '',
              '```',
              'Code block: wrap in triple backticks',
              '```',
              '',
              'Link notes with `[[Note Title]]` \u2192 [[Welcome to Chaboxer]]',
              'Tag anything with `#hashtags` \u2192 they become hubs in Graph view',
              '',
              '## Keyboard shortcuts',
              '- **Ctrl+B** bold \u00b7 **Ctrl+I** italic \u00b7 **Ctrl+E** code \u00b7 **Ctrl+S** save',
              '',
              '#tutorial',
            ].join('\n'),
            date: today(), folderId: folder.id, createdAt: now, updatedAt: now,
          },
          {
            id: Date.now() + 2,
            title: 'Power Features',
            body: [
              '# Power Features \u26A1',
              '',
              '## \u2726 AI Assistant',
              'Open it with the **\u2726 AI** button in the toolbar. It can read all your notes and:',
              '- "Summarize my notes from this week"',
              '- "Create a note with a meal plan in a folder called Health"',
              '- "Clean up and reformat the open note"',
              '',
              '## \u{1F578} Graph view',
              'Click **Graph view** in the sidebar. Notes are blue, #tags are green hubs, folders are yellow hubs. Drag nodes, scroll to zoom, click a note to open it.',
              '',
              '## \u2601 Cloud sync',
              'Sign in with Google and your notes follow you to any phone or computer \u2014 in realtime.',
              '',
              '## \u{1F4F1} Install as an app',
              'Use the **Install App** button (when offered by your browser) to add Chaboxer to your home screen.',
              '',
              '#tutorial #power-user',
            ].join('\n'),
            date: today(), folderId: folder.id, createdAt: now, updatedAt: now,
          },
        ]
        seeded.forEach((n) => putNote(n))
        setNotes((prev) => [...seeded, ...prev])
      })
    })
    getAllFolders().then((f) => setFolders((prev) => [...prev, ...f.filter((x) => !prev.some((p) => p.id === x.id))]))
    // Load only the current chat session; older sessions stay stored for context/learning
    getSetting('chat-session-id').then((s) => {
      const sess = s ? Number(s) : 0
      setChatSession(sess)
      getChatHistory().then((all) => setChatMessages(all.filter((m) => (m.sessionId ?? 0) === sess)))
    })
    // Local servers such as Ollama need no key. Hosted endpoints (including
    // OpenRouter) still need the user's API key, so keep the setup visible.
    const envKey = (import.meta.env.VITE_OPENAI_API_KEY as string | undefined) || ''
    const envBase = (import.meta.env.VITE_OPENAI_BASE_URL as string | undefined) || ''
    const localBackend = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(envBase)
    if (envKey || (envBase && localBackend)) {
      setApiKey(envKey || 'backend-configured')
    } else {
      getSetting('openai-api-key').then((k) => { if (k) setApiKey(k) })
    }
    getSetting('theme').then((t) => { if (t === 'light') setLightTheme(true) })
    getSetting('font-size').then((f) => { if (f === 's' || f === 'l') setFontSize(f) })
    getSetting('sidebar-width').then((value) => {
      const width = Number(value)
      if (Number.isFinite(width) && width >= 220 && width <= 600) setSidebarWidth(width)
    })
    getSetting('ai-agent-mode').then((v) => { if (v === 'on') setAgentMode(true) })
    getSetting('ai-speak').then((v) => { if (v === 'on') setSpeakReplies(true) })
    getSetting('ai-model').then((model) => { if (model) setAiModel(model) })
  }, [])

  // Firebase auth + realtime sync
  useEffect(() => {
    let unwatch: (() => void) | undefined
    let cancelled = false
    import('./cloud').then((cloud) => {
      if (cancelled || !cloud.isCloudConfigured) return
      setCloudReady(true)
      unwatch = cloud.watchAuth(async (u) => {
        setUser(u)
        if (u) {
          setSyncing(true)
          try {
            await cloud.startSync(u.uid, setNotes, setFolders)
          } finally {
            setSyncing(false)
          }
        } else {
          cloud.stopSync()
        }
      })
    })
    return () => { cancelled = true; unwatch?.() }
  }, [])

  const handleSignIn = async () => {
    const cloud = await import('./cloud')
    try {
      await cloud.signInWithGoogle()
    } catch (err) {
      window.alert(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleSignOut = async () => {
    const cloud = await import('./cloud')
    await cloud.signOut()
    setUser(null)
  }

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages, aiBusy, pendingAction, streamText, agentActivity])

  const today = () =>
    new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  const addNote = (folderId: number | null = null, noteTitle = 'Untitled', noteBody = '') => {
    const now = new Date().toISOString()
    const newNote: Note = {
      id: Date.now(), title: noteTitle, body: noteBody, date: today(),
      folderId, createdAt: now, updatedAt: now,
    }
    setNotes((prev) => [newNote, ...prev])
    setActiveId(newNote.id)
    setTitle(newNote.title)
    setBody(newNote.body)
    setPreview(false)
    setShowGraph(false)
    setMobileView('editor')
    putNote(newNote)
  }

  // Templates
  const TEMPLATES: { name: string; icon: string; title: () => string; body: () => string }[] = [
    {
      name: 'Daily journal', icon: '\u{1F4C6}',
      title: () => `Journal — ${today()}`,
      body: () => `# ${today()}\n\n## How I feel\n\n\n## What happened today\n- \n\n## Grateful for\n1. \n\n## Tomorrow\n- [ ] \n\n#journal`,
    },
    {
      name: 'Meeting notes', icon: '\u{1F91D}',
      title: () => `Meeting — ${today()}`,
      body: () => `# Meeting — ${today()}\n\n**Attendees:** \n**Agenda:** \n\n## Notes\n- \n\n## Decisions\n- \n\n## Action items\n- [ ] \n\n#meeting`,
    },
    {
      name: 'To-do list', icon: '\u2705',
      title: () => `To-do — ${today()}`,
      body: () => `# To-do\n\n## Today\n- [ ] \n\n## This week\n- [ ] \n\n## Someday\n- [ ] \n\n#todo`,
    },
  ]

  const dailyKey = () => new Date().toISOString().slice(0, 10)

  // Open (or create) today's daily note
  const openDailyNote = () => {
    const existing = notesRef.current.find((n) => n.title === dailyKey() && !n.deletedAt)
    if (existing) selectNote(existing)
    else addNote(null, dailyKey(), `# ${today()}\n\n`)
  }

  const addFolder = () => {
    const folder: Folder = { id: Date.now(), name: 'New Folder', createdAt: new Date().toISOString() }
    setFolders((prev) => [...prev, folder])
    putFolder(folder)
    setRenamingFolder(folder.id)
    setRenameValue(folder.name)
  }

  const renameFolder = (id: number) => {
    const name = renameValue.trim()
    setRenamingFolder(null)
    if (!name) return
    const folder = { id, name }
    setFolders((prev) => prev.map((f) => (f.id === id ? folder : f)).sort((a, b) => a.name.localeCompare(b.name)))
    putFolder(folder)
  }

  const deleteFolder = (id: number) => {
    if (!window.confirm('Delete folder? Notes inside will move to the root.')) return
    setFolders((prev) => prev.filter((f) => f.id !== id))
    deleteFolderDB(id)
    setNotes((prev) =>
      prev.map((n) => {
        if (n.folderId === id) {
          const moved = { ...n, folderId: null }
          putNote(moved)
          return moved
        }
        return n
      })
    )
  }

  const toggleFolder = (id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const moveNote = (noteId: number, folderId: number | null) => {
    setNotes((prev) =>
      prev.map((n) => {
        if (n.id === noteId) {
          const moved = { ...n, folderId }
          putNote(moved)
          return moved
        }
        return n
      })
    )
  }

  const selectNote = (note: Note) => {
    save()
    const lastOpenedAt = new Date().toISOString()
    const openedNote = { ...note, lastOpenedAt }
    setNotes((prev) => prev.map((item) => item.id === note.id ? openedNote : item))
    putNote(openedNote)
    setOpenTabs((tabs) => [note.id, ...tabs.filter((id) => id !== note.id)])
    setActiveId(note.id)
    setTitle(note.title)
    setBody(note.body)
    setPreview(false)
    setShowGraph(false)
    setMobileView('editor')
  }

  const openNoteById = (id: number) => {
    const note = notesRef.current.find((n) => n.id === id)
    if (note) selectNote(note)
  }

  // Clicking a [[wikilink]] in preview or chat opens that note (by id when present)
  const handlePreviewClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest('.wikilink')
    if (!el) return
    // On mobile the chat covers the screen — close it so the note is visible
    if (window.innerWidth <= 900) setChatOpen(false)
    const idAttr = el.getAttribute('data-note-id')
    if (idAttr) {
      const byId = notesRef.current.find((n) => n.id === Number(idAttr) && !n.deletedAt)
      if (byId) { selectNote(byId); return }
    }
    const name = el.textContent?.trim()
    if (!name) return
    const existing = notesRef.current.find((n) => n.title.toLowerCase() === name.toLowerCase())
    if (existing) {
      selectNote(existing)
    } else {
      const now = new Date().toISOString()
      const note: Note = {
        id: Date.now(), title: name, body: '', date: today(),
        folderId: null, createdAt: now, updatedAt: now,
      }
      setNotes((prev) => [note, ...prev])
      putNote(note)
      selectNote(note)
    }
  }

  const goBack = () => {
    save()
    setMobileView('list')
  }

  const toggleSidebar = () => setSidebarOpen((s) => !s)

  const startSidebarResize = (event: React.PointerEvent<HTMLDivElement>) => {
    // On phones the sidebar fills the screen, so there is nothing useful to resize.
    if (window.innerWidth <= 640) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth
    setResizingSidebar(true)

    const onMove = (moveEvent: PointerEvent) => {
      // Keep enough editor space available while allowing a comfortably wide sidebar.
      const maxWidth = Math.min(600, Math.max(280, window.innerWidth - 320))
      setSidebarWidth(Math.min(maxWidth, Math.max(220, startWidth + moveEvent.clientX - startX)))
    }
    const onUp = () => {
      setResizingSidebar(false)
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onUp)
      // Persist the final size, rather than writing on every pointer movement.
      setSidebarWidth((width) => { putSetting('sidebar-width', String(width)); return width })
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onUp)
  }

  // Close the open note: save it, then return to the note list / empty state
  const closeNote = () => {
    save()
    setActiveId(null)
    setTitle('')
    setBody('')
    setPreview(false)
    setMobileView('list')
  }

  const closeTab = (id: number) => {
    const remaining = openTabs.filter((tabId) => tabId !== id)
    setOpenTabs(remaining)
    if (activeId !== id) return
    const next = remaining.map((tabId) => notesRef.current.find((note) => note.id === tabId)).find((note): note is Note => Boolean(note))
    if (next) selectNote(next)
    else closeNote()
  }

  // Escape closes things in priority order: help modal → AI chat → open note
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || slashMenu || renamingFolder !== null || pendingAction) return
      if (showHelp) setShowHelp(false)
      else if (chatOpen) setChatOpen(false)
      else if (activeId !== null) closeNote()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const save = useCallback(() => {
    if (activeId === null) return
    setNotes((prev) =>
      prev.map((n) =>
        n.id === activeId
          ? (() => {
              const updated: Note = {
                ...n, title: title || 'Untitled', body,
                date: today(), updatedAt: new Date().toISOString(),
              }
              putNote(updated)
              return updated
            })()
          : n
      )
    )
  }, [activeId, title, body])

  const deleteNote = (id: number) => {
    // Soft-delete: move to trash for 30 days
    setNotes((prev) =>
      prev.map((n) => {
        if (n.id === id) {
          const trashed = { ...n, deletedAt: new Date().toISOString() }
          putNote(trashed)
          return trashed
        }
        return n
      })
    )
    if (activeId === id) {
      setActiveId(null)
      setTitle('')
      setBody('')
    }
  }

  const restoreNote = (id: number) => {
    setNotes((prev) =>
      prev.map((n) => {
        if (n.id === id) {
          const restored = { ...n, deletedAt: null }
          putNote(restored)
          return restored
        }
        return n
      })
    )
  }

  const deleteForever = (id: number) => {
    if (!window.confirm('Delete permanently? This cannot be undone.')) return
    setNotes((prev) => prev.filter((n) => n.id !== id))
    deleteNoteDB(id)
  }

  const togglePin = (id: number) => {
    setNotes((prev) =>
      prev.map((n) => {
        if (n.id === id) {
          const updated = { ...n, pinned: !n.pinned }
          putNote(updated)
          return updated
        }
        return n
      })
    )
  }

  // Export
  const download = (filename: string, content: string, type = 'text/markdown') => {
    const url = URL.createObjectURL(new Blob([content], { type }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const exportNote = () => {
    if (!activeNote) return
    download(`${activeNote.title.replace(/[\\/:*?"<>|]/g, '-')}.md`, `# ${activeNote.title}\n\n${body}`)
  }

  const safeName = () => (activeNote?.title ?? 'note').replace(/[\\/:*?"<>|]/g, '-')

  // Full HTML document of a rendered note (used by PDF and Word exports).
  // For the open note, use the live editor body (may have unsaved edits).
  const noteAsHtml = (note: Note) => {
    const noteBody = note.id === activeId ? body : note.body
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${note.title}</title>
<style>
body{font-family:Georgia,'Times New Roman',serif;max-width:720px;margin:40px auto;padding:0 24px;color:#1a1a2e;line-height:1.7}
h1,h2,h3{color:#0f172a;line-height:1.3}
code{background:#f1f5f9;border-radius:4px;padding:1px 5px;font-family:Consolas,monospace;font-size:0.9em}
pre{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;overflow-x:auto}
blockquote{border-left:3px solid #64748b;margin:0.6em 0;padding:2px 0 2px 14px;color:#475569}
mark{background:#fef08a}
.tag{color:#059669}
.wikilink{color:#7c3aed;border-bottom:1px dashed #7c3aed}
.meta{color:#94a3b8;font-size:13px;margin-bottom:24px}
li.task{list-style:none;margin-left:-20px}
</style></head><body>
<h1>${note.title}</h1>
<div class="meta">Created ${fmtDate(note.createdAt)} · Updated ${fmtDate(note.updatedAt)}</div>
${renderMarkdown(noteBody)}
</body></html>`
  }

  const noteSafeName = (note: Note) => note.title.replace(/[\\/:*?"<>|]/g, '-')

  // PDF via the browser's print-to-PDF dialog
  const exportPdf = (note?: Note) => {
    const target = note ?? activeNote
    if (!target) return
    const win = window.open('', '_blank')
    if (!win) { window.alert('Pop-up blocked — allow pop-ups to export PDF.'); return }
    win.document.write(noteAsHtml(target))
    win.document.close()
    win.focus()
    setTimeout(() => win.print(), 300)
  }

  // Word opens HTML saved with a .doc extension natively
  const exportWord = (note?: Note) => {
    const target = note ?? activeNote
    if (!target) return
    download(`${noteSafeName(target)}.doc`, noteAsHtml(target), 'application/msword')
  }

  // LLM-ready prompt: note + context, copied to clipboard
  const exportPrompt = async (scope: 'note' | 'vault') => {
    const header = [
      'You are my assistant. Below are my personal notes exported from my notepad app.',
      'Read them carefully, then help me with whatever I ask next — you may summarize,',
      'answer questions, find connections, or continue writing in the same style and language.',
      'Treat [[double brackets]] as links between notes and #words as topic tags.',
      '',
      '=== NOTES START ===',
    ].join('\n')
    let content: string
    if (scope === 'note' && activeNote) {
      content = `## ${activeNote.title}\n(created ${fmtDate(activeNote.createdAt)}, updated ${fmtDate(activeNote.updatedAt)})\n\n${body}`
    } else {
      content = notesRef.current
        .filter((n) => !n.deletedAt)
        .map((n) => {
          const folder = foldersRef.current.find((f) => f.id === n.folderId)
          return `## ${n.title}\n(folder: ${folder?.name ?? 'none'} · created ${fmtDate(n.createdAt)} · updated ${fmtDate(n.updatedAt)})\n\n${n.body}`
        })
        .join('\n\n---\n\n')
    }
    const prompt = `${header}\n\n${content}\n\n=== NOTES END ===\n\nMy first request: `
    try {
      await navigator.clipboard.writeText(prompt)
      window.alert(`Prompt copied to clipboard (${prompt.length.toLocaleString()} characters). Paste it into ChatGPT, Claude, Gemini or any LLM.`)
    } catch {
      download(`${scope === 'note' ? safeName() : 'chaboxer-vault'}-prompt.txt`, prompt, 'text/plain')
    }
  }

  const exportVault = () => {
    const live = notesRef.current.filter((n) => !n.deletedAt)
    const md = live
      .map((n) => {
        const folder = foldersRef.current.find((f) => f.id === n.folderId)
        return `---\ntitle: ${n.title}\nfolder: ${folder?.name ?? ''}\ncreated: ${n.createdAt}\nupdated: ${n.updatedAt}\n---\n\n# ${n.title}\n\n${n.body}`
      })
      .join('\n\n\n')
    download(`chaboxer-vault-${dailyKey()}.md`, md)
  }

  const copyNote = async () => {
    await navigator.clipboard.writeText(body)
  }

  // Force-refresh: clear caches + service worker so the newest deploy loads
  const hardRefresh = async () => {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map((r) => r.unregister()))
      }
      if ('caches' in window) {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
      }
    } finally {
      window.location.reload()
    }
  }

  // Theme & font size
  const toggleTheme = () => {
    const next = !lightTheme
    setLightTheme(next)
    putSetting('theme', next ? 'light' : 'dark')
  }

  const cycleFontSize = () => {
    const next = fontSize === 's' ? 'm' : fontSize === 'm' ? 'l' : 's'
    setFontSize(next)
    putSetting('font-size', next)
  }

  // Voice dictation (Web Speech API)
  const toggleVoice = () => {
    if (recording) {
      recognitionRef.current?.stop()
      setRecording(false)
      return
    }
    const w = window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown }
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition
    if (!Ctor) {
      window.alert('Voice input is not supported in this browser. Try Chrome or Android.')
      return
    }
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const rec = new (Ctor as any)()
    rec.continuous = true
    rec.interimResults = false
    rec.onresult = (e: any) => {
      let transcript = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) transcript += e.results[i][0].transcript
      }
      if (transcript) setBody((prev) => (prev ? `${prev} ${transcript.trim()}` : transcript.trim()))
    }
    rec.onend = () => setRecording(false)
    rec.onerror = () => setRecording(false)
    /* eslint-enable @typescript-eslint/no-explicit-any */
    recognitionRef.current = rec
    rec.start()
    setRecording(true)
  }

  // AI auto-tagging
  const autoTag = async () => {
    if (!activeNote || !apiKey || tagBusy) return
    setTagBusy(true)
    try {
      const { suggestTags } = await import('./ai')
      const titles = notesRef.current.filter((n) => !n.deletedAt && n.id !== activeId).map((n) => n.title)
      const line = await suggestTags(apiKey, { ...activeNote, body }, titles, aiModel)
      if (line) setBody((prev) => `${prev.trimEnd()}\n\n${line}\n`)
    } catch (err) {
      window.alert(`Auto-tag failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setTagBusy(false)
    }
  }

  // Wrap selection with markdown markers, or insert a line prefix
  const applyFormat = (before: string, after = before, block = false) => {
    const ta = bodyRef.current
    if (!ta) return
    const { selectionStart: s, selectionEnd: e } = ta
    let next: string
    let cursor: number
    if (block) {
      const lineStart = body.lastIndexOf('\n', s - 1) + 1
      next = body.slice(0, lineStart) + before + body.slice(lineStart)
      cursor = e + before.length
    } else {
      next = body.slice(0, s) + before + body.slice(s, e) + after + body.slice(e)
      cursor = e + before.length
    }
    setBody(next)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(cursor, cursor)
    })
  }

  const handleBodyKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashMenu && (e.key === 'Escape' || e.key === 'Backspace')) setSlashMenu(null)
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'b') { e.preventDefault(); applyFormat('**') }
      else if (e.key === 'i') { e.preventDefault(); applyFormat('*') }
      else if (e.key === 'e') { e.preventDefault(); applyFormat('`') }
      else if (e.key === 's') { e.preventDefault(); save() }
      return
    }
    // Slash command menu at the start of a line
    if (e.key === '/') {
      const ta = e.currentTarget
      const s = ta.selectionStart
      const lineStart = body.lastIndexOf('\n', s - 1) + 1
      if (body.slice(lineStart, s).trim() === '') {
        setSlashMenu({ pos: s })
      }
    }
    // Continue lists on Enter
    if (e.key === 'Enter') {
      const ta = e.currentTarget
      const s = ta.selectionStart
      const lineStart = body.lastIndexOf('\n', s - 1) + 1
      const line = body.slice(lineStart, s)
      const m = line.match(/^(\s*)([-*+]\s+(\[ \]\s+)?|\d+[.)]\s+)/)
      if (m) {
        if (line.trim() === m[0].trim()) return // empty list item, allow default
        e.preventDefault()
        let prefix = m[1] + m[2]
        const num = m[2].match(/^(\d+)([.)])\s+$/)
        if (num) prefix = `${m[1]}${Number(num[1]) + 1}${num[2]} `
        if (m[3]) prefix = `${m[1]}- [ ] `
        const next = body.slice(0, s) + '\n' + prefix + body.slice(s)
        setBody(next)
        requestAnimationFrame(() => {
          ta.setSelectionRange(s + 1 + prefix.length, s + 1 + prefix.length)
        })
      }
    }
  }

  // Slash command insertions (replaces the typed '/')
  const SLASH_COMMANDS: { label: string; icon: string; insert: () => string }[] = [
    { label: 'Heading 1', icon: 'H1', insert: () => '# ' },
    { label: 'Heading 2', icon: 'H2', insert: () => '## ' },
    { label: 'Bullet list', icon: '\u2022', insert: () => '- ' },
    { label: 'Numbered list', icon: '1.', insert: () => '1. ' },
    { label: 'Task', icon: '\u2611', insert: () => '- [ ] ' },
    { label: 'Quote', icon: '\u201C', insert: () => '> ' },
    { label: 'Code block', icon: '{}', insert: () => '```\n\n```' },
    { label: 'Divider', icon: '\u2014', insert: () => '---\n' },
    { label: 'Date stamp', icon: '\u{1F4C5}', insert: () => `**${today()}** ` },
    { label: 'Time stamp', icon: '\u23F0', insert: () => `**${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}** ` },
    { label: 'Wikilink', icon: '[[', insert: () => '[[]]' },
    { label: 'Table', icon: '\u2637', insert: () => '| Column | Column |\n| --- | --- |\n|  |  |\n' },
  ]

  const runSlashCommand = (cmd: { insert: () => string }) => {
    if (!slashMenu) return
    const text = cmd.insert()
    // Remove the '/' that opened the menu
    const next = body.slice(0, slashMenu.pos) + text + body.slice(slashMenu.pos + 1)
    setBody(next)
    setSlashMenu(null)
    requestAnimationFrame(() => {
      const ta = bodyRef.current
      if (!ta) return
      ta.focus()
      const cursor = slashMenu.pos + (text.includes('[[]]') ? text.indexOf('[[]]') + 2 : text.length)
      ta.setSelectionRange(cursor, cursor)
    })
  }

  const q = search.trim().toLowerCase()
  // Memoized: these scan every note body, so don't redo it on each editor keystroke
  const liveNotes = useMemo(() => notes.filter((n) => !n.deletedAt), [notes])
  const trashedNotes = useMemo(() => notes.filter((n) => n.deletedAt), [notes])
  const visibleNotes = useMemo(() => {
    const searched = q
      ? liveNotes.filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q))
      : liveNotes
    return [...searched].sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.id - a.id)
  }, [liveNotes, q])
  const rootNotes = useMemo(() => visibleNotes.filter((n) => n.folderId === null), [visibleNotes])
  const tabNotes = useMemo(() => {
    const byId = new Map(liveNotes.map((note) => [note.id, note]))
    return openTabs.map((id) => byId.get(id)).filter((note): note is Note => Boolean(note))
  }, [liveNotes, openTabs])

  // Backlinks: live notes whose body wikilinks to the open note's title
  const backlinks = useMemo(() => {
    if (!activeNote) return []
    const needle = `[[${activeNote.title.toLowerCase()}]]`
    return liveNotes.filter((n) => n.id !== activeNote.id && n.body.toLowerCase().includes(needle))
  }, [liveNotes, activeNote])

  const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0

  // Memoized: LCS diff is O(m·n), don't recompute while the approval card is on screen
  const approvalDiff = useMemo(() => (
    pendingAction && pendingAction.action.oldPreview !== undefined
      ? lineDiff(pendingAction.action.oldPreview, pendingAction.action.preview)
      : null
  ), [pendingAction])

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  // --- AI integration ---

  const aiActions: AIActions = {
    createNote: (noteTitle, noteBody, folderName) => {
      let folderId: number | null = null
      if (folderName) {
        const existing = foldersRef.current.find(
          (f) => f.name.toLowerCase() === folderName.toLowerCase()
        )
        if (existing) {
          folderId = existing.id
        } else {
          const folder: Folder = { id: Date.now(), name: folderName, createdAt: new Date().toISOString() }
          folderId = folder.id
          setFolders((prev) => [...prev, folder].sort((a, b) => a.name.localeCompare(b.name)))
          putFolder(folder)
        }
      }
      const now = new Date().toISOString()
      const note: Note = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        title: noteTitle, body: noteBody, date: today(),
        folderId, createdAt: now, updatedAt: now,
      }
      setNotes((prev) => [note, ...prev])
      putNote(note)
      return note.id
    },
    appendToNote: (noteId, text) => {
      const note = notesRef.current.find((n) => n.id === noteId)
      if (!note) return false
      const updated: Note = {
        ...note,
        body: note.body ? `${note.body}\n\n${text}` : text,
        date: today(), updatedAt: new Date().toISOString(),
      }
      setNotes((prev) => prev.map((n) => (n.id === noteId ? updated : n)))
      putNote(updated)
      if (activeId === noteId) setBody(updated.body)
      return true
    },
    replaceNoteBody: (noteId, newBody) => {
      const note = notesRef.current.find((n) => n.id === noteId)
      if (!note) return false
      const updated: Note = { ...note, body: newBody, date: today(), updatedAt: new Date().toISOString() }
      setNotes((prev) => prev.map((n) => (n.id === noteId ? updated : n)))
      putNote(updated)
      if (activeId === noteId) setBody(newBody)
      return true
    },
    openNote: (noteId) => {
      const note = notesRef.current.find((n) => n.id === noteId)
      if (!note) return false
      setActiveId(note.id)
      setTitle(note.title)
      setBody(note.body)
      setPreview(true)
      setMobileView('editor')
      return true
    },
    deleteNote: (noteId) => {
      const note = notesRef.current.find((n) => n.id === noteId && !n.deletedAt)
      if (!note) return false
      deleteNote(noteId)
      return true
    },
    moveNote: (noteId, folderName) => {
      const note = notesRef.current.find((n) => n.id === noteId)
      if (!note) return false
      let folderId: number | null = null
      if (folderName) {
        const existing = foldersRef.current.find((f) => f.name.toLowerCase() === folderName.toLowerCase())
        if (existing) {
          folderId = existing.id
        } else {
          const folder: Folder = { id: Date.now(), name: folderName, createdAt: new Date().toISOString() }
          folderId = folder.id
          setFolders((prev) => [...prev, folder].sort((a, b) => a.name.localeCompare(b.name)))
          putFolder(folder)
        }
      }
      moveNote(noteId, folderId)
      return true
    },
  }

  const saveApiKey = () => {
    const k = keyInput.trim()
    if (!k) return
    setApiKey(k)
    putSetting('openai-api-key', k)
    setKeyInput('')
  }

  const analyzeGraph = () => {
    setChatOpen(true)
    if (!apiKey || !aiModel.trim() || aiBusy) return
    const prompt = 'Analyze the current vault graph'
    const userMsg: ChatMessage = {
      id: Date.now(), role: 'user', content: prompt, createdAt: new Date().toISOString(),
      sessionId: chatSessionRef.current,
    }
    setChatMessages((prev) => [...prev, userMsg])
    putChatMessage(userMsg)
    setAiBusy(true)
    setAgentActivity([])
    void import('./ai').then(async ({ runGraphAnalysis }) => {
      try {
        const reply = await runGraphAnalysis(apiKey, notesRef.current.filter((note) => !note.deletedAt), aiModel,
          (activity) => setAgentActivity((prev) => [...prev, activity]))
        const aiMsg: ChatMessage = {
          id: Date.now() + 1, role: 'assistant', content: reply, createdAt: new Date().toISOString(),
          sessionId: chatSessionRef.current,
        }
        setChatMessages((prev) => [...prev, aiMsg])
        putChatMessage(aiMsg)
        if (speakRef.current) speakText(reply)
      } catch (err) {
        const aiMsg: ChatMessage = {
          id: Date.now() + 1, role: 'assistant', content: `Graph analysis failed: ${err instanceof Error ? err.message : String(err)}`,
          createdAt: new Date().toISOString(), sessionId: chatSessionRef.current,
        }
        setChatMessages((prev) => [...prev, aiMsg])
        putChatMessage(aiMsg)
      } finally {
        setAiBusy(false)
        setAgentActivity([])
      }
    })
  }

  const toggleAgentMode = () => {
    setAgentMode((prev) => {
      putSetting('ai-agent-mode', prev ? 'off' : 'on')
      return !prev
    })
  }

  const changeAIModel = (model: string) => {
    const next = model.trim()
    setAiModel(next)
    putSetting('ai-model', next)
  }

  // Human-in-the-loop gate: resolves when the user approves/rejects in the chat UI
  const requestApproval = (action: PendingAction): Promise<ApprovalDecision> => {
    if (agentModeRef.current) return Promise.resolve({ ok: true })
    return new Promise<ApprovalDecision>((resolve) => setPendingAction({ action, resolve }))
  }

  const resolvePending = (ok: boolean, alwaysAllow = false) => {
    if (alwaysAllow) {
      setAgentMode(true)
      agentModeRef.current = true
      putSetting('ai-agent-mode', 'on')
    }
    if (pendingAction) {
      // Persist the human decision — context for future turns + reinforcement signal
      const fb: ChatMessage = {
        id: Date.now(), role: 'assistant',
        content: `${ok ? '✓ Edit approved' : '✕ Edit rejected'}${approvalDraft !== null && ok ? ' (with manual edits)' : ''}: ${pendingAction.action.title}`,
        createdAt: new Date().toISOString(),
        sessionId: chatSessionRef.current,
        feedback: ok ? 'approved' : 'rejected',
      }
      setChatMessages((prev) => [...prev, fb])
      putChatMessage(fb)
      pendingAction.resolve({ ok, ...(ok && approvalDraft !== null ? { content: approvalDraft } : {}) })
    }
    setPendingAction(null)
    setApprovalDraft(null)
  }

  // Revert the most recent AI edit using the per-note changelog
  const undoLastAiEdit = async () => {
    const { getEditLog, deleteEditLog } = await import('./db')
    const log = await getEditLog()
    if (log.length === 0) { window.alert('No AI edits to undo.'); return }
    const last = log.sort((a, b) => b.id - a.id)[0]
    const note = notesRef.current.find((n) => n.id === last.noteId)
    if (last.changeType === 'insert') {
      if (note && !note.deletedAt) deleteNote(note.id)
    } else if (last.changeType === 'delete') {
      if (note) {
        const restored = { ...note, deletedAt: null }
        setNotes((prev) => prev.map((n) => (n.id === note.id ? restored : n)))
        putNote(restored)
      }
    } else if (note) {
      const reverted: Note = { ...note, body: last.before, updatedAt: new Date().toISOString() }
      setNotes((prev) => prev.map((n) => (n.id === note.id ? reverted : n)))
      putNote(reverted)
      if (activeId === note.id) setBody(last.before)
    }
    await deleteEditLog(last.id)
    const fb: ChatMessage = {
      id: Date.now(), role: 'assistant',
      content: `↶ Undid AI ${last.changeType} on "${note?.title ?? `note ${last.noteId}`}"`,
      createdAt: new Date().toISOString(), sessionId: chatSessionRef.current, feedback: 'rejected',
    }
    setChatMessages((prev) => [...prev, fb])
    putChatMessage(fb)
  }

  // Start a fresh conversation; previous sessions remain stored in IndexedDB
  const newChat = () => {
    const id = Date.now()
    setChatSession(id)
    putSetting('chat-session-id', String(id))
    setChatMessages([])
    setPendingAction(null)
    setSessionList(null)
  }

  // List past chat sessions, newest first, titled by their first user message
  const openSessions = async () => {
    const all = await getChatHistory()
    const bySession = new Map<number, ChatMessage[]>()
    for (const m of all) {
      const s = m.sessionId ?? 0
      const arr = bySession.get(s) ?? []
      arr.push(m)
      bySession.set(s, arr)
    }
    const list = [...bySession.entries()]
      .map(([id, msgs]) => ({
        id,
        title: msgs.find((m) => m.role === 'user')?.content.slice(0, 60) ?? '(no messages)',
        count: msgs.length,
        last: msgs[msgs.length - 1].createdAt,
      }))
      .sort((a, b) => b.last.localeCompare(a.last))
    setSessionList(list)
  }

  const switchSession = async (id: number) => {
    setChatSession(id)
    putSetting('chat-session-id', String(id))
    const all = await getChatHistory()
    setChatMessages(all.filter((m) => (m.sessionId ?? 0) === id))
    setSessionList(null)
    setPendingAction(null)
  }

  const sendChat = async (preset?: string) => {
    const text = (preset ?? chatInput).trim()
    if (!text || aiBusy || !apiKey || !aiModel.trim()) return
    setChatInput('')
    const userMsg: ChatMessage = {
      id: Date.now(), role: 'user', content: text, createdAt: new Date().toISOString(),
      sessionId: chatSessionRef.current,
    }
    setChatMessages((prev) => [...prev, userMsg])
    putChatMessage(userMsg)
    setAiBusy(true)
    setAgentActivity([])
    try {
      const { runAI } = await import('./ai')
      const reply = await runAI(
        apiKey, text, chatMessages, notesRef.current.filter((n) => !n.deletedAt), activeId, aiActions,
        requestApproval,
        setStreamText,
        (activity) => setAgentActivity((prev) => [...prev, activity]),
        aiModel,
      )
      const aiMsg: ChatMessage = {
        id: Date.now() + 1, role: 'assistant', content: reply, createdAt: new Date().toISOString(),
        sessionId: chatSessionRef.current,
      }
      setChatMessages((prev) => [...prev, aiMsg])
      putChatMessage(aiMsg)
      if (speakRef.current) speakText(reply)
    } catch (err) {
      const aiMsg: ChatMessage = {
        id: Date.now() + 1, role: 'assistant',
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        createdAt: new Date().toISOString(),
        sessionId: chatSessionRef.current,
      }
      setChatMessages((prev) => [...prev, aiMsg])
      putChatMessage(aiMsg)
    } finally {
      setAiBusy(false)
      setStreamText('')
      setAgentActivity([])
    }
  }

  const sendBriefing = () => sendChat(
    'Run review_vault with mode "all" and give me my briefing: a scannable per-note report (verdict + link + one remark), prioritising stale notes and open tasks over merely recent ones. Then list all open tasks grouped by note.'
  )

  const clearChat = () => {
    if (!window.confirm('Clear AI chat history (memory)?')) return
    setChatMessages([])
    clearChatHistory()
  }

  // Deterministic deep-links: rewrite known note titles in AI replies to [[id|Title]],
  // matched against real note ids — don't rely on the model following the syntax
  const linkifyNotes = (text: string) => {
    let out = text
    const live = notesRef.current
      .filter((n) => !n.deletedAt && n.title.trim().length > 2)
      .sort((a, b) => b.title.length - a.title.length)
    for (const n of live) {
      const esc = n.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // bold-wrapped or plain title → id link; skip ones already inside [[..|..]]
      out = out.replace(
        new RegExp(`\\*\\*${esc}\\*\\*|(?<![[|\\w])${esc}(?![\\]\\w])`, 'g'),
        `[[${n.id}|${n.title}]]`,
      )
    }
    return out
  }

  // Web Speech API dictation — appends the transcript to the chat input
  const toggleMic = () => {
    if (listening) {
      chatRecRef.current?.stop()
      return
    }
    type SR = { new (): { lang: string; interimResults: boolean; continuous: boolean; onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>; resultIndex: number }) => void; onend: () => void; onerror: () => void; start(): void; stop(): void } }
    const Ctor = (window as unknown as { SpeechRecognition?: SR; webkitSpeechRecognition?: SR }).SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: SR }).webkitSpeechRecognition
    if (!Ctor) { window.alert('Voice input is not supported in this browser.'); return }
    const rec = new Ctor()
    rec.lang = navigator.language || 'en-US'
    rec.interimResults = false
    rec.continuous = true
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          const t = e.results[i][0].transcript.trim()
          if (t) setChatInput((prev) => (prev ? `${prev} ${t}` : t))
        }
      }
    }
    rec.onend = () => { setListening(false); chatRecRef.current = null }
    rec.onerror = () => { setListening(false); chatRecRef.current = null }
    chatRecRef.current = rec
    setListening(true)
    rec.start()
  }

  const speakText = (md: string) => {
    if (!('speechSynthesis' in window)) return
    // Strip markdown/links so TTS reads clean prose
    const plain = md
      .replace(/\[\[\d+\|([^\]]+)\]\]/g, '$1')
      .replace(/\[\[([^\]]+)\]\]/g, '$1')
      .replace(/[#*_`>~=|-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!plain) return
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(plain.slice(0, 1200)))
  }

  const toggleSpeak = () => {
    setSpeakReplies((prev) => {
      if (prev) window.speechSynthesis?.cancel()
      putSetting('ai-speak', prev ? 'off' : 'on')
      return !prev
    })
  }

  const renderNoteItem = (note: Note) => (
    <div
      key={note.id}
      className={`note-item ${note.id === activeId ? 'active' : ''}`}
      onClick={() => (note.id === activeId ? closeNote() : selectNote(note))}
      title={note.id === activeId ? 'Click to close' : undefined}
      draggable
      onDragStart={(ev) => ev.dataTransfer.setData('text/note-id', String(note.id))}
    >
      <div className="note-item-icon">{note.pinned ? <span className="pin-glyph">{'\u{1F4CC}'}</span> : <FileIcon />}</div>
      <div className="note-item-info">
        <span className="note-item-title">{note.title}</span>
        <span className="note-item-meta">
          {note.date} &middot; {note.body.slice(0, 30) || 'Empty'}
        </span>
      </div>
      <button
        className="note-export-btn"
        onClick={(e) => { e.stopPropagation(); exportPdf(note) }}
        title="Export as PDF"
      >PDF</button>
      <button
        className="note-export-btn"
        onClick={(e) => { e.stopPropagation(); exportWord(note) }}
        title="Export as Word (.doc)"
      >DOC</button>
      <button
        className={`pin-btn ${note.pinned ? 'pinned' : ''}`}
        onClick={(e) => { e.stopPropagation(); togglePin(note.id) }}
        title={note.pinned ? 'Unpin' : 'Pin to top'}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill={note.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 17v5" />
          <path d="M9 10.76V7a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3.76a2 2 0 0 0 .59 1.42l1.82 1.82H5.59l1.82-1.82A2 2 0 0 0 9 10.76z" />
        </svg>
      </button>
      <button
        className="delete-btn"
        onClick={(e) => { e.stopPropagation(); deleteNote(note.id) }}
        title="Move to trash"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </button>
    </div>
  )

  return (
    <div className={`app ${lightTheme ? 'light' : ''} font-${fontSize}`}>
      {/* Sidebar */}
      <aside
        className={`sidebar ${mobileView === 'list' ? 'mobile-show' : 'mobile-hide'} ${sidebarOpen ? '' : 'collapsed'}`}
        style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}
      >
        <div className="sidebar-header">
          <div className="sidebar-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <span>{notesOwner} Notes</span>
            {syncing && <span className="sync-badge">syncing&hellip;</span>}
          </div>
          <button className="sidebar-close" onClick={() => setSidebarOpen(false)} title="Close sidebar" aria-label="Close sidebar">×</button>
        </div>
        <div className="sidebar-actions">
          <button className="new-page-btn" onClick={() => addNote()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New page
          </button>
          <button className="new-page-btn" onClick={openDailyNote}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            Today's note
          </button>
          <div className="template-wrap">
            <button className="new-page-btn" onClick={() => setShowTemplates(!showTemplates)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
              Templates
            </button>
            {showTemplates && (
              <div className="template-menu">
                {TEMPLATES.map((t) => (
                  <button key={t.name} onClick={() => { setShowTemplates(false); addNote(null, t.title(), t.body()) }}>
                    <span>{t.icon}</span> {t.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="new-page-btn" onClick={addFolder}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="10" x2="12" y2="16" />
              <line x1="9" y1="13" x2="15" y2="13" />
            </svg>
            New folder
          </button>
          <button className={`new-page-btn ${showGraph ? 'active-view' : ''}`} onClick={() => { save(); setShowGraph(!showGraph); setMobileView('editor') }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="5" cy="6" r="2.5" />
              <circle cx="19" cy="6" r="2.5" />
              <circle cx="12" cy="18" r="2.5" />
              <line x1="7" y1="7.5" x2="10.5" y2="16" />
              <line x1="17" y1="7.5" x2="13.5" y2="16" />
              <line x1="7.5" y1="6" x2="16.5" y2="6" />
            </svg>
            Graph view
          </button>
          <button className="new-page-btn" onClick={() => setShowHelp(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            Help &amp; tips
          </button>
          <div className="settings-row">
            <button className="setting-chip" onClick={toggleTheme} title="Toggle light/dark theme">
              {lightTheme ? '\u{1F319} Dark' : '\u2600 Light'}
            </button>
            <button className="setting-chip" onClick={cycleFontSize} title="Cycle font size">
              A{fontSize === 's' ? '\u2212' : fontSize === 'l' ? '+' : ''}
            </button>
            <button className="setting-chip" onClick={exportVault} title="Export all notes as one markdown file">
              {'\u2B07'} Vault
            </button>
            <button className="setting-chip" onClick={hardRefresh} title="Reload the app and fetch the latest version">
              {'\u27F3'} Refresh
            </button>
          </div>
          {installPrompt && (
            <button className="install-btn" onClick={handleInstall}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Install App
            </button>
          )}
        </div>
        <div className="sidebar-search">
          <input
            className="search-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search notes..."
          />
        </div>
        <div className="notes-list">
          {notes.length === 0 && folders.length === 0 && (
            <div className="empty-hint">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
              <p>No pages yet</p>
              <span>Click "New page" to get started</span>
            </div>
          )}
          {folders.map((folder) => {
            const folderNotes = visibleNotes.filter((n) => n.folderId === folder.id)
            const isOpen = !collapsed.has(folder.id)
            return (
              <div
                key={folder.id}
                className="folder"
                onDragOver={(ev) => ev.preventDefault()}
                onDrop={(ev) => {
                  ev.preventDefault()
                  const id = Number(ev.dataTransfer.getData('text/note-id'))
                  if (id) moveNote(id, folder.id)
                }}
              >
                <div className="folder-row" onClick={() => toggleFolder(folder.id)}>
                  <span className={`chevron ${isOpen ? 'open' : ''}`}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </span>
                  <span className="folder-icon"><FolderIcon open={isOpen} /></span>
                  {renamingFolder === folder.id ? (
                    <input
                      className="folder-rename-input"
                      value={renameValue}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => renameFolder(folder.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') renameFolder(folder.id)
                        if (e.key === 'Escape') setRenamingFolder(null)
                      }}
                    />
                  ) : (
                    <span
                      className="folder-name"
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        setRenamingFolder(folder.id)
                        setRenameValue(folder.name)
                      }}
                    >
                      {folder.name}
                    </span>
                  )}
                  <span className="folder-count">{folderNotes.length}</span>
                  <button
                    className="folder-action"
                    title="New note in folder"
                    onClick={(e) => { e.stopPropagation(); addNote(folder.id) }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                  <button
                    className="folder-action delete"
                    title="Delete folder"
                    onClick={(e) => { e.stopPropagation(); deleteFolder(folder.id) }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
                {isOpen && (
                  <div className="folder-notes">
                    {folderNotes.length === 0
                      ? <div className="folder-empty">Empty</div>
                      : folderNotes.map(renderNoteItem)}
                  </div>
                )}
              </div>
            )
          })}
          <div
            className="root-drop"
            onDragOver={(ev) => ev.preventDefault()}
            onDrop={(ev) => {
              ev.preventDefault()
              const id = Number(ev.dataTransfer.getData('text/note-id'))
              if (id) moveNote(id, null)
            }}
          >
            {rootNotes.map(renderNoteItem)}
          </div>
          {trashedNotes.length > 0 && (
            <div className="trash-section">
              <div className="folder-row" onClick={() => setShowTrash(!showTrash)}>
                <span className={`chevron ${showTrash ? 'open' : ''}`}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </span>
                <span className="folder-icon trash-icon">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </span>
                <span className="folder-name">Trash</span>
                <span className="folder-count">{trashedNotes.length}</span>
              </div>
              {showTrash && trashedNotes.map((note) => (
                <div key={note.id} className="note-item trashed">
                  <div className="note-item-info">
                    <span className="note-item-title">{note.title}</span>
                    <span className="note-item-meta">deleted {fmtDate(note.deletedAt!)} &middot; auto-purges in 30 days</span>
                  </div>
                  <button className="folder-action" title="Restore" onClick={() => restoreNote(note.id)}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="1 4 1 10 7 10" />
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                    </svg>
                  </button>
                  <button className="folder-action delete" title="Delete forever" onClick={() => deleteForever(note.id)}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="sidebar-footer">
          {cloudReady ? (
            user ? (
              <div className="account-row">
                {user.photoURL
                  ? <img className="account-avatar" src={user.photoURL} alt="" referrerPolicy="no-referrer" />
                  : <span className="account-avatar fallback">{(user.displayName ?? '?').charAt(0)}</span>}
                <div className="account-info">
                  <span className="account-name">{user.displayName ?? user.email}</span>
                  <span className="account-status"><i className="status-dot" /> Signed in &middot; syncing</span>
                </div>
                <button className="account-signout" onClick={handleSignOut}>Sign out</button>
              </div>
            ) : (
              <button className="google-btn" onClick={handleSignIn}>
                <svg width="14" height="14" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 0 0 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                </svg>
                Sign in with Google
              </button>
            )
          ) : (
            <span className="account-status offline">Local only &middot; not synced</span>
          )}
        </div>
      </aside>
      {sidebarOpen && <div
        className={`sidebar-resizer ${resizingSidebar ? 'is-resizing' : ''}`}
        onPointerDown={startSidebarResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        title="Drag to resize sidebar"
      />}

      {/* Editor */}
      <main className={`editor ${mobileView === 'editor' ? 'mobile-show' : 'mobile-hide'}`}>
        {/* Top tabs (desktop) - show notes as horizontal tabs in the top half */}
        <div className="top-tabs">
          <div className="tabs-list">
            {tabNotes.map((n) => (
              <button
                key={n.id}
                className={`tab-item ${n.id === activeId ? 'active' : ''}`}
                onClick={() => selectNote(n)}
                title={n.title}
              >
                <span className="tab-title">{n.title || 'Untitled'}</span>
                <span
                  className="tab-close"
                  role="button"
                  tabIndex={0}
                  aria-label={`Close ${n.title || 'Untitled'} tab`}
                  onClick={(event) => { event.stopPropagation(); closeTab(n.id) }}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); closeTab(n.id) } }}
                >×</span>
              </button>
            ))}
          </div>
        </div>
        {showGraph ? (
          <>
            <div className="editor-topbar">
              <button className="sidebar-toggle" onClick={toggleSidebar} title="Toggle sidebar">☰</button>
              <button className="back-btn" onClick={() => { setShowGraph(false); setMobileView('list') }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
                Notes
              </button>
              <span className="graph-title">Graph &middot; {notes.length} notes</span>
              <button className="graph-analyze-btn" onClick={analyzeGraph} disabled={!apiKey || aiBusy} title="Ask the configured AI to analyze this graph">
                ✦ Analyze graph
              </button>
            </div>
            <GraphView notes={liveNotes} folders={folders} activeId={activeId} onOpenNote={openNoteById} />
          </>
        ) : activeNote ? (
          <>
            <div className="editor-topbar">
              <button className="sidebar-toggle" onClick={toggleSidebar} title="Toggle sidebar">☰</button>
              <button className="back-btn" onClick={goBack}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
                Notes
              </button>
              <div className="format-toolbar">
                <button title="Bold (Ctrl+B)" onClick={() => applyFormat('**')}><b>B</b></button>
                <button title="Italic (Ctrl+I)" onClick={() => applyFormat('*')}><i>I</i></button>
                <button title="Strikethrough" onClick={() => applyFormat('~~')}><s>S</s></button>
                <button title="Highlight" onClick={() => applyFormat('==')}><span className="hl">H</span></button>
                <button title="Inline code (Ctrl+E)" onClick={() => applyFormat('`')}>{'</>'}</button>
                <span className="toolbar-sep" />
                <button title="Heading 1" onClick={() => applyFormat('# ', '', true)}>H1</button>
                <button title="Heading 2" onClick={() => applyFormat('## ', '', true)}>H2</button>
                <button title="Bullet list" onClick={() => applyFormat('- ', '', true)}>&bull;&ndash;</button>
                <button title="Task" onClick={() => applyFormat('- [ ] ', '', true)}>&#9745;</button>
                <button title="Quote" onClick={() => applyFormat('> ', '', true)}>&#8220;</button>
                <button title="Code block" onClick={() => applyFormat('```\n', '\n```')}>{'{ }'}</button>
                <span className="toolbar-sep" />
                <button
                  title={recording ? 'Stop dictation' : 'Voice dictation'}
                  className={recording ? 'active rec' : ''}
                  onClick={toggleVoice}
                >
                  {recording ? '\u23F9' : '\u{1F399}'}
                </button>
                <button title="AI: suggest #tags and [[links]]" className="ai-btn" onClick={autoTag} disabled={tagBusy || !apiKey}>
                  {tagBusy ? '\u2026' : '#\u2726'}
                </button>
                <div className="export-wrap">
                  <button title="Export" className={showExport ? 'active' : ''} onClick={() => setShowExport(!showExport)}>{'\u2B07'}</button>
                  {showExport && (
                    <div className="export-menu">
                      <button onClick={() => { setShowExport(false); exportNote() }}>{'\u{1F4C4}'} Markdown (.md)</button>
                      <button onClick={() => { setShowExport(false); exportPdf() }}>{'\u{1F4D5}'} PDF (print)</button>
                      <button onClick={() => { setShowExport(false); exportWord() }}>{'\u{1F4D8}'} Word (.doc)</button>
                      <button onClick={() => { setShowExport(false); copyNote() }}>{'\u29C9'} Copy text</button>
                      <div className="export-sep" />
                      <button onClick={() => { setShowExport(false); exportPrompt('note') }}>{'\u2726'} LLM prompt (this note)</button>
                      <button onClick={() => { setShowExport(false); exportPrompt('vault') }}>{'\u2726'} LLM prompt (all notes)</button>
                    </div>
                  )}
                </div>
                <span className="toolbar-sep" />
                <button
                  title={preview ? 'Edit' : 'Preview'}
                  className={preview ? 'active' : ''}
                  onClick={() => { save(); setPreview(!preview) }}
                >
                  {preview ? 'Edit' : 'Preview'}
                </button>
                <button
                  title="AI Assistant"
                  className={chatOpen ? 'active ai-btn' : 'ai-btn'}
                  onClick={() => setChatOpen(!chatOpen)}
                >
                  ✦ AI
                </button>
                <button title="Close note" className="close-note-btn" onClick={closeNote}>✕</button>
              </div>
            </div>
            <div className="editor-content">
              <input
                className="editor-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={save}
                placeholder="Untitled"
              />
              <div className="editor-dates">
                Created {fmtDate(activeNote.createdAt)} &middot; Updated {fmtDate(activeNote.updatedAt)}
              </div>
              {preview ? (
                <div
                  className="editor-preview"
                  onClick={handlePreviewClick}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
                />
              ) : (
                <div className="editor-body-wrap">
                  <textarea
                    ref={bodyRef}
                    className="editor-body"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    onKeyDown={handleBodyKeyDown}
                    onBlur={save}
                    placeholder="Write in markdown... type / for commands"
                  />
                  {slashMenu && (
                    <div className="slash-menu">
                      {SLASH_COMMANDS.map((cmd) => (
                        <button key={cmd.label} onMouseDown={(e) => { e.preventDefault(); runSlashCommand(cmd) }}>
                          <span className="slash-icon">{cmd.icon}</span> {cmd.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {backlinks.length > 0 && (
                <div className="backlinks">
                  <div className="backlinks-title">Linked from</div>
                  {backlinks.map((n) => (
                    <button key={n.id} className="backlink" onClick={() => selectNote(n)}>
                      {'\u{1F517}'} {n.title}
                    </button>
                  ))}
                </div>
              )}
              <div className="editor-statusbar">
                {wordCount} words &middot; {body.length} characters
              </div>
            </div>
          </>
        ) : (
          <div className="editor-empty">
            {!sidebarOpen && <button className="sidebar-toggle empty-sidebar-toggle" onClick={toggleSidebar} title="Open sidebar" aria-label="Open sidebar">☰</button>}
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <p>Select a page or create a new one</p>
            <button className="ai-open-btn" onClick={() => setChatOpen(true)}>✦ Open AI Assistant</button>
          </div>
        )}
      </main>

      {/* AI Chat Panel */}
      {chatOpen && (
        <aside className="ai-panel">
          <div className="ai-panel-header">
            <span className="ai-panel-title">✦ Chaboxer AI</span>
            <button className="ai-panel-action" title="Start a new chat (history is kept)" onClick={newChat}>＋ New</button>
            <div className="ai-overflow-wrap">
              <button className="ai-panel-action" title="More actions" onClick={() => setAiMenuOpen(!aiMenuOpen)}>⋯</button>
              {aiMenuOpen && (
                <div className="ai-overflow-menu" onClick={() => setAiMenuOpen(false)}>
                  <button onClick={openSessions}>🗂 Chat sessions</button>
                  <button onClick={sendBriefing} disabled={aiBusy || !apiKey}>☀ Daily briefing</button>
                  <button onClick={toggleSpeak}>{speakReplies ? '🔇 Mute spoken replies' : '🔊 Read replies aloud'}</button>
                  <button onClick={undoLastAiEdit}>↶ Undo last AI edit</button>
                  <button className="danger" onClick={clearChat}>🗑 Clear chat history</button>
                </div>
              )}
            </div>
            <button className="ai-panel-action" title="Close" onClick={() => setChatOpen(false)}>✕</button>
          </div>
          <div className="ai-mode-row">
            <div className="ai-mode-seg" role="radiogroup" aria-label="Edit mode">
              <button
                className={!agentMode ? 'active' : ''}
                title="You approve each edit with a diff before it's applied"
                onClick={() => { if (agentMode) toggleAgentMode() }}
              >🛡 Review</button>
              <button
                className={agentMode ? 'active agent' : ''}
                title="Edits apply automatically without approval"
                onClick={() => { if (!agentMode) toggleAgentMode() }}
              >⚡ Agent</button>
            </div>
            <span className="ai-mode-hint">{agentMode ? 'edits auto-apply' : 'you approve each edit'}</span>
          </div>
          <div className="ai-model-row">
            <label htmlFor="ai-model-select">Model</label>
            <select
              id="ai-model-select"
              value={aiModel === 'stealth/ox-alpha' ? 'stealth/ox-alpha' : 'custom'}
              onChange={(event) => changeAIModel(event.target.value === 'stealth/ox-alpha' ? 'stealth/ox-alpha' : '')}
              title="Choose the AI model used for this chat"
            >
              <option value="stealth/ox-alpha">Ox Alpha</option>
              <option value="custom">Custom OpenRouter model</option>
            </select>
            <input
              className="ai-model-input"
              value={aiModel}
              onChange={(event) => changeAIModel(event.target.value)}
              placeholder="provider/model-name"
              aria-label="OpenRouter model ID"
            />
          </div>
          {!apiKey ? (
            <div className="ai-key-setup">
              <p>Enter your OpenRouter API key to use Ox Alpha. It is stored only on this device; do not commit keys to <code>.env</code>.</p>
              <input
                type="password"
                className="search-input"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveApiKey()}
                placeholder="sk-or-..."
              />
              <button className="ai-send-btn" onClick={saveApiKey}>Save key</button>
            </div>
          ) : (
            <>
              <div className="ai-messages">
                {sessionList && (
                  <div className="ai-sessions">
                    <div className="ai-sessions-header">
                      <span>Chat sessions</span>
                      <button className="ai-panel-action" onClick={() => setSessionList(null)}>✕</button>
                    </div>
                    {sessionList.length === 0 && <div className="ai-hint"><p>No sessions yet.</p></div>}
                    {sessionList.map((s) => (
                      <button
                        key={s.id}
                        className={`ai-session-item ${s.id === chatSession ? 'current' : ''}`}
                        onClick={() => switchSession(s.id)}
                      >
                        <span className="ai-session-title">{s.title}</span>
                        <span className="ai-session-meta">
                          {new Date(s.last).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {s.count} msgs{s.id === chatSession ? ' · current' : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {chatMessages.length === 0 && (
                  <div className="ai-hint">
                    <p>Ask me anything about your notes — try one:</p>
                    <div className="ai-suggestions">
                      {[
                        'Summarize my notes from this week',
                        'Review all my notes and give feedback',
                        'Clean up and reformat the open note',
                      ].map((s) => (
                        <button key={s} className="ai-suggestion-chip" onClick={() => sendChat(s)} disabled={aiBusy}>
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {chatMessages.map((m) => (
                  m.feedback ? (
                    <div key={m.id} className={`ai-feedback-chip ${m.feedback}`}>{m.content}</div>
                  ) : (
                  <div key={m.id} className={`ai-msg ${m.role}`}>
                    <div className="ai-msg-meta">
                      {m.role === 'user' ? 'You' : 'AI'} &middot; {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                    {m.role === 'assistant'
                      ? <div className="ai-msg-body md" onClick={handlePreviewClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(linkifyNotes(m.content)) }} />
                      : <div className="ai-msg-body">{m.content}</div>}
                  </div>
                  )
                ))}
                {aiBusy && agentActivity.length > 0 && (
                  <div className="ai-activity">
                    {agentActivity.map((a, i) => <div key={i} className="ai-activity-line">{a}</div>)}
                  </div>
                )}
                {pendingAction && (
                  <div className="ai-approval">
                    <div className="ai-approval-title">
                      <span className={`ai-tool-badge ${pendingAction.action.tool === 'delete_note' ? 'danger' : ''}`}>
                        {pendingAction.action.tool.replace(/_/g, ' ')}
                      </span>
                      {pendingAction.action.title}
                    </div>
                    {approvalDraft !== null ? (
                      <textarea
                        className="ai-approval-edit"
                        value={approvalDraft}
                        onChange={(e) => setApprovalDraft(e.target.value)}
                        rows={10}
                      />
                    ) : approvalDiff ? (
                      <pre className="ai-approval-preview ai-diff">
                        {approvalDiff.map((d, i) => (
                          <div key={i} className={d.type === '+' ? 'diff-add' : d.type === '-' ? 'diff-del' : 'diff-ctx'}>
                            {d.type === ' ' ? '\u00a0\u00a0' : `${d.type} `}{d.line}
                          </div>
                        ))}
                      </pre>
                    ) : (
                      <div className="ai-approval-preview md" dangerouslySetInnerHTML={{ __html: renderMarkdown(pendingAction.action.preview) }} />
                    )}
                    <div className="ai-approval-actions">
                      <button className="ai-approve-btn" onClick={() => resolvePending(true)}>✓ Apply</button>
                      <button className="ai-reject-btn" onClick={() => resolvePending(false)}>✕ Reject</button>
                      {pendingAction.action.tool !== 'delete_note' && (
                        <button
                          className="ai-edit-btn"
                          onClick={() => setApprovalDraft(approvalDraft === null ? pendingAction.action.preview : null)}
                        >
                          {approvalDraft === null ? '✎ Edit' : '↩ Back to diff'}
                        </button>
                      )}
                      <button className="ai-always-btn" title="Apply and switch to agent mode (auto-apply future edits)" onClick={() => resolvePending(true, true)}>⚡ Always allow</button>
                    </div>
                  </div>
                )}
                {aiBusy && !pendingAction && (
                  streamText
                    ? <div className="ai-msg assistant"><div className="ai-msg-body md streaming" onClick={handlePreviewClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(linkifyNotes(streamText)) }} /></div>
                    : <div className="ai-msg assistant"><div className="ai-msg-body typing">Thinking&hellip;</div></div>
                )}
                <div ref={chatEndRef} />
              </div>
              <div className="ai-input-row">
                <button
                  className={`ai-mic-btn ${listening ? 'listening' : ''}`}
                  title={listening ? 'Stop dictation' : 'Dictate with your voice'}
                  onClick={toggleMic}
                >🎤</button>
                <textarea
                  className="ai-input"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() }
                  }}
                  placeholder="Ask about your notes, or tell me to write one..."
                  rows={2}
                />
                <button className="ai-send-btn" onClick={() => sendChat()} disabled={aiBusy || !chatInput.trim()}>
                  Send
                </button>
              </div>
            </>
          )}
        </aside>
      )}

      {/* Mobile bottom navigation */}
      <nav className="mobile-nav">
        <button
          className={!chatOpen && mobileView === 'list' ? 'active' : ''}
          onClick={() => { save(); setChatOpen(false); setShowGraph(false); setMobileView('list') }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
          <span>Notes</span>
        </button>
        <button
          className={!chatOpen && mobileView === 'editor' ? 'active' : ''}
          onClick={() => { setChatOpen(false); setMobileView('editor') }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
          </svg>
          <span>Editor</span>
        </button>
        <button className="mobile-nav-new" onClick={() => { setChatOpen(false); addNote() }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span>New</span>
        </button>
        <button
          className={!chatOpen && showGraph ? 'active' : ''}
          onClick={() => { save(); setChatOpen(false); setShowGraph(true); setMobileView('editor') }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="5" cy="6" r="2.5" />
            <circle cx="19" cy="6" r="2.5" />
            <circle cx="12" cy="18" r="2.5" />
            <line x1="7" y1="7.5" x2="10.5" y2="16" />
            <line x1="17" y1="7.5" x2="13.5" y2="16" />
            <line x1="7.5" y1="6" x2="16.5" y2="6" />
          </svg>
          <span>Graph</span>
        </button>
        <button className={chatOpen ? 'active ai' : 'ai'} onClick={() => setChatOpen(!chatOpen)}>
          <span className="mobile-nav-spark">✦</span>
          <span>AI</span>
        </button>
      </nav>

      {/* Help modal */}
      {showHelp && (
        <div className="help-overlay" onClick={() => setShowHelp(false)}>
          <div className="help-modal" onClick={(e) => e.stopPropagation()}>
            <div className="help-header">
              <span>Quick guide</span>
              <button className="ai-panel-action" onClick={() => setShowHelp(false)}>&#x2715;</button>
            </div>
            <div className="help-body">
              <section>
                <h4>&#x1F4DD; Writing</h4>
                <p>Everything is <strong>markdown</strong>: <code># heading</code>, <code>**bold**</code>, <code>- list</code>, <code>- [ ] task</code>, <code>&gt; quote</code>, <code>==highlight==</code>. Hit <strong>Preview</strong> to render. Lists auto-continue on Enter.</p>
              </section>
              <section>
                <h4>&#x2328; Shortcuts</h4>
                <p><kbd>Ctrl+B</kbd> bold &middot; <kbd>Ctrl+I</kbd> italic &middot; <kbd>Ctrl+E</kbd> code &middot; <kbd>Ctrl+S</kbd> save</p>
              </section>
              <section>
                <h4>&#x1F4C1; Organising</h4>
                <p><strong>Drag notes into folders</strong>. Double-click a folder to rename. Use <code>#tags</code> anywhere and <code>[[Note Title]]</code> to link notes &mdash; clicking a link in preview opens (or creates) that note.</p>
              </section>
              <section>
                <h4>&#x1F578; Graph view</h4>
                <p>See connections between notes, tags and folders. Drag nodes, scroll to zoom, click a note to open it.</p>
              </section>
              <section>
                <h4>&#x2726; AI assistant</h4>
                <p>It reads your notes and can write them too: ask it to summarize your week, draft a note into a folder, or clean up the open note.</p>
              </section>
              <section>
                <h4>&#x2601; Sync &amp; install</h4>
                <p>Sign in with Google to sync across devices in realtime. Use <strong>Install App</strong> to add it to your home screen &mdash; works offline.</p>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App

