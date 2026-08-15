import { useState } from 'react'
import { Check, Copy } from './Icons'

type CodeBlockProps = { code: string; label?: string; language?: string }

export function CodeBlock({ code, label = 'example.ts', language = 'TypeScript' }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard access can be unavailable in non-secure preview contexts.
    }
  }

  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span className="code-dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="code-label">{label}</span>
        <span className="code-language">{language}</span>
        <button type="button" className="copy-button" onClick={copyCode} aria-label="Copy code">
          {copied ? <Check /> : <Copy />}<span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  )
}
