import { useState } from 'react'
import { ArrowUpRight, Close, Github, Menu, SentinelMark } from './Icons'

type SiteHeaderProps = { docs?: boolean }

export function SiteHeader({ docs = false }: SiteHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <header className={`site-header${docs ? ' docs-header' : ''}`}>
      <div className="nav-shell">
        <a className="brand" href="/" aria-label="Sentinel home">
          <SentinelMark className="brand-mark" />
          <span>Sentinel</span>
        </a>
        <button className="menu-button" type="button" aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
          {menuOpen ? <Close /> : <Menu />}
        </button>
        <nav className={`nav-links${menuOpen ? ' open' : ''}`} aria-label="Main navigation">
          <a href={docs ? '/#demo' : '#demo'} onClick={() => setMenuOpen(false)}>Playground</a>
          <a href={docs ? '/#capabilities' : '#capabilities'} onClick={() => setMenuOpen(false)}>Capabilities</a>
          <a className={docs ? 'active' : ''} href="/docs" onClick={() => setMenuOpen(false)}>Docs</a>
          <a className="nav-github" href="https://github.com/24aysh/sentinel/" target="_blank" rel="noreferrer">
            <Github /> GitHub <ArrowUpRight className="nav-external" />
          </a>
        </nav>
      </div>
    </header>
  )
}
