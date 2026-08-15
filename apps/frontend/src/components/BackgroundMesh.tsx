import { useRef, type PointerEvent } from 'react'

export function BackgroundMesh() {
  const backgroundRef = useRef<HTMLDivElement>(null)

  function trackPointer(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    event.currentTarget.style.setProperty('--pointer-x', `${event.clientX - rect.left}px`)
    event.currentTarget.style.setProperty('--pointer-y', `${event.clientY - rect.top}px`)
  }

  return (
    <div ref={backgroundRef} className="background-mesh" onPointerMove={trackPointer} aria-hidden="true">
      <div className="mesh-grid" />
      <div className="mesh-glow mesh-glow-one" />
      <div className="mesh-glow mesh-glow-two" />
      <div className="mesh-pointer" />
      <div className="mesh-scanline" />
      <span className="floating-token token-one">[EMAIL_REDACTED]</span>
      <span className="floating-token token-two">request.safe</span>
      <span className="floating-token token-three">PI · 0.02</span>
    </div>
  )
}
