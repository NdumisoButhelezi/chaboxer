import { useState, useEffect, useCallback, useRef } from 'react'
import {
  getAllNotes, putNote, deleteNoteDB,
  getAllFolders, putFolder, deleteFolderDB,
  getChatHistory, putChatMessage, clearChatHistory,
  getSetting, putSetting,
  type Note, type Folder, type ChatMessage,
} from './db'
import type { AIActions } from './ai'
import type { User } from 'firebase/auth'
import { renderMarkdown } from './markdown'
import './App.css'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
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
  const [mobileView, setMobileView] = useState<'list' | 'editor'>('list')
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  // AI chat state
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [keyInput, setKeyInput] = useState('')
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
    getAllNotes().then(setNotes)
    getAllFolders().then(setFolders)
    getChatHistory().then(setChatMessages)
    getSetting('openai-api-key').then((k) => { if (k) setApiKey(k) })
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
  }, [chatMessages, aiBusy])

  const today = () =>
    new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  const addNote = (folderId: number | null = null) => {
    const now = new Date().toISOString()
    const newNote: Note = {
      id: Date.now(), title: 'Untitled', body: '', date: today(),
      folderId, createdAt: now, updatedAt: now,
    }
    setNotes((prev) => [newNote, ...prev])
    setActiveId(newNote.id)
    setTitle(newNote.title)
    setBody(newNote.body)
    setPreview(false)
    setMobileView('editor')
    putNote(newNote)
  }

  const addFolder = () => {
    const name = window.prompt('Folder name')
    if (!name?.trim()) return
    const folder: Folder = { id: Date.now(), name: name.trim() }
    setFolders((prev) => [...prev, folder].sort((a, b) => a.name.localeCompare(b.name)))
    putFolder(folder)
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
    setActiveId(note.id)
    setTitle(note.title)
    setBody(note.body)
    setPreview(false)
    setMobileView('editor')
  }

  const goBack = () => {
    save()
    setMobileView('list')
  }

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
    const updated = notes.filter((n) => n.id !== id)
    setNotes(updated)
    deleteNoteDB(id)
    if (activeId === id) {
      const next = updated[0] || null
      setActiveId(next?.id ?? null)
      setTitle(next?.title ?? '')
      setBody(next?.body ?? '')
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
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'b') { e.preventDefault(); applyFormat('**') }
      else if (e.key === 'i') { e.preventDefault(); applyFormat('*') }
      else if (e.key === 'e') { e.preventDefault(); applyFormat('`') }
      else if (e.key === 's') { e.preventDefault(); save() }
      return
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

  const q = search.trim().toLowerCase()
  const visibleNotes = q
    ? notes.filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q))
    : notes
  const rootNotes = visibleNotes.filter((n) => n.folderId === null)

  const wordCount = body.trim() ? body.trim().split(/\s+/).length : 0

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
  }

  const saveApiKey = () => {
    const k = keyInput.trim()
    if (!k) return
    setApiKey(k)
    putSetting('openai-api-key', k)
    setKeyInput('')
  }

  const sendChat = async () => {
    const text = chatInput.trim()
    if (!text || aiBusy || !apiKey) return
    setChatInput('')
    const userMsg: ChatMessage = {
      id: Date.now(), role: 'user', content: text, createdAt: new Date().toISOString(),
    }
    setChatMessages((prev) => [...prev, userMsg])
    putChatMessage(userMsg)
    setAiBusy(true)
    try {
      const { runAI } = await import('./ai')
      const reply = await runAI(
        apiKey, text, chatMessages, notesRef.current, activeId, aiActions
      )
      const aiMsg: ChatMessage = {
        id: Date.now() + 1, role: 'assistant', content: reply, createdAt: new Date().toISOString(),
      }
      setChatMessages((prev) => [...prev, aiMsg])
      putChatMessage(aiMsg)
    } catch (err) {
      const aiMsg: ChatMessage = {
        id: Date.now() + 1, role: 'assistant',
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        createdAt: new Date().toISOString(),
      }
      setChatMessages((prev) => [...prev, aiMsg])
    } finally {
      setAiBusy(false)
    }
  }

  const clearChat = () => {
    if (!window.confirm('Clear AI chat history (memory)?')) return
    setChatMessages([])
    clearChatHistory()
  }

  const renderNoteItem = (note: Note) => (
    <div
      key={note.id}
      className={`note-item ${note.id === activeId ? 'active' : ''}`}
      onClick={() => selectNote(note)}
      draggable
      onDragStart={(ev) => ev.dataTransfer.setData('text/note-id', String(note.id))}
    >
      <div className="note-item-icon"><FileIcon /></div>
      <div className="note-item-info">
        <span className="note-item-title">{note.title}</span>
        <span className="note-item-meta">
          {note.date} &middot; {note.body.slice(0, 30) || 'Empty'}
        </span>
      </div>
      <button
        className="delete-btn"
        onClick={(e) => { e.stopPropagation(); deleteNote(note.id) }}
        title="Delete"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </button>
    </div>
  )

  return (
    <div className="app">
      {/* Sidebar */}
      <aside className={`sidebar ${mobileView === 'list' ? 'mobile-show' : 'mobile-hide'}`}>
        <div className="sidebar-header">
          <div className="sidebar-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <span>My Notes</span>
            {syncing && <span className="sync-badge">syncing&hellip;</span>}
          </div>
          {cloudReady && (
            user ? (
              <div className="account-row">
                {user.photoURL
                  ? <img className="account-avatar" src={user.photoURL} alt="" referrerPolicy="no-referrer" />
                  : <span className="account-avatar fallback">{(user.displayName ?? '?').charAt(0)}</span>}
                <span className="account-name">{user.displayName ?? user.email}</span>
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
          )}
        </div>
        <div className="sidebar-actions">
          <button className="new-page-btn" onClick={() => addNote()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New page
          </button>
          <button className="new-page-btn" onClick={addFolder}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="10" x2="12" y2="16" />
              <line x1="9" y1="13" x2="15" y2="13" />
            </svg>
            New folder
          </button>
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
        </div>
      </aside>

      {/* Editor */}
      <main className={`editor ${mobileView === 'editor' ? 'mobile-show' : 'mobile-hide'}`}>
        {activeNote ? (
          <>
            <div className="editor-topbar">
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
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
                />
              ) : (
                <textarea
                  ref={bodyRef}
                  className="editor-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  onKeyDown={handleBodyKeyDown}
                  onBlur={save}
                  placeholder="Write in markdown... **bold**, *italic*, # headings, - lists, [[links]], #tags"
                />
              )}
              <div className="editor-statusbar">
                {wordCount} words &middot; {body.length} characters
              </div>
            </div>
          </>
        ) : (
          <div className="editor-empty">
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
            <button className="ai-panel-action" title="Clear memory" onClick={clearChat}>Clear</button>
            <button className="ai-panel-action" title="Close" onClick={() => setChatOpen(false)}>✕</button>
          </div>
          {!apiKey ? (
            <div className="ai-key-setup">
              <p>Enter your OpenAI API key to enable the assistant. It's stored locally on this device only.</p>
              <input
                type="password"
                className="search-input"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveApiKey()}
                placeholder="sk-..."
              />
              <button className="ai-send-btn" onClick={saveApiKey}>Save key</button>
            </div>
          ) : (
            <>
              <div className="ai-messages">
                {chatMessages.length === 0 && (
                  <div className="ai-hint">
                    <p>Ask me anything about your notes:</p>
                    <ul>
                      <li>"Summarize my notes from this week"</li>
                      <li>"Create a note with a workout plan"</li>
                      <li>"Clean up and reformat the open note"</li>
                      <li>"What did I write about project X?"</li>
                    </ul>
                  </div>
                )}
                {chatMessages.map((m) => (
                  <div key={m.id} className={`ai-msg ${m.role}`}>
                    <div className="ai-msg-meta">
                      {m.role === 'user' ? 'You' : 'AI'} &middot; {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                    {m.role === 'assistant'
                      ? <div className="ai-msg-body md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
                      : <div className="ai-msg-body">{m.content}</div>}
                  </div>
                ))}
                {aiBusy && <div className="ai-msg assistant"><div className="ai-msg-body typing">Thinking&hellip;</div></div>}
                <div ref={chatEndRef} />
              </div>
              <div className="ai-input-row">
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
                <button className="ai-send-btn" onClick={sendChat} disabled={aiBusy || !chatInput.trim()}>
                  Send
                </button>
              </div>
            </>
          )}
        </aside>
      )}
    </div>
  )
}

export default App

