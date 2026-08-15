import { BackgroundMesh } from '../components/BackgroundMesh'
import { CodeBlock } from '../components/CodeBlock'
import { HeroGatewayVisual, InteractiveDemo } from '../components/InteractiveDemo'
import {
  ArrowRight,
  ArrowUpRight,
  Braces,
  Check,
  Cpu,
  Github,
  Linkedin,
  Lock,
  Scan,
  SentinelMark,
  Wrench,
  XLogo,
  Zap,
} from '../components/Icons'
import { SiteHeader } from '../components/SiteHeader'

const quickStart = `import {
  ModelGateway,
  OpenAICompatibleProvider,
} from "@llm-gateway/sdk";

const gateway = await ModelGateway.create({
  provider: new OpenAICompatibleProvider({
    baseUrl: "https://api.openai.com/v1",
    apiKey: process.env.MODEL_API_KEY,
  }),
  defaultModel: "gpt-4.1-mini",
  policyPath: "./policies/example-policy.yaml",
  promptInjectionModelPath: "../model",
});

const result = await gateway.chat.completions.create({
  messages: [{ role: "user", content: userPrompt }],
});`

const capabilities = [
  {
    icon: <Scan />,
    number: '01',
    title: 'Sensitive data stays private',
    text: 'Detect and redact emails, phone numbers, credentials, cards, IPs, and more before a request leaves your process.',
    tag: 'PII REDACTION',
  },
  {
    icon: <Cpu />,
    number: '02',
    title: 'Prompt injection, caught locally',
    text: 'Run a sealed ONNX classifier in-process, in shadow mode or enforced, without sending prompts to another service.',
    tag: 'LOCAL INFERENCE',
  },
  {
    icon: <Braces />,
    number: '03',
    title: 'Outputs you can depend on',
    text: 'Validate structured responses against strict JSON Schema, with bounded repair retries and safe failure behavior.',
    tag: 'OUTPUT SCHEMAS',
  },
  {
    icon: <Wrench />,
    number: '04',
    title: 'Tools behind a boundary',
    text: 'Filter tool definitions and returned calls by name, arguments, and policy. Your application always owns execution.',
    tag: 'TOOL POLICY',
  },
]

export function LandingPage() {
  return (
    <div className="landing-page">
      <section className="hero-section">
        <BackgroundMesh />
        <SiteHeader />
        <div className="hero-shell page-shell">
          <div className="hero-copy">
            <div className="eyebrow"><span className="eyebrow-pulse" /> Privacy infrastructure for AI apps</div>
            <h1>The guardrail between <span>your app</span> and every model.</h1>
            <p className="hero-lede">
              Sentinel is a TypeScript SDK that inspects prompts, protects sensitive data, and validates model behavior—inside your own process.
            </p>
            <div className="hero-actions">
              <a className="button button-primary" href="/docs">Read the docs <ArrowRight /></a>
              <a className="button button-secondary" href="https://github.com/24aysh/sentinel/" target="_blank" rel="noreferrer"><Github /> View on GitHub</a>
            </div>
            <div className="hero-proof" aria-label="Key SDK qualities">
              <span><Check /> Provider neutral</span>
              <span><Check /> In-process</span>
              <span><Check /> TypeScript-first</span>
            </div>
          </div>
          <div className="hero-visual-wrap">
            <div className="visual-tag tag-request">raw request <ArrowRight /></div>
            <div className="visual-tag tag-policy"><Lock /> policy.yaml</div>
            <HeroGatewayVisual />
            <div className="hero-visual-shadow" />
          </div>
        </div>
        <div className="hero-bottom-line">
          <div className="page-shell trust-strip">
            <span className="trust-intro">Built for the boundary</span>
            <span><Lock /> No proxy server</span>
            <span><Cpu /> Local classification</span>
            <span><Zap /> OpenAI-compatible</span>
          </div>
        </div>
      </section>

      <main>
        <section className="demo-section" id="demo">
          <div className="page-shell">
            <div className="section-heading centered">
              <div className="section-kicker">Interactive playground</div>
              <h2>See what reaches your model.</h2>
              <p>Try a realistic prompt. Toggle each guardrail and watch Sentinel decide what gets redacted, blocked, or passed through.</p>
            </div>
            <InteractiveDemo />
          </div>
        </section>

        <section className="how-section">
          <div className="page-shell how-grid">
            <div className="how-intro">
              <div className="section-kicker">One controlled path</div>
              <h2>Guard every request with one call.</h2>
              <p>Sentinel wraps the familiar chat-completions flow with a policy you can read, review, and version alongside your application.</p>
              <a className="text-link" href="/docs">Explore the request lifecycle <ArrowRight /></a>
            </div>
            <div className="how-steps">
              <article>
                <span className="how-number">01</span>
                <div><h3>Define the boundary</h3><p>Choose detectors, actions, and failure behavior in a small YAML policy.</p></div>
                <span className="how-icon"><Braces /></span>
              </article>
              <article>
                <span className="how-number">02</span>
                <div><h3>Inspect in-process</h3><p>Normalize and evaluate input before the first provider call is made.</p></div>
                <span className="how-icon"><Scan /></span>
              </article>
              <article>
                <span className="how-number">03</span>
                <div><h3>Return with evidence</h3><p>Receive the response, guarded provider request, timing, and lifecycle events.</p></div>
                <span className="how-icon"><Check /></span>
              </article>
            </div>
          </div>
        </section>

        <section className="capabilities-section" id="capabilities">
          <div className="page-shell">
            <div className="section-heading split-heading">
              <div>
                <div className="section-kicker">Defense in depth</div>
                <h2>Small surface.<br />Serious boundaries.</h2>
              </div>
              <p>Four focused guardrails cover the riskiest parts of the model lifecycle without turning your architecture into a maze.</p>
            </div>
            <div className="capability-grid">
              {capabilities.map((capability) => (
                <article className="capability-card" key={capability.number}>
                  <div className="capability-top"><span className="capability-icon">{capability.icon}</span><span>{capability.number}</span></div>
                  <h3>{capability.title}</h3>
                  <p>{capability.text}</p>
                  <div className="capability-tag">{capability.tag}</div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="developer-section">
          <div className="page-shell developer-grid">
            <div className="developer-copy">
              <div className="section-kicker light">Designed for developers</div>
              <h2>One interface.<br />Your provider.</h2>
              <p>Keep a provider-neutral API while guardrails run around every completion. No hosted control plane and no hidden network fallback.</p>
              <ul className="developer-list">
                <li><Check /> Async factory loads and validates policy once</li>
                <li><Check /> Silent by default; bring your own logger</li>
                <li><Check /> Typed results and predictable error codes</li>
              </ul>
              <a className="button button-light" href="/docs">Start integrating <ArrowRight /></a>
            </div>
            <div className="developer-code">
              <CodeBlock code={quickStart} />
              <div className="code-caption"><span className="caption-dot" /> Provider request is dispatched only after input guardrails pass.</div>
            </div>
          </div>
        </section>

        <section className="cta-section">
          <div className="page-shell cta-card">
            <div className="cta-grid" aria-hidden="true" />
            <SentinelMark className="cta-mark" />
            <div className="section-kicker">Own the boundary</div>
            <h2>Make every model call a safe one.</h2>
            <p>Read the five-minute setup, inspect the policies, and put Sentinel in front of your next completion.</p>
            <div className="hero-actions">
              <a className="button button-primary" href="/docs">Get started <ArrowRight /></a>
              <a className="button button-secondary" href="https://github.com/24aysh/sentinel/" target="_blank" rel="noreferrer">Star on GitHub <Github /></a>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="page-shell footer-grid">
          <div className="footer-brand">
            <a className="brand" href="/"><SentinelMark className="brand-mark" /> <span>Sentinel</span></a>
            <p>A focused safety layer for TypeScript AI applications.</p>
          </div>
          <div className="footer-links">
            <div><span>PROJECT</span><a href="/docs">Documentation</a><a href="/#demo">Playground</a><a href="https://github.com/24aysh/sentinel/" target="_blank" rel="noreferrer">GitHub <ArrowUpRight /></a></div>
            <div><span>CONNECT</span><a href="https://x.com/24aysh" target="_blank" rel="noreferrer"><XLogo /> @24aysh</a><a href="https://www.linkedin.com/in/c0ntinental/" target="_blank" rel="noreferrer"><Linkedin /> LinkedIn</a></div>
          </div>
        </div>
        <div className="page-shell footer-bottom"><span>© 2026 Sentinel.</span><span>Built in the open. Guarded by design.</span></div>
      </footer>
    </div>
  )
}
