const DB_NAME = 'chaboxer-notes'
const DB_VERSION = 4
const STORE_NAME = 'notes'
const FOLDER_STORE = 'folders'
const CHAT_STORE = 'chat'
const SETTINGS_STORE = 'settings'
const EMBED_STORE = 'embeddings'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(FOLDER_STORE)) {
        db.createObjectStore(FOLDER_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(CHAT_STORE)) {
        db.createObjectStore(CHAT_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' })
      }
      if (!db.objectStoreNames.contains(EMBED_STORE)) {
        db.createObjectStore(EMBED_STORE, { keyPath: 'id' })
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
  folderId: number | null
  createdAt: string // ISO timestamp
  updatedAt: string // ISO timestamp
  pinned?: boolean
  deletedAt?: string | null // set = in trash
}

export interface Folder {
  id: number
  name: string
  createdAt?: string
}

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  sessionId?: number // 0/undefined = legacy session
  feedback?: 'approved' | 'rejected' // human-in-the-loop signal on AI edits
}

// Cloud sync hooks — registered by the cloud module when a user is signed in
export interface SyncHooks {
  onPutNote?(note: Note): void
  onDeleteNote?(id: number): void
  onPutFolder?(folder: Folder): void
  onDeleteFolder?(id: number): void
}

let syncHooks: SyncHooks = {}

export function setSyncHooks(hooks: SyncHooks): void {
  syncHooks = hooks
}

function getAll<T>(store: string): Promise<T[]> {
  return openDB().then(
    (db) =>
      new Promise<T[]>((resolve, reject) => {
        const tx = db.transaction(store, 'readonly')
        const request = tx.objectStore(store).getAll()
        request.onsuccess = () => resolve(request.result as T[])
        request.onerror = () => reject(request.error)
      })
  )
}

function put(store: string, value: unknown): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite')
        tx.objectStore(store).put(value)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
  )
}

function remove(store: string, id: number): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite')
        tx.objectStore(store).delete(id)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
  )
}

export async function getAllNotes(): Promise<Note[]> {
  const notes = await getAll<Note>(STORE_NAME)
  notes.forEach((n) => {
    if (n.folderId === undefined) n.folderId = null
    // Migrate pre-v3 notes: derive timestamps from the id (Date.now at creation)
    if (!n.createdAt) n.createdAt = new Date(n.id).toISOString()
    if (!n.updatedAt) n.updatedAt = n.createdAt
  })
  notes.sort((a, b) => b.id - a.id)
  return notes
}

export function putNote(note: Note): Promise<void> {
  syncHooks.onPutNote?.(note)
  return put(STORE_NAME, note)
}

// Write locally only (used when applying remote changes, to avoid echo loops)
export function putNoteLocal(note: Note): Promise<void> {
  return put(STORE_NAME, note)
}

export function deleteNoteLocal(id: number): Promise<void> {
  return remove(STORE_NAME, id)
}

export function putFolderLocal(folder: Folder): Promise<void> {
  return put(FOLDER_STORE, folder)
}

export function deleteFolderLocal(id: number): Promise<void> {
  return remove(FOLDER_STORE, id)
}

export function deleteNoteDB(id: number): Promise<void> {
  syncHooks.onDeleteNote?.(id)
  return remove(STORE_NAME, id)
}

export async function getAllFolders(): Promise<Folder[]> {
  const folders = await getAll<Folder>(FOLDER_STORE)
  folders.sort((a, b) => a.name.localeCompare(b.name))
  return folders
}

export function putFolder(folder: Folder): Promise<void> {
  syncHooks.onPutFolder?.(folder)
  return put(FOLDER_STORE, folder)
}

export function deleteFolderDB(id: number): Promise<void> {
  syncHooks.onDeleteFolder?.(id)
  return remove(FOLDER_STORE, id)
}

export async function getChatHistory(): Promise<ChatMessage[]> {
  const msgs = await getAll<ChatMessage>(CHAT_STORE)
  msgs.sort((a, b) => a.id - b.id)
  return msgs
}

// RAG: cached note embeddings, keyed by note id; updatedAt marks staleness
export interface NoteEmbedding {
  id: number
  updatedAt: string
  vector: number[]
}

export function getAllEmbeddings(): Promise<NoteEmbedding[]> {
  return getAll<NoteEmbedding>(EMBED_STORE)
}

export function putEmbedding(e: NoteEmbedding): Promise<void> {
  return put(EMBED_STORE, e)
}

export function deleteEmbedding(id: number): Promise<void> {
  return remove(EMBED_STORE, id)
}

export function putChatMessage(msg: ChatMessage): Promise<void> {
  return put(CHAT_STORE, msg)
}

export async function clearChatHistory(): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHAT_STORE, 'readwrite')
    tx.objectStore(CHAT_STORE).clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function getSetting(key: string): Promise<string | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SETTINGS_STORE, 'readonly')
    const request = tx.objectStore(SETTINGS_STORE).get(key)
    request.onsuccess = () => resolve(request.result?.value ?? null)
    request.onerror = () => reject(request.error)
  })
}

export function putSetting(key: string, value: string): Promise<void> {
  return put(SETTINGS_STORE, { key, value })
}

