import { useEffect } from 'react'
import './App.css'
import { DocsPage } from './pages/DocsPage'
import { LandingPage } from './pages/LandingPage'

function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/'
  const isDocs = path === '/docs' || path.startsWith('/docs/')

  useEffect(() => {
    document.title = isDocs
      ? 'Documentation — Sentinel'
      : 'Sentinel — Guardrails for every model call'
  }, [isDocs])

  return isDocs ? <DocsPage /> : <LandingPage />
}

export default App
