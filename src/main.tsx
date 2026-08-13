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

// A failed dynamic import means the page is from an older deploy — reload once to fetch the new build
window.addEventListener('vite:preloadError', () => {
  const key = 'chunk-reload'
  if (!sessionStorage.getItem(key)) {
    sessionStorage.setItem(key, '1')
    window.location.reload()
  }
})
window.addEventListener('load', () => sessionStorage.removeItem('chunk-reload'))
