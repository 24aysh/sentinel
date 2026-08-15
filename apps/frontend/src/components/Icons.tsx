import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

const defaults = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

export function SentinelMark({ className, ...props }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 36 36" fill="none" {...props}>
      <path d="M18 2.4 31 7.7v8.9c0 8.1-5.4 14.2-13 17-7.6-2.8-13-8.9-13-17V7.7L18 2.4Z" fill="currentColor" />
      <path d="m11.2 18.1 4.1 4.1 9.7-9.8" stroke="white" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ArrowRight(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
}

export function ArrowUpRight(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M7 17 17 7M7 7h10v10" /></svg>
}

export function Check(props: IconProps) {
  return <svg {...defaults} {...props}><path d="m5 12 4.2 4.2L19 6.5" /></svg>
}

export function Copy(props: IconProps) {
  return <svg {...defaults} {...props}><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
}

export function Github(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7.4a5.8 5.8 0 0 0-1.5-4 5.4 5.4 0 0 0-.2-4S17.9-1.3 15 1.1a13.4 13.4 0 0 0-7 0C5.1-1.3 3.9-.9 3.9-.9a5.4 5.4 0 0 0-.2 4 5.8 5.8 0 0 0-1.5 4c0 5.8 3.5 7 6.8 7.4A4.8 4.8 0 0 0 8 18v4" /><path d="M8 19c-3 .9-3-1.5-4.2-2" /></svg>
}

export function XLogo(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M4 4l16 16M20 4 4 20" /></svg>
}

export function Linkedin(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6ZM2 9h4v12H2z" /><circle cx="4" cy="4" r="2" /></svg>
}

export function Lock(props: IconProps) {
  return <svg {...defaults} {...props}><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></svg>
}

export function Scan(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10" /></svg>
}

export function Cpu(props: IconProps) {
  return <svg {...defaults} {...props}><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9" y="9" width="6" height="6" rx="1" /><path d="M9 1v5M15 1v5M9 18v5M15 18v5M1 9h5M1 15h5M18 9h5M18 15h5" /></svg>
}

export function Braces(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M8 3H6a2 2 0 0 0-2 2v4a3 3 0 0 1-2 3 3 3 0 0 1 2 3v4a2 2 0 0 0 2 2h2M16 3h2a2 2 0 0 1 2 2v4a3 3 0 0 0 2 3 3 3 0 0 0-2 3v4a2 2 0 0 1-2 2h-2" /></svg>
}

export function Wrench(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M14.7 6.3a4 4 0 0 0-5-5L7.5 3.5l3 3 2.2-2.2a4 4 0 0 0 2 2Z" /><path d="m9.5 6.5-7.8 7.8a2.4 2.4 0 0 0 3.4 3.4l7.8-7.8" /><path d="m14 12 6.8 6.8a1.4 1.4 0 0 1-2 2L12 14" /></svg>
}

export function Menu(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M4 7h16M4 12h16M4 17h16" /></svg>
}

export function Close(props: IconProps) {
  return <svg {...defaults} {...props}><path d="m6 6 12 12M18 6 6 18" /></svg>
}

export function Book(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" /></svg>
}

export function Terminal(props: IconProps) {
  return <svg {...defaults} {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></svg>
}

export function Zap(props: IconProps) {
  return <svg {...defaults} {...props}><path d="M13 2 4.5 14H11l-1 8 8.5-12H12l1-8Z" /></svg>
}
