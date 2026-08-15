import { CodeBlock } from '../components/CodeBlock'
import { ArrowRight, ArrowUpRight, Check, Github, SentinelMark } from '../components/Icons'
import { SiteHeader } from '../components/SiteHeader'

const setupCode = `import {
  ModelGateway,
  OpenAICompatibleProvider,
} from "@llm-gateway/sdk";

const gateway = await ModelGateway.create({
  provider: new OpenAICompatibleProvider({
    baseUrl: "https://api.openai.com/v1",
    apiKey: process.env.MODEL_API_KEY,
    timeoutMs: 30_000,
  }),
  defaultModel: "gpt-4.1-mini",
  policyPath: "./policies/example-policy.yaml",
  promptInjectionModelPath: "../model",
});`

const requestCode = `const result = await gateway.chat.completions.create({
  messages: [
    { role: "user", content: "Email me at ava@example.com" },
  ],
});

console.log(result.response.choices[0]?.message.content);
console.log(result.durationMs, result.lifecycle);`

const policyCode = `apiVersion: guardrails/v1
kind: GuardrailPolicy
enabled: true

metadata:
  name: production-policy
  version: 1

defaults:
  input_action: allow
  input_execution_mode: sequential
  runtime_failure_mode: closed

input:
  - id: redact-personal-data
    detector: pii
    entities: [EMAIL, PHONE_NUMBER, API_KEY, CREDIT_CARD]
    action:
      type: redact

  - id: block-prompt-injection
    detector: prompt_injection
    roles: [user]
    action:
      type: block`

const errorCode = `import { GatewayError } from "@llm-gateway/sdk";

try {
  await gateway.chat.completions.create(input);
} catch (error) {
  if (error instanceof GatewayError) {
    console.error(error.code, error.message);
  }
}`

const outputCode = `output:
  - id: require-json-result
    validator: json_schema
    schema:
      type: object
      properties:
        status: { type: string, enum: [ok, error] }
      required: [status]
      additionalProperties: false
    on_failure:
      type: retry
      maximum_retries: 1`

const toolCode = `tools:
  default_action: allow
  rules:
    - id: block-shell
      tool_names: [run_shell]
      action: block`

export function DocsPage() {
  return (
    <div className="docs-page">
      <SiteHeader docs />
      <div className="docs-layout page-shell">
        <aside className="docs-sidebar">
          <nav aria-label="Documentation sections">
            <span>GET STARTED</span>
            <a className="active" href="#introduction">Introduction</a>
            <a href="#requirements">Requirements</a>
            <a href="#installation">Installation</a>
            <a href="#quick-start">Quick start</a>
            <span>GUARDRAILS</span>
            <a href="#policy">Policy file</a>
            <a href="#pii">PII protection</a>
            <a href="#prompt-injection">Prompt injection</a>
            <a href="#output">Structured output</a>
            <a href="#tools">Tool calls</a>
            <span>REFERENCE</span>
            <a href="#results">Results & errors</a>
            <a href="#limitations">Limitations</a>
          </nav>
          <a className="sidebar-github" href="https://github.com/24aysh/sentinel/" target="_blank" rel="noreferrer"><Github /> View source <ArrowUpRight /></a>
        </aside>

        <main className="docs-content">
          <div className="docs-breadcrumb"><span>Docs</span><i>/</i><strong>Introduction</strong></div>
          <section className="docs-hero" id="introduction">
            <div className="docs-badge"><SentinelMark /> SENTINEL SDK</div>
            <h1>Protect model calls<br />inside your application.</h1>
            <p>Sentinel is a TypeScript-first, in-process model gateway. It gives your application one provider-neutral interface for chat completions, then applies input, output, and tool guardrails around every call.</p>
            <div className="docs-callout info"><strong>Good to know</strong><p>Sentinel is an SDK, not an HTTP proxy. It does not start a server, persist prompts, or add a hosted control plane.</p></div>
          </section>

          <section className="docs-section" id="requirements">
            <div className="docs-section-title"><span>01</span><div><p>BEFORE YOU START</p><h2>Requirements</h2></div></div>
            <p>Use Bun 1.3+ or Node.js 20+ for the built SDK. You also need an OpenAI-compatible endpoint and an API key when that endpoint requires one.</p>
            <div className="requirements-grid">
              <div><strong>Bun 1.3+</strong><span>Repository scripts and tests</span></div>
              <div><strong>Node.js 20+</strong><span>Built SDK runtime</span></div>
              <div><strong>Server runtime</strong><span>Native ONNX is not for browsers or edge</span></div>
            </div>
          </section>

          <section className="docs-section" id="installation">
            <div className="docs-section-title"><span>02</span><div><p>INSTALLATION</p><h2>Add Sentinel</h2></div></div>
            <p>The package is currently private and unpublished. Install workspace dependencies, build the SDK, and link <code>@llm-gateway/sdk</code> into the consuming application.</p>
            <CodeBlock code={'bun install\ncd apps/gateway\nbun run build\nbun run check:package'} label="Terminal" language="Shell" />
            <div className="docs-callout warning"><strong>Workspace release</strong><p>There is no public registry package yet. The supported package entry after a local build is <code>@llm-gateway/sdk</code>.</p></div>
          </section>

          <section className="docs-section" id="quick-start">
            <div className="docs-section-title"><span>03</span><div><p>QUICK START</p><h2>Create a gateway</h2></div></div>
            <p>Create the provider adapter and load your policy once at application startup. The async factory validates configuration before serving traffic.</p>
            <CodeBlock code={setupCode} label="gateway.ts" />
            <h3>Send a completion</h3>
            <p>The request shape is intentionally familiar. SDK inputs use camel case, including <code>maxTokens</code>.</p>
            <CodeBlock code={requestCode} label="completion.ts" />
          </section>

          <section className="docs-section" id="policy">
            <div className="docs-section-title"><span>04</span><div><p>GUARDRAILS</p><h2>Write one readable policy</h2></div></div>
            <p>Policies are YAML files loaded during construction. Keep them beside your code so changes can be reviewed and versioned. Set <code>enabled: false</code> to validate a policy without attaching its guardrails.</p>
            <CodeBlock code={policyCode} label="policy.yaml" language="YAML" />
          </section>

          <section className="docs-section docs-two-column" id="pii">
            <div><div className="mini-section-label">PII PROTECTION</div><h2>Redact or block sensitive input</h2><p>The structural detector runs locally before provider dispatch. Choose the entity types and set the action to <code>redact</code> or <code>block</code>.</p></div>
            <div className="entity-list">
              {['EMAIL', 'PHONE_NUMBER', 'IP_ADDRESS', 'API_KEY', 'JWT', 'PRIVATE_KEY', 'CLOUD_CREDENTIAL', 'CREDIT_CARD', 'DATABASE_CONNECTION_STRING'].map((entity) => <span key={entity}><Check /> {entity}</span>)}
            </div>
          </section>

          <section className="docs-section" id="prompt-injection">
            <div className="docs-section-title"><span>05</span><div><p>LOCAL CLASSIFIER</p><h2>Detect prompt injection</h2></div></div>
            <p>Point <code>promptInjectionModelPath</code> at the sealed local model directory when the policy contains a <code>prompt_injection</code> rule. Start with <code>action.type: allow</code> for shadow evaluation, then change it to <code>block</code> when you are ready to enforce.</p>
            <div className="docs-callout info"><strong>Sequential is the privacy-first default</strong><p>PII is redacted before local classifier inference. Parallel mode can reduce latency, but raw PII enters tokenizer and ONNX process memory.</p></div>
          </section>

          <section className="docs-section" id="output">
            <div className="docs-section-title"><span>06</span><div><p>OUTPUT GUARDRAIL</p><h2>Require structured output</h2></div></div>
            <p>Validate every model choice against a strict JSON Schema. On failure, Sentinel can block immediately or make a bounded repair attempt.</p>
            <CodeBlock code={outputCode} label="policy.yaml" language="YAML" />
          </section>

          <section className="docs-section" id="tools">
            <div className="docs-section-title"><span>07</span><div><p>TOOL GUARDRAIL</p><h2>Filter calls, never execute them</h2></div></div>
            <p>Policies can allow or block offered tools by exact name and small literal argument matchers. Returned calls must also satisfy the function schema before your application sees them.</p>
            <CodeBlock code={toolCode} label="policy.yaml" language="YAML" />
            <div className="docs-callout warning"><strong>Your application owns execution</strong><p>Sentinel never dispatches a tool. Route allowed calls through a fixed registry with its own authorization and least-privilege controls.</p></div>
          </section>

          <section className="docs-section" id="results">
            <div className="docs-section-title"><span>08</span><div><p>REFERENCE</p><h2>Results and errors</h2></div></div>
            <p>A successful call includes the model response, the guarded provider request, request context, duration, and ordered lifecycle events. Treat <code>providerRequest</code> as sensitive because it may still contain prompt data.</p>
            <CodeBlock code={errorCode} label="errors.ts" />
          </section>

          <section className="docs-section" id="limitations">
            <div className="docs-section-title"><span>09</span><div><p>SCOPE</p><h2>Current limitations</h2></div></div>
            <ul className="limitations-list">
              <li><Check /> Text completions and non-streaming function calls only</li>
              <li><Check /> One OpenAI-compatible provider adapter; no routing or fallback</li>
              <li><Check /> Policies load at startup and do not hot reload</li>
              <li><Check /> Native prompt-injection inference is server-side only</li>
              <li><Check /> Model artifacts are deployed separately from the SDK package</li>
            </ul>
          </section>

          <div className="docs-next">
            <div><span>NEXT STEP</span><strong>Explore the source</strong><p>Read the implementation, policies, and deterministic test suite on GitHub.</p></div>
            <a href="https://github.com/24aysh/sentinel/" target="_blank" rel="noreferrer"><ArrowRight /></a>
          </div>
        </main>

        <aside className="docs-toc">
          <span>ON THIS PAGE</span>
          <a href="#introduction">Introduction</a>
          <a href="#requirements">Requirements</a>
          <a href="#installation">Installation</a>
          <a href="#quick-start">Quick start</a>
          <a href="#policy">Policy file</a>
          <a href="#results">Results & errors</a>
          <div className="toc-help"><strong>Need more detail?</strong><p>The repository README contains the full API reference.</p><a href="https://github.com/24aysh/sentinel/blob/main/apps/gateway/README.md" target="_blank" rel="noreferrer">Open README <ArrowUpRight /></a></div>
        </aside>
      </div>

      <footer className="docs-footer">
        <div className="page-shell"><a className="brand" href="/"><SentinelMark className="brand-mark" /><span>Sentinel</span></a><span>Documentation for the Sentinel SDK.</span></div>
      </footer>
    </div>
  )
}
