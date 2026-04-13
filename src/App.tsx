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
          <h1>Notes</h1>
          <button className="add-btn" onClick={addNote} title="New note">+</button>
        </div>
        <div className="notes-list">
          {notes.length === 0 && (
            <p className="empty-hint">No notes yet</p>
          )}
          {notes.map((note) => (
            <div
              key={note.id}
              className={`note-item ${note.id === activeId ? 'active' : ''}`}
              onClick={() => selectNote(note)}
            >
              <div className="note-item-top">
                <span className="note-item-title">{note.title}</span>
                <button
                  className="delete-btn"
                  onClick={(e) => { e.stopPropagation(); deleteNote(note.id) }}
                  title="Delete"
                >&times;</button>
              </div>
              <span className="note-item-date">{note.date}</span>
              <span className="note-item-preview">
                {note.body.slice(0, 50) || 'No content'}
              </span>
            </div>
          ))}
        </div>
      </aside>

      {/* Editor */}
      <main className={`editor ${mobileView === 'editor' ? 'mobile-show' : 'mobile-hide'}`}>
        {activeNote ? (
          <>
            <button className="back-btn" onClick={goBack}>← Notes</button>
            <input
              className="editor-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={save}
              placeholder="Title"
            />
            <textarea
              className="editor-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onBlur={save}
              placeholder="Start writing..."
            />
          </>
        ) : (
          <div className="editor-empty">
            <p>Select a note or create a new one</p>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
