import { initializeApp, type FirebaseApp } from 'firebase/app'
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut as fbSignOut,
  onAuthStateChanged, type User,
} from 'firebase/auth'
import {
  getFirestore, doc, setDoc, deleteDoc, collection, onSnapshot,
  type Firestore, type Unsubscribe,
} from 'firebase/firestore'
import {
  setSyncHooks, getAllNotes, getAllFolders,
  putNoteLocal, deleteNoteLocal, putFolderLocal, deleteFolderLocal,
  type Note, type Folder,
} from './db'

// Env vars win; otherwise fall back to the project's public web config (not a secret)
const config = {
  apiKey: (import.meta.env.VITE_FIREBASE_API_KEY as string | undefined) || 'AIzaSyA0f-_hXwQpEx5RmEML-EXvExEGdYv_ZJY',
  authDomain: (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined) || 'chaboxer-d5ee6.firebaseapp.com',
  projectId: (import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined) || 'chaboxer-d5ee6',
  storageBucket: (import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined) || 'chaboxer-d5ee6.firebasestorage.app',
  messagingSenderId: (import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined) || '441049253121',
  appId: (import.meta.env.VITE_FIREBASE_APP_ID as string | undefined) || '1:441049253121:web:5daa9d7f0ad1423c080700',
}

export const isCloudConfigured = Boolean(config.apiKey && config.projectId)

let app: FirebaseApp | null = null
let db: Firestore | null = null

function ensureApp() {
  if (!app) {
    app = initializeApp(config as Record<string, string>)
    db = getFirestore(app)
  }
  return { auth: getAuth(app), db: db! }
}

export function watchAuth(cb: (user: User | null) => void): Unsubscribe {
  if (!isCloudConfigured) {
    cb(null)
    return () => {}
  }
  const { auth } = ensureApp()
  return onAuthStateChanged(auth, cb)
}

export async function signInWithGoogle(): Promise<User> {
  const { auth } = ensureApp()
  const result = await signInWithPopup(auth, new GoogleAuthProvider())
  return result.user
}

export async function signOut(): Promise<void> {
  const { auth } = ensureApp()
  stopSync()
  await fbSignOut(auth)
}

let unsubs: Unsubscribe[] = []
let applyingRemote = false

export function stopSync(): void {
  unsubs.forEach((u) => u())
  unsubs = []
  setSyncHooks({})
}

export async function startSync(
  uid: string,
  onNotes: (notes: Note[]) => void,
  onFolders: (folders: Folder[]) => void,
): Promise<void> {
  stopSync()
  const { db } = ensureApp()
  const notesCol = collection(db, 'users', uid, 'notes')
  const foldersCol = collection(db, 'users', uid, 'folders')

  // Push local data first so nothing is lost on first sign-in
  const [localNotes, localFolders] = await Promise.all([getAllNotes(), getAllFolders()])
  await Promise.all([
    ...localNotes.map((n) => setDoc(doc(notesCol, String(n.id)), n, { merge: true })),
    ...localFolders.map((f) => setDoc(doc(foldersCol, String(f.id)), f, { merge: true })),
  ])

  // Local writes -> cloud (skipped while applying remote snapshots)
  setSyncHooks({
    onPutNote: (n) => { if (!applyingRemote) setDoc(doc(notesCol, String(n.id)), n) },
    onDeleteNote: (id) => { if (!applyingRemote) deleteDoc(doc(notesCol, String(id))) },
    onPutFolder: (f) => { if (!applyingRemote) setDoc(doc(foldersCol, String(f.id)), f) },
    onDeleteFolder: (id) => { if (!applyingRemote) deleteDoc(doc(foldersCol, String(id))) },
  })

  // Cloud -> local + UI
  unsubs.push(
    onSnapshot(notesCol, async (snap) => {
      const remote = snap.docs.map((d) => d.data() as Note)
      remote.sort((a, b) => b.id - a.id)
      applyingRemote = true
      try {
        const local = await getAllNotes()
        const remoteIds = new Set(remote.map((n) => n.id))
        await Promise.all([
          ...remote.map((n) => putNoteLocal(n)),
          ...local.filter((n) => !remoteIds.has(n.id)).map((n) => deleteNoteLocal(n.id)),
        ])
      } finally {
        applyingRemote = false
      }
      onNotes(remote)
    }),
    onSnapshot(foldersCol, async (snap) => {
      const remote = snap.docs.map((d) => d.data() as Folder)
      remote.sort((a, b) => a.name.localeCompare(b.name))
      applyingRemote = true
      try {
        const local = await getAllFolders()
        const remoteIds = new Set(remote.map((f) => f.id))
        await Promise.all([
          ...remote.map((f) => putFolderLocal(f)),
          ...local.filter((f) => !remoteIds.has(f.id)).map((f) => deleteFolderLocal(f.id)),
        ])
      } finally {
        applyingRemote = false
      }
      onFolders(remote)
    }),
  )
}
