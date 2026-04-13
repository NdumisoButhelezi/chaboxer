import { useState } from 'react'
import './App.css'

interface Note {
  id: number
  title: string
  body: string
  date: string
}

function App() {
  const [notes, setNotes] = useState<Note[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [mobileView, setMobileView] = useState<'list' | 'editor'>('list')

  const activeNote = notes.find((n) => n.id === activeId)

  const addNote = () => {
    const now = new Date()
    const newNote: Note = {
      id: Date.now(),
      title: 'Untitled',
      body: '',
      date: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    }
    setNotes([newNote, ...notes])
    setActiveId(newNote.id)
    setTitle(newNote.title)
    setBody(newNote.body)
    setMobileView('editor')
  }

  const selectNote = (note: Note) => {
    save()
    setActiveId(note.id)
    setTitle(note.title)
    setBody(note.body)
    setMobileView('editor')
  }

  const goBack = () => {
    save()
    setMobileView('list')
  }

  const save = () => {
    if (activeId === null) return
    setNotes((prev) =>
      prev.map((n) =>
        n.id === activeId
          ? { ...n, title: title || 'Untitled', body, date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }
          : n
      )
    )
  }

  const deleteNote = (id: number) => {
    const updated = notes.filter((n) => n.id !== id)
    setNotes(updated)
    if (activeId === id) {
      const next = updated[0] || null
      setActiveId(next?.id ?? null)
      setTitle(next?.title ?? '')
      setBody(next?.body ?? '')
    }
  }

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
          </div>
        </div>
        <div className="sidebar-actions">
          <button className="new-page-btn" onClick={addNote}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New page
          </button>
        </div>
        <div className="notes-list">
          {notes.length === 0 && (
            <div className="empty-hint">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
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
          {notes.map((note) => (
            <div
              key={note.id}
              className={`note-item ${note.id === activeId ? 'active' : ''}`}
              onClick={() => selectNote(note)}
            >
              <div className="note-item-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              </div>
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
          ))}
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
            </div>
            <div className="editor-content">
              <input
                className="editor-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={save}
                placeholder="Untitled"
              />
              <textarea
                className="editor-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onBlur={save}
                placeholder="Type '/' for commands..."
              />
            </div>
          </>
        ) : (
          <div className="editor-empty">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ddd" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <p>Select a page or create a new one</p>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
