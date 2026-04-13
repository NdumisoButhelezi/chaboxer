# Chaboxer – Build a Notion-Style Notes App

A step-by-step tutorial for building a dark-themed, mobile-responsive, installable notes app with **React 19 + TypeScript + Vite**, **IndexedDB** persistence, **Capacitor** for Android, and **PWA** support for browser installs.

---

## Table of Contents

1. [Scaffold the Project](#1-scaffold-the-project)
2. [index.html – Entry Point](#2-indexhtml--entry-point)
3. [Global Styles – index.css](#3-global-styles--indexcss)
4. [IndexedDB Persistence – db.ts](#4-indexeddb-persistence--dbts)
5. [Main Component – App.tsx](#5-main-component--apptsx)
6. [Theme & Layout – App.css](#6-theme--layout--appcss)
7. [Bootstrap React – main.tsx](#7-bootstrap-react--maintsx)
8. [PWA Manifest – manifest.json](#8-pwa-manifest--manifestjson)
9. [Service Worker – sw.js](#9-service-worker--swjs)
10. [Capacitor for Android](#10-capacitor-for-android)
11. [Build & Run](#11-build--run)
12. [Deploy to Netlify](#12-deploy-to-netlify)

---

## 1. Scaffold the Project

```bash
npm create vite@latest chaboxer -- --template react-ts
cd chaboxer
npm install
```

Your `package.json` will look like this after all dependencies are added:

```json
{
  "name": "chaboxer",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "eslint .",
    "preview": "vite preview"
  },
  "dependencies": {
    "@capacitor/android": "^8.3.0",
    "@capacitor/cli": "^8.3.0",
    "@capacitor/core": "^8.3.0",
    "react": "^19.2.4",
    "react-dom": "^19.2.4"
  },
  "devDependencies": {
    "@eslint/js": "^9.39.4",
    "@types/node": "^24.12.2",
    "@types/react": "^19.2.14",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.1",
    "eslint": "^9.39.4",
    "eslint-plugin-react-hooks": "^7.0.1",
    "eslint-plugin-react-refresh": "^0.5.2",
    "globals": "^17.4.0",
    "typescript": "~6.0.2",
    "typescript-eslint": "^8.58.0",
    "vite": "^8.0.4"
  }
}
```

---

## 2. index.html – Entry Point

Replace `index.html` with this. It includes the PWA manifest, theme colour, and mobile viewport settings:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="manifest" href="/manifest.json" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no" />
    <meta name="theme-color" content="#0f172a" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <link rel="apple-touch-icon" href="/icons/icon-192.svg" />
    <title>chaboxer</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**Key points:**
- `viewport-fit=cover` lets the app extend behind the notch/status bar
- `user-scalable=no` prevents pinch-zoom for a native feel
- `theme-color` tints the browser chrome to match the app

---

## 3. Global Styles – index.css

Create `src/index.css`. This resets margins and ensures `height: 100%` cascades properly (avoids the mobile `100vh` address-bar bug):

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html {
  -webkit-text-size-adjust: 100%;
  height: 100%;
}

body {
  margin: 0;
  background: #0f172a;
  min-height: 100%;
  height: 100%;
  overscroll-behavior: none;
}

#root {
  height: 100%;
}
```

---

## 4. IndexedDB Persistence – db.ts

Create `src/db.ts`. This gives us offline-capable CRUD with zero dependencies:

```ts
const DB_NAME = 'chaboxer-notes'
const DB_VERSION = 1
const STORE_NAME = 'notes'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export interface Note {
  id: number
  title: string
  body: string
  date: string
}

export async function getAllNotes(): Promise<Note[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const request = store.getAll()
    request.onsuccess = () => {
      const notes = request.result as Note[]
      notes.sort((a, b) => b.id - a.id)
      resolve(notes)
    }
    request.onerror = () => reject(request.error)
  })
}

export async function putNote(note: Note): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    store.put(note)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function deleteNoteDB(id: number): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    store.delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
```

**How it works:**
- `openDB()` opens (or creates) the IndexedDB database with a `notes` object store
- `putNote()` inserts or updates a note (upsert via `store.put`)
- `deleteNoteDB()` removes a note by `id`
- `getAllNotes()` fetches all notes, sorted newest-first

---

## 5. Main Component – App.tsx

Replace `src/App.tsx` with the full notes app. It handles CRUD, mobile view toggling, and the PWA install prompt:

```tsx
import { useState, useEffect, useCallback } from 'react'
import { getAllNotes, putNote, deleteNoteDB, type Note } from './db'
import './App.css'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function App() {
  const [notes, setNotes] = useState<Note[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [mobileView, setMobileView] = useState<'list' | 'editor'>('list')
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)

  const activeNote = notes.find((n) => n.id === activeId)

  // Capture the browser's install prompt so we can trigger it from a button
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

  // Load notes from IndexedDB on mount
  useEffect(() => {
    getAllNotes().then((saved) => {
      setNotes(saved)
    })
  }, [])

  const addNote = () => {
    const now = new Date()
    const newNote: Note = {
      id: Date.now(),
      title: 'Untitled',
      body: '',
      date: now.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      }),
    }
    setNotes([newNote, ...notes])
    setActiveId(newNote.id)
    setTitle(newNote.title)
    setBody(newNote.body)
    setMobileView('editor')
    putNote(newNote)
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

  const save = useCallback(() => {
    if (activeId === null) return
    const updated: Note = {
      id: activeId,
      title: title || 'Untitled',
      body,
      date: new Date().toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      }),
    }
    setNotes((prev) =>
      prev.map((n) => (n.id === activeId ? updated : n))
    )
    putNote(updated)
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

  return (
    <div className="app">
      {/* Sidebar */}
      <aside className={`sidebar ${mobileView === 'list' ? 'mobile-show' : 'mobile-hide'}`}>
        <div className="sidebar-header">
          <div className="sidebar-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <span>My Notes</span>
          </div>
        </div>
        <div className="sidebar-actions">
          <button className="new-page-btn" onClick={addNote}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New page
          </button>
          {installPrompt && (
            <button className="install-btn" onClick={handleInstall}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Install App
            </button>
          )}
        </div>
        <div className="notes-list">
          {notes.length === 0 && (
            <div className="empty-hint">
              <p>No pages yet</p>
              <span>Click "New page" to get started</span>
            </div>
          )}
          {notes.map((note) => (
            <div key={note.id}
              className={`note-item ${note.id === activeId ? 'active' : ''}`}
              onClick={() => selectNote(note)}>
              <div className="note-item-info">
                <span className="note-item-title">{note.title}</span>
                <span className="note-item-meta">
                  {note.date} · {note.body.slice(0, 30) || 'Empty'}
                </span>
              </div>
              <button className="delete-btn"
                onClick={(e) => { e.stopPropagation(); deleteNote(note.id) }}
                title="Delete">✕</button>
            </div>
          ))}
        </div>
      </aside>

      {/* Editor */}
      <main className={`editor ${mobileView === 'editor' ? 'mobile-show' : 'mobile-hide'}`}>
        {activeNote ? (
          <>
            <div className="editor-topbar">
              <button className="back-btn" onClick={goBack}>← Notes</button>
            </div>
            <div className="editor-content">
              <input className="editor-title" value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={save} placeholder="Untitled" />
              <textarea className="editor-body" value={body}
                onChange={(e) => setBody(e.target.value)}
                onBlur={save} placeholder="Type '/' for commands..." />
            </div>
          </>
        ) : (
          <div className="editor-empty">
            <p>Select a page or create a new one</p>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
```

**Key patterns:**
- `mobileView` state toggles between `'list'` and `'editor'` on small screens
- `save()` is wrapped in `useCallback` and fires on `onBlur` for auto-save
- Every mutation calls both `setState` and the corresponding IndexedDB function
- `beforeinstallprompt` is captured and surfaced as an "Install App" button

---

## 6. Theme & Layout – App.css

Create `src/App.css`. Dark slate Notion-style theme with responsive mobile layout:

```css
/* Layout */
.app {
  display: flex;
  height: 100%;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #cbd5e1;
  background: #0f172a;
  padding-top: env(safe-area-inset-top, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  padding-left: env(safe-area-inset-left, 0px);
  padding-right: env(safe-area-inset-right, 0px);
}

/* Sidebar */
.sidebar {
  width: 260px;
  background: #1e293b;
  border-right: 1px solid rgba(148, 163, 184, 0.1);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.sidebar-header {
  padding: 14px 12px 0;
}

.sidebar-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #e2e8f0;
  padding: 6px 8px;
  letter-spacing: 0.02em;
}

.sidebar-actions {
  padding: 6px 12px;
}

.new-page-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  background: none;
  border: none;
  border-radius: 4px;
  font-size: 13px;
  color: #94a3b8;
  cursor: pointer;
  transition: background 0.1s;
}

.new-page-btn:hover {
  background: rgba(148, 163, 184, 0.1);
  color: #e2e8f0;
}

.install-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  margin-top: 2px;
  background: rgba(96, 165, 250, 0.12);
  border: 1px solid rgba(96, 165, 250, 0.25);
  border-radius: 4px;
  font-size: 13px;
  color: #60a5fa;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.install-btn:hover {
  background: rgba(96, 165, 250, 0.22);
  border-color: rgba(96, 165, 250, 0.4);
}

/* Notes List */
.notes-list {
  flex: 1;
  overflow-y: auto;
  padding: 2px 8px;
}

.empty-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: 48px;
  color: #475569;
}

.empty-hint p {
  font-size: 14px;
  font-weight: 500;
  color: #64748b;
  margin: 0;
}

.empty-hint span {
  font-size: 12px;
  color: #475569;
}

.note-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;
  margin-bottom: 1px;
  transition: background 0.08s;
  min-height: 30px;
}

.note-item:hover {
  background: rgba(148, 163, 184, 0.08);
}

.note-item.active {
  background: rgba(96, 165, 250, 0.15);
}

.note-item-info {
  flex: 1;
  min-width: 0;
}

.note-item-title {
  display: block;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #e2e8f0;
}

.note-item-meta {
  display: block;
  font-size: 11px;
  color: #64748b;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
}

.delete-btn {
  background: none;
  border: none;
  color: #64748b;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  opacity: 0;
  transition: opacity 0.1s, background 0.1s;
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.note-item:hover .delete-btn {
  opacity: 1;
}

.delete-btn:hover {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
}

/* Editor */
.editor {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #0f172a;
  min-width: 0;
}

.editor-topbar {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  min-height: 44px;
  background: #0f172a;
}

.editor-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  max-width: 720px;
  width: 100%;
  margin: 0 auto;
  padding: 0 24px;
  overflow-y: auto;
}

.editor-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #475569;
  font-size: 14px;
}

.editor-title {
  border: none;
  outline: none;
  font-size: 40px;
  font-weight: 700;
  padding: 72px 0 4px;
  color: #f1f5f9;
  background: transparent;
  line-height: 1.2;
}

.editor-title::placeholder {
  color: #334155;
}

.editor-body {
  flex: 1;
  border: none;
  outline: none;
  resize: none;
  font-size: 16px;
  line-height: 1.75;
  padding: 8px 0 48px;
  color: #cbd5e1;
  background: transparent;
  font-family: inherit;
}

.editor-body::placeholder {
  color: #475569;
}

.back-btn {
  display: none;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: #94a3b8;
  font-size: 14px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: background 0.1s;
}

.back-btn:hover {
  background: rgba(148, 163, 184, 0.1);
}

/* Mobile Responsive */
@media (max-width: 640px) {
  .app {
    flex-direction: column;
  }

  .sidebar {
    width: 100%;
    height: 100%;
    border-right: none;
  }

  .editor {
    width: 100%;
    height: 100%;
  }

  .mobile-show {
    display: flex;
  }

  .mobile-hide {
    display: none;
  }

  .back-btn {
    display: flex;
  }

  .editor-topbar {
    border-bottom: 1px solid rgba(148, 163, 184, 0.1);
  }

  .editor-title {
    font-size: 28px;
    padding: 24px 0 4px;
  }

  .editor-content {
    padding: 0 16px;
  }

  .editor-body {
    font-size: 15px;
    padding-bottom: 24px;
  }

  .delete-btn {
    opacity: 1;
  }
}
```

**Design notes:**
- `env(safe-area-inset-*)` prevents content from hiding behind the status bar or notch
- The `mobile-show`/`mobile-hide` classes toggle sidebar ↔ editor on phones
- The back button is `display: none` on desktop, `display: flex` on mobile

---

## 7. Bootstrap React – main.tsx

Replace `src/main.tsx`. This mounts the app and registers the service worker:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Register service worker for PWA install support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
  })
}
```

---

## 8. PWA Manifest – manifest.json

Create `public/manifest.json`. This tells the browser how to install the app:

```json
{
  "name": "Chaboxer Notes",
  "short_name": "Chaboxer",
  "description": "A Notion-style notes app",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0f172a",
  "theme_color": "#0f172a",
  "orientation": "portrait-primary",
  "icons": [
    {
      "src": "/icons/icon-192.svg",
      "sizes": "192x192",
      "type": "image/svg+xml"
    },
    {
      "src": "/icons/icon-512.svg",
      "sizes": "512x512",
      "type": "image/svg+xml"
    },
    {
      "src": "/icons/icon-512.svg",
      "sizes": "512x512",
      "type": "image/svg+xml",
      "purpose": "maskable"
    }
  ]
}
```

**Key fields:**
- `"display": "standalone"` — removes browser UI so the app looks native
- `"icons"` — at minimum you need a 192px and 512px icon
- Place your icon SVGs in `public/icons/`

---

## 9. Service Worker – sw.js

Create `public/sw.js`. This caches the app shell for offline access:

```js
const CACHE_NAME = 'chaboxer-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.svg',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
];

// Install — cache app shell
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network first, fallback to cache
self.addEventListener('fetch', (e) => {
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
```

**Strategy:** Network-first with cache fallback. The app always tries the network; if offline, it serves from cache.

---

## 10. Capacitor for Android

To wrap the web app as a native Android APK:

```bash
# Install Capacitor
npm install @capacitor/core @capacitor/cli @capacitor/android

# Initialize Capacitor
npx cap init chaboxer com.chaboxer.app --web-dir dist

# Add Android platform
npx cap add android
```

Your `capacitor.config.ts` should look like:

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.chaboxer.app',
  appName: 'chaboxer',
  webDir: 'dist',
  android: {
    backgroundColor: '#0f172a'
  },
  ios: {
    contentInset: 'automatic'
  }
};

export default config;
```

---

## 11. Build & Run

### Web (dev server)

```bash
npm run dev
```

### Web (production build)

```bash
npm run build
npm run preview
```

### Android

```bash
npm run build
npx cap sync android
npx cap open android
```

Then click **Run ▶** in Android Studio.

---

## 12. Deploy to Netlify

### Option A – Netlify CLI

```bash
npm install -g netlify-cli
netlify login
npm run build
netlify deploy --dir=dist          # preview
netlify deploy --dir=dist --prod   # production
```

### Option B – Git-based (auto-deploy on push)

1. Push repo to GitHub.
2. Go to [app.netlify.com](https://app.netlify.com/) → **Add new site** → **Import an existing project**.
3. Set build settings:

   | Setting           | Value           |
   |-------------------|-----------------|
   | Build command     | `npm run build` |
   | Publish directory | `dist`          |

4. Click **Deploy site**.

### Option C – Drag & Drop

Run `npm run build`, then drag the `dist/` folder onto [app.netlify.com](https://app.netlify.com/).

### SPA Redirect Config

Add a `netlify.toml` to the project root so client-side routes work on refresh:

```toml
[build]
  command   = "npm run build"
  publish   = "dist"

[[redirects]]
  from   = "/*"
  to     = "/index.html"
  status = 200
```

---

## Project Structure

```
chaboxer/
├── index.html              # Entry HTML (viewport + PWA meta tags)
├── capacitor.config.ts     # Capacitor settings
├── vite.config.ts          # Vite config
├── netlify.toml            # Netlify build + SPA redirects
├── package.json
├── public/
│   ├── favicon.svg
│   ├── manifest.json       # PWA manifest
│   ├── sw.js               # Service worker
│   └── icons/
│       ├── icon-192.svg
│       └── icon-512.svg
├── src/
│   ├── main.tsx            # React mount + SW registration
│   ├── App.tsx             # Notes CRUD + install prompt
│   ├── App.css             # Dark Notion theme + responsive
│   ├── index.css           # Global resets
│   └── db.ts               # IndexedDB helpers
└── android/                # Capacitor Android project
```

---

## License

MIT
