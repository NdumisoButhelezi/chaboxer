# Chaboxer – Notion-Style Notes App

A dark-themed, mobile-responsive notes app built with **React 19 + TypeScript + Vite**, persisted with **IndexedDB**, and wrapped with **Capacitor** for Android.

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- npm (comes with Node)
- [Git](https://git-scm.com/)

---

## Installation

```bash
# 1. Clone the repo
git clone https://github.com/<your-username>/chaboxer.git
cd chaboxer

# 2. Install dependencies
npm install
```

---

## Development

```bash
# Start the dev server (http://localhost:5173)
npm run dev
```

---

## Production Build

```bash
npm run build
```

This runs `tsc -b && vite build` and outputs static files to the `dist/` folder.

---

## Preview the Build Locally

```bash
npm run preview
```

---

## Deploy to Netlify

### Option A – Netlify CLI (recommended)

```bash
# 1. Install the Netlify CLI globally
npm install -g netlify-cli

# 2. Log in to your Netlify account
netlify login

# 3. Build the project
npm run build

# 4. Deploy a draft preview
netlify deploy --dir=dist

# 5. When you're happy, deploy to production
netlify deploy --dir=dist --prod
```

### Option B – Git-based continuous deploy

1. Push your repo to **GitHub** / **GitLab** / **Bitbucket**.
2. Go to [app.netlify.com](https://app.netlify.com/) → **Add new site** → **Import an existing project**.
3. Select your repo and configure the build settings:

   | Setting         | Value              |
   |-----------------|--------------------|
   | Build command   | `npm run build`    |
   | Publish directory | `dist`           |

4. Click **Deploy site**. Every push to `main` will trigger a new build automatically.

### Option C – Drag & Drop

1. Run `npm run build` locally.
2. Open [app.netlify.com](https://app.netlify.com/).
3. Drag the `dist` folder onto the deploy area.

> **Tip:** Add a `netlify.toml` to the project root for reproducible config:

```toml
[build]
  command   = "npm run build"
  publish   = "dist"

[[redirects]]
  from   = "/*"
  to     = "/index.html"
  status = 200
```

The redirect rule ensures client-side routing works on refresh.

---

## Android (Capacitor)

```bash
# Sync web assets to the Android project
npx cap sync android

# Open in Android Studio
npx cap open android
```

Then run/build from Android Studio as usual.

---

## Tech Stack

| Layer       | Tech                          |
|-------------|-------------------------------|
| Framework   | React 19 + TypeScript 6       |
| Bundler     | Vite 8                        |
| Persistence | IndexedDB (no external libs)  |
| Native      | Capacitor 8                   |
| Styling     | Plain CSS (dark slate theme)  |

---

## Project Structure

```
chaboxer/
├── index.html            # Entry HTML (viewport-fit=cover)
├── capacitor.config.ts   # Capacitor settings
├── vite.config.ts        # Vite config
├── package.json
├── src/
│   ├── main.tsx          # React mount
│   ├── App.tsx           # Notes CRUD + UI
│   ├── App.css           # Notion-style dark theme
│   ├── index.css         # Global resets
│   └── db.ts             # IndexedDB helpers
├── public/
└── android/              # Capacitor Android project
```

---

## License

MIT
