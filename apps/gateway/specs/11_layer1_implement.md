# Layer 1 Expanded Input PII Guardrails: Implementation Plan

## 1. Document Purpose

This document converts `10_layer1.md` into an implementation-ready plan for
broadening the in-process gateway's input PII guardrails.

The milestone expands the current email, phone-number, and credit-card detector
into a deterministic local detector for personal data and credential-like
secrets. Detection will use bounded candidate patterns followed by entity-
specific structural validation. A regular-expression match by itself will not
be sufficient for values that have a checksum, parseable structure, known
prefix, or secret-quality requirement.

This is a plan. It does not implement the detector expansion.

## 2. Audited Project Baseline

The current gateway is the SDK-only implementation recorded in `09_v1.3.md`.
The supported execution path is:

```text
Consuming application
        |
        v
ModelGateway
        |
        v
gateway.chat.completions.create()
        |
        v
GatewayPipeline
   |              |
   v              v
GuardrailHub    ModelProvider
```

There is no inbound HTTP server. `OpenAICompatibleProvider` continues to use
outbound HTTP to call a model provider.

### 2.1 Current package and policy state

| Area | Current state |
| --- | --- |
| Package | Private `@llm-gateway/sdk` version `0.3.0` |
| Runtime target | Bun for repository work; built SDK compatible with Node.js 20+ |
| Public operation | `gateway.chat.completions.create()` |
| Policy loading | Strict local YAML loaded once by `ModelGateway.create()` |
| Policy API | `guardrails/v1` |
| Input actions | First matching rule chooses `allow`, `redact`, or `block` |
| Input roles | `system`, `user`, and `assistant` |
| Existing entities | `EMAIL`, `PHONE_NUMBER`, and `CREDIT_CARD` |
| Existing validation | Pattern checks for all three; digit length for phones; Luhn for cards |
| Redaction | Immutable, offset-based, with `<ENTITY_NAME>` as the default replacement |
| Decision precedence | Any block wins; otherwise all redact findings are replaced |
| Failure mode | Policy-controlled fail-open or fail-closed for unexpected evaluator failures |
| Output guardrails | Strict JSON Schema validation with bounded repair retries |
| Logging | Structural metadata only; raw prompt and matched values are excluded |

The current input path is already separated correctly:

1. `policy-loader.ts` validates YAML entity names against `PII_ENTITIES`.
2. `pii-detector.ts` locates candidates, validates cards, records offsets, and
   removes overlaps.
3. `input-evaluator.ts` resolves findings against ordered policy rules and
   applies immutable redaction or blocking.
4. `ConfiguredGuardrailHub` exposes this behavior to `GatewayPipeline`.

The SDK facade, pipeline lifecycle, provider boundary, output validator, and
error contract do not need redesign for this milestone.

### 2.2 Current verification state

`09_v1.3.md` records the last completed verification as 63 passing tests across
eight test files, plus successful type and package checks. During this planning
audit, those commands could not be rerun because the current shell does not
have the `bun` executable installed. Implementation must re-establish the full
verification result in an environment with the repository's required Bun
version.

### 2.3 Current uncommitted context

At planning time, `10_layer1.md` is untracked and there are user edits in:

- `policies/example-policy.yaml`, where the output rule is commented out; and
- `scripts/smoke-sdk.ts`, where the smoke prompt and default model were changed.

Implementation must preserve those choices. In particular, expanding the
example input rule must not silently re-enable the commented output rule or
revert the smoke script's model and prompt.

## 3. Milestone Scope

The policy entity vocabulary will become:

```ts
export const PII_ENTITIES = [
  "EMAIL",
  "PHONE_NUMBER",
  "IP_ADDRESS",
  "API_KEY",
  "JWT",
  "PRIVATE_KEY",
  "CLOUD_CREDENTIAL",
  "CREDIT_CARD",
  "DATABASE_CONNECTION_STRING",
] as const;
```

The three existing entity names remain unchanged. The eight new names are
accepted anywhere `guardrails/v1` currently accepts an input entity.

This is an additive `guardrails/v1` change: existing policies retain their
meaning, and no migration is required. The package version should advance from
`0.3.0` to `0.4.0` to identify the added feature surface.

## 4. Scope Assumptions Requiring Confirmation

- `CLOUD_CREDENTIAL` initially recognizes AWS access-key IDs and contextual
  secret-access keys, Google API keys/service-account credential fields, and
  Azure Storage account keys and SAS tokens/connection strings.
- `API_KEY` covers supported non-cloud prefixed tokens plus high-entropy generic
  secrets only when they appear next to an explicit key/token/secret label.

These defaults keep the first release testable and reduce false positives.
Adding other countries or cloud providers later will extend internal detector
catalogs without changing the YAML action model.

If a different jurisdiction or provider set is required for the first release,
that catalog must be settled before detector fixtures are implemented.

## 5. Goals

The implementation must:

1. Support all nine entity categories in input policy rules.
2. Keep detection deterministic, local, synchronous, and free of network calls.
3. Separate inexpensive candidate discovery from structural validation.
4. Validate checksums, encodings, lengths, prefixes, parseable structure, and
   entropy where they materially reduce false positives.
5. Return exact UTF-16 offsets suitable for JavaScript string slicing.
6. Resolve duplicate and overlapping findings deterministically.
7. Preserve first-match rule resolution, role filters, block precedence, and
   immutable redaction.
8. Ensure the provider never receives a matched value whose resolved action is
   `redact` or `block`.
9. Avoid including matched values in findings, lifecycle events, logs, public
   errors, or thrown validation messages.
10. Keep existing policies and custom `GuardrailHub` implementations working.
11. Keep output JSON Schema behavior unchanged.
12. Add positive, negative, boundary, overlap, integration, and package tests.
13. Update the example policy, deterministic guardrail script, smoke behavior,
   and README to demonstrate the expanded layer.

## 6. Non-goals

This milestone must not:

- inspect model output for PII;
- add prompt-injection, toxicity, malware, or general content-safety checks;
- verify whether a detected credential is active;
- call cloud, identity, banking, DNS, WHOIS, or secret-scanning services;
- cryptographically verify JWT signatures;
- decrypt encrypted keys or credentials;
- attempt exhaustive support for every national identifier or cloud provider;
- infer a phone's owner or geolocation;
- classify IP addresses as malicious;
- introduce confidence scores into the policy contract;
- add per-rule detector thresholds or arbitrary regular expressions;
- add policy hot reload;
- change input actions, rule ordering, role matching, or failure-mode semantics;
- change the chat API, provider request, output retry behavior, or lifecycle
  stage names;
- add an inbound HTTP server; or
- persist prompts, findings, or decisions.

## 7. Detection Architecture

### 7.1 Two-stage detection

Every entity detector will follow the same internal contract:

```text
message content
    |
    v
bounded candidate extraction
    |
    v
entity-specific structural validation
    |
    v
exact candidate span
    |
    v
global deduplication and overlap resolution
    |
    v
PiiFinding without the matched value
```

Candidate extraction may use regular expressions or a small scanner, but it
must only identify plausible bounded substrings. The second step must validate
the candidate before a `PiiFinding` is created.

The matched string may exist as a local variable while it is being validated.
It must not be stored on `PiiFinding`, placed in an exception message, passed to
the logger, or returned from the guardrail hub.

### 7.2 Internal detector contract

`pii-detector.ts` will retain the exported `detectPii(messages)` facade used by
the evaluator and tests. Internally, it will use a typed registry similar to:

```ts
interface EntityDetector {
  entity: PiiEntity;
  precedence: number;
  find(content: string): Span[];
}
```

Shared helpers will provide:

- boundary checks;
- separator normalization without changing reported offsets;
- safe base64/base64url decoding;
- Shannon entropy calculation for bounded secret candidates;
- repeated/sequential-character rejection;
- checksum helpers;
- duplicate span removal; and
- overlap resolution.

Detection remains an internal SDK detail. No detector registry, raw match, or
validator function becomes part of the public package entry.

### 7.3 Pattern safety and bounds

Candidate expressions must be linear or predictably bounded. They must avoid
ambiguous nested repetition and other catastrophic-backtracking shapes.

Each secret-like candidate will have an explicit maximum length before entropy,
decoding, or parsing is attempted. PEM detection will have a bounded body size.
JWT segments and database connection strings will also be bounded. The exact
constants will live beside detector helpers and receive boundary tests.

If an internal detector invariant fails unexpectedly, the existing guardrail
runtime failure mode applies. Ordinary invalid candidates are simply ignored;
they are not runtime failures.

### 7.4 Offsets and immutability

Offsets remain JavaScript UTF-16 string offsets because redaction uses
`String.prototype.slice()`. Validation may normalize a local copy of a
candidate, but the reported `start` and `end` always identify the original
substring, including permitted separators.

The caller-owned `ChatInput`, normalized `ChatRequest`, message array, and
message objects must remain unmodified. Redaction continues to copy only the
request and messages that need transformation.

## 8. Entity Detection Contract

### 8.1 Summary

| Entity | Candidate discovery | Required validation |
| --- | --- | --- |
| `EMAIL` | Local part, `@`, and domain candidate | Total/local/domain-label lengths, legal label boundaries, and at least one domain separator |
| `PHONE_NUMBER` | Optional international prefix plus digits and common separators | 10–15 normalized digits, valid leading/prefix shape, balanced punctuation, and rejection of repeated-placeholder values |
| `IP_ADDRESS` | Bounded IPv4 and IPv6 candidates | Node `net.isIP()` after removing allowed IPv6 brackets; accept both public and private ranges |
| `API_KEY` | Known prefixes or explicit key/token/secret assignment context | Prefix-specific length/alphabet rules or bounded generic-secret length, diversity, and entropy checks |
| `JWT` | Three dot-separated base64url segments | Bounded segments, decodable JSON header and payload objects, non-empty supported `alg` shape, and a decodable non-empty signature segment |
| `PRIVATE_KEY` | PEM begin/end markers | Matching private-key labels, supported key type, bounded valid base64 body, and non-empty decoded bytes |
| `CLOUD_CREDENTIAL` | AWS, Google, and Azure-specific prefixes/fields | Provider-specific length/alphabet/prefix rules; entropy for secret halves; contextual pairing where a raw secret is otherwise ambiguous |
| `CREDIT_CARD` | 13–19 digits with allowed separators | Separator shape, non-placeholder digits, valid issuer/MII prefix shape, and Luhn checksum |
| `DATABASE_CONNECTION_STRING` | Supported database URI schemes and key/value DSNs | Successful structural parsing, supported scheme/driver, required endpoint/database fields, and syntactically complete credential/parameter boundaries |

### 8.2 Email addresses

The current entity name and normal valid behavior remain unchanged.

Validation will additionally reject candidates when:

- the full address exceeds 254 characters;
- the local part exceeds 64 characters;
- the domain has no dot-separated suffix;
- a domain label is empty, exceeds 63 characters, or begins/ends with `-`;
- leading/trailing dots or consecutive dots occur in the local part; or
- surrounding identifier characters show that the candidate is embedded in a
  larger token.

Quoted local parts, comments, internationalized local parts, and domain literals
are deferred. This keeps behavior deterministic and compatible with the current
ASCII-oriented detector.

### 8.3 Phone numbers

Phone candidates will normalize spaces, parentheses, hyphens, and dots locally.
They must contain 10 through 15 digits, may start with one `+`, and must reject:

- letters inside the candidate;
- unbalanced parentheses;
- extensions outside the explicitly supported `x`/`ext` suffix grammar;
- all-identical or obvious sequential placeholder values;
- candidates already accepted as a higher-precedence card, national ID, IBAN,
  IP address, or credential; and
- digit-only candidates without an international prefix or phone-like context
  when their shape is too ambiguous.

This milestone performs structural validation rather than global carrier or
subscriber validation. A later version may add a phone-number metadata library
if country-accurate validation becomes a requirement.

### 8.4 IP addresses

Both IPv4 and IPv6 are in scope, including loopback, link-local, private,
documentation, and public ranges. PII policy decides the action; the detector
does not treat private addresses differently.

Candidate extraction will support bracketed IPv6 literals while reporting the
address span consistently. Final validation uses `isIP()` from `node:net`,
which is available in the Node.js 20+ target and Bun. IPv4 octets outside
`0..255`, invalid compression, invalid hexadecimal groups, ports, CIDR suffixes,
MAC addresses, and version-like dotted numbers are not reported as IP findings.

### 8.5 API keys

API-key detection has two paths:

1. A small reviewed catalog of distinctive non-cloud prefixes with explicit
   suffix alphabet and length rules.
2. A generic contextual form such as `api_key=...`, `token: ...`, or
   `client_secret: ...`.

Generic candidates require a bounded length, multiple character classes or a
sufficiently large alphabet, a minimum Shannon entropy threshold, and rejection
of repeated, sequential, example, redacted, and placeholder values. A random-
looking word without an explicit label is not enough to create a generic
`API_KEY` finding.

Prefix-specific formats may use stricter format checks instead of the generic
threshold when their format is already high-signal. The catalog and thresholds
must be constants with tests, not undocumented magic values inside expressions.

### 8.6 JWTs

JWT detection covers compact signed tokens with exactly three base64url
segments. Detection does not prove authenticity.

The header and payload must decode to JSON objects. The header must contain a
non-empty string `alg`; malformed JSON, invalid base64url, empty segments,
oversized segments, or extra segments are rejected. The signature must be
non-empty and base64url-decodable, but it is not verified because the SDK has
no issuer key or trust context.

Encrypted five-segment JWE values are deferred.

### 8.7 Private keys

The detector recognizes complete PEM blocks for supported private-key labels,
including generic PKCS#8, encrypted PKCS#8, RSA, EC, DSA, and OpenSSH private
keys. The opening and closing labels must match. Whitespace is removed from the
bounded body before strict base64 validation, and decoded content must be
non-empty.

Public keys and certificates are not classified as `PRIVATE_KEY`. An incomplete
or mismatched PEM block is not partially redacted because doing so could leave
key material behind; it is treated as an invalid candidate and covered by a
negative test.

### 8.8 Cloud credentials

The initial provider catalog is AWS, Google Cloud, and Azure:

- AWS access-key IDs require a supported AWS prefix and the documented fixed
  uppercase-alphanumeric shape. Secret-access keys require an AWS-specific
  label or pairing context, the fixed alphabet/length, and secret-quality
  validation.
- Google API keys use their provider prefix and exact suffix shape. Service-
  account `private_key_id`, credential JSON fields, and embedded private keys
  are detected at the smallest complete secret span; private PEM content is
  classified as `PRIVATE_KEY` by precedence.
- Azure Storage account keys and SAS tokens require Azure-specific labels or
  parameter structure. A complete Azure Storage connection string is
  classified as `DATABASE_CONNECTION_STRING` only when it uses a supported
  database scheme; otherwise its credential values are `CLOUD_CREDENTIAL`.

The plan deliberately avoids classifying cloud project IDs, regions, account
names, tenant IDs, or client IDs as credentials when no secret component is
present.

### 8.9 Credit-card numbers

Existing Luhn behavior remains. Validation will also:

- require 13 through 19 normalized digits;
- reject all-identical and obvious sequential placeholders;
- require a plausible non-zero industry/issuer prefix rather than accepting a
  checksum-valid string beginning with zero;
- permit only consistent supported separators; and
- preserve the exact candidate span for redaction.

The detector will not make network calls to identify an issuer and will not log
the BIN/IIN or last four digits.

### 8.10 Database connection strings

The initial URI scheme catalog is:

- `postgres://` and `postgresql://`;
- `mysql://` and `mariadb://`;
- `mongodb://` and `mongodb+srv://`;
- `redis://` and `rediss://`; and
- supported SQL Server URI or key/value DSN forms.

URI candidates are parsed with `URL` only after bounded extraction. The scheme,
authority, host, port, path, query, and percent encoding must be syntactically
valid. Key/value DSNs require a supported driver/server key and complete
semicolon-delimited fields.

The finding covers the complete connection string so redaction cannot leave a
username, password, host, database name, or sensitive query option behind.
Plain web URLs, JDBC strings for unsupported drivers, and isolated hostnames are
not findings in this milestone.

## 9. Duplicate and Overlap Resolution

The current detector sorts primarily by start position and discards later
overlaps. With credential and connection-string entities, that can retain a
small inner match while leaving the rest of a larger secret exposed. The
normalization step must therefore be made explicitly protection-oriented.

For each message:

1. Remove exact duplicate `(start, end, entity)` findings.
2. Build groups of transitively overlapping spans.
3. Within an overlap group, choose the finding with the highest fixed entity
   precedence.
4. For equal precedence, prefer the longer span.
5. For equal length, prefer the earlier start.
6. For an identical span, use the entity declaration order as the final stable
   tie-breaker.
7. Return accepted findings ordered by message index, then start, then end.

The proposed protection precedence is:

```text
PRIVATE_KEY
DATABASE_CONNECTION_STRING
JWT
CLOUD_CREDENTIAL
API_KEY
CREDIT_CARD
EMAIL
IP_ADDRESS
PHONE_NUMBER
```

This ensures, for example, that a database URI wins over an IP address or token
inside it, a JWT wins over a generic high-entropy token, and an IBAN is not
reduced to a phone-like digit span.

Overlap normalization happens before policy rule resolution, as it does today.
One textual span therefore produces one policy entity and one action.

## 10. Policy and Runtime Behavior

### 10.1 YAML contract

The existing input rule shape remains unchanged:

```yaml
input:
  - id: redact-sensitive-input
    detector: pii
    entities:
      - EMAIL
      - PHONE_NUMBER
      - IP_ADDRESS
      - API_KEY
      - JWT
      - PRIVATE_KEY
      - CLOUD_CREDENTIAL
      - CREDIT_CARD
      - DATABASE_CONNECTION_STRING
    roles:
      - user
    action:
      type: redact
```

Unknown entity strings, duplicate entity strings, unknown fields, and all other
currently invalid policy shapes continue to fail during
`ModelGateway.create()`. Disabled policies are still completely validated.

### 10.2 Rule resolution and actions

For each normalized finding:

1. Select the first input rule matching the entity and optional message role.
2. Use the matching rule action, or `defaults.input_action` if no rule matches.
3. Block the complete request if any resolved finding says `block`.
4. Otherwise redact every finding whose action says `redact`, processing spans
   from right to left inside each message.
5. Otherwise allow the original normalized request unchanged.

Custom replacements keep working. Without one, new findings use their entity
placeholder, such as `<JWT>`, `<IBAN>`, or
`<DATABASE_CONNECTION_STRING>`.

### 10.3 Metadata and privacy

`findingCount`, unique `ruleIds`, and unique `entityTypes` continue to appear in
internal guardrail results and sanitized lifecycle/log metadata. No raw matched
value, normalized value, entropy score, checksum digit, token prefix fragment,
country subtype, cloud provider subtype, offset, or surrounding content is
logged.

Public blocking behavior remains:

```text
code: INPUT_GUARDRAIL_BLOCKED
status: 400
message: The request was blocked by an input guardrail.
```

Unexpected detector failures continue to use
`GUARDRAIL_EVALUATION_FAILED` in fail-closed mode or allow the original request
with a sanitized runtime-failure record in fail-open mode.

## 11. Planned Source Changes

### 11.1 Production files

| File | Planned change |
| --- | --- |
| `src/guardrails/types.ts` | Expand `PII_ENTITIES` and therefore `PiiEntity`; preserve result and hub contracts |
| `src/guardrails/input/pii-detector.ts` | Keep the facade; move to a registry; coordinate candidate detection, deduplication, and overlap resolution |
| `src/guardrails/input/pii-patterns.ts` | Add bounded entity candidate extractors and exact span handling |
| `src/guardrails/input/pii-validators.ts` | Add pure structural validators, checksums, parsing helpers, entropy, and placeholder rejection |
| `src/guardrails/input/input-evaluator.ts` | Preserve behavior; adjust only if typing or normalization helpers require it |
| `src/guardrails/config/policy-loader.ts` | No new schema shape; consume the expanded entity enum and retain strict rejection behavior |
| `src/index.ts` | Preserve current public API; do not export detector internals |
| `package.json` | Advance package version to `0.4.0`; avoid new runtime dependencies unless implementation proves a standard-library solution insufficient |

The exact split between `pii-patterns.ts` and `pii-validators.ts` may be adjusted
if one becomes an artificial pass-through. The intent is to prevent one large
file from mixing candidate expressions, checksum algorithms, parsers, overlap
logic, and policy integration.

No change is planned for:

- `model-gateway.ts`;
- `gateway-pipeline.ts`;
- lifecycle stage names;
- model providers;
- output JSON Schema validation; or
- the synchronous custom-`GuardrailHub` constructor path.

### 11.2 Policy, scripts, and documentation

| File | Planned change |
| --- | --- |
| `policies/example-policy.yaml` | Add all expanded entities to the existing redact rule while preserving the currently commented output rule |
| `tests/fixtures/sdk-enabled-policy.yaml` | Include representative expanded entities needed by SDK construction coverage |
| `scripts/test-guardrails.ts` | Exercise multiple new categories through `ModelGateway.create()` and verify the fake provider sees placeholders only |
| `scripts/smoke-sdk.ts` | Preserve the user's current model/prompt edits; optionally add synthetic examples only if the real-provider smoke remains readable and safe |
| `README.md` | Document all entity names, validation approach, catalog boundaries, false-positive tradeoffs, and policy example |
| `.env.example` | No change expected; detectors require no credentials or remote service configuration |

## 12. Test Plan

### 12.1 Pure validator coverage

A focused validator test file will cover algorithms separately from span
extraction:

| Validator | Positive coverage | Negative and boundary coverage |
| --- | --- | --- |
| Email structure | Normal subdomains and supported punctuation | 64/65-character local part, label lengths, consecutive dots, embedded tokens |
| Phone structure | International and formatted national examples | Too few/many digits, bad plus placement, unbalanced punctuation, placeholders |
| IP parser | IPv4, compressed IPv6, bracketed IPv6 | Octet overflow, malformed compression, port/CIDR exclusion, version numbers |
| Entropy | Deterministic synthetic high-entropy values | Repeated, sequential, placeholder, short, and low-diversity values |
| JWT parser | Synthetic decodable header/payload/signature | Bad base64url, non-object JSON, empty signature, extra segment, oversize |
| PEM parser | Each supported private-key label | Public key, certificate, mismatched label, invalid base64, incomplete/oversize block |
| Cloud formats | Synthetic AWS, Google, and Azure fixtures | Wrong prefix, length, alphabet, missing context, public identifiers only |
| Luhn | Valid synthetic card numbers | Invalid checksum, invalid length/prefix/separators, placeholders |
| DB parser | Every supported URI/DSN scheme | Plain URL, incomplete URI, unsupported driver, malformed percent encoding, truncation |

All fixtures must be clearly synthetic or reserved for documentation/testing.
No live credential or real person's identifier may be committed.

### 12.2 Detector coverage

`pii-detector.test.ts` will be expanded to verify:

- at least one accepted finding for every entity;
- at least one look-alike rejection for every entity;
- multiple entity types in one message;
- findings across system, user, and assistant messages;
- stable message index, role, start, and end values;
- values adjacent to punctuation and Unicode text;
- exact duplicate removal;
- all important overlap pairs, especially JWT/API key, cloud/API key,
  database/IP, database/credential, IBAN/phone, national ID/phone, and
  card/phone;
- deterministic finding order independent of detector registry traversal;
- no raw value on returned findings; and
- bounded behavior for maximum-length and just-over-limit candidates.

### 12.3 Policy-loader coverage

`policy-loader.test.ts` will verify:

- a `guardrails/v1` policy containing all eleven entity names loads;
- every new entity can appear alone;
- duplicate values are still rejected;
- a near-miss or unknown entity is rejected;
- existing three-entity policies load without changes;
- disabled policies still validate the expanded list; and
- policy error messages do not echo sensitive YAML values.

### 12.4 Evaluator and hub coverage

`guardrail-hub.test.ts` will verify:

- default entity-specific placeholders for every new entity;
- one custom replacement across mixed entities;
- no mutation of caller-owned messages;
- first-match allow exceptions by role and entity;
- unmatched findings using each default action;
- block precedence over otherwise redactable secrets;
- multiple right-to-left redactions preserving surrounding text; and
- unique, stable `ruleIds` and `entityTypes` metadata.

### 12.5 Pipeline and SDK coverage

Direct pipeline and `ModelGateway` tests will verify:

- matched redacted content is absent from the provider's first request;
- blocked content results in zero provider calls;
- the public error remains generic;
- lifecycle metadata contains entity names and counts but no values;
- fail-open and fail-closed behavior still applies to detector exceptions;
- no-policy and disabled-policy calls remain byte-for-byte unaffected by the
  expanded detector catalog;
- output validation and retry behavior remains unchanged; and
- a custom injected `GuardrailHub` remains source-compatible.

### 12.6 Package-boundary coverage

`check-package.ts` and `sdk-entry.test.ts` will continue to verify:

- the entry module is side-effect-free;
- the built SDK imports in Bun and Node.js 20+;
- public declaration emit succeeds;
- no internal detector module is unintentionally exported;
- no inbound server artifact is reintroduced; and
- clean builds do not package stale files.

## 13. Implementation Phases

### Phase 1: Contract and fixtures

1. Confirm the first national-identifier and cloud-provider catalogs.
2. Add the eight entity constants and compile-time exhaustiveness checks.
3. Add synthetic positive, negative, boundary, and overlap fixtures before
   changing detection behavior.
4. Add policy-loader tests proving backward compatibility and new-value
   acceptance.

### Phase 2: Structural validation primitives

1. Extract the current Luhn validator without changing accepted valid cards.
2. Implement bounded normalization and placeholder rejection helpers.
3. Implement Verhoeff and incremental IBAN mod-97 checksum helpers.
4. Implement safe entropy calculation and secret-quality checks.
5. Implement bounded base64/base64url and PEM validation.
6. Implement IP, URL, JWT, and DSN structural parsers with Node-standard APIs.
7. Unit-test every primitive and boundary.

### Phase 3: Entity detectors

1. Implement the eleven typed detector entries.
2. Ensure candidate patterns only select bounded plausible spans.
3. Apply the structural validator before emitting each finding.
4. Preserve original offsets through normalization.
5. Add provider/country sub-detectors behind the generic public entities.

### Phase 4: Normalization and evaluation integration

1. Replace the current overlap algorithm with grouped, protection-oriented
   precedence.
2. Keep `detectPii()` output deterministic.
3. Confirm `input-evaluator.ts` still applies first-match rules and immutable
   right-to-left redaction correctly.
4. Confirm block decisions occur before the provider call.
5. Confirm logs, lifecycle events, and errors remain sanitized.

### Phase 5: Examples and SDK verification

1. Expand the checked-in input policy and deterministic guardrail script.
2. Update README behavior, scope, and limitations.
3. Preserve the user's existing smoke and commented-output-policy choices.
4. Advance the package version.
5. Run the complete verification matrix.
6. Record the implemented behavior and exact verification counts in the next
   as-built spec rather than rewriting this plan.

## 14. Verification Commands

Run from `apps/gateway` using Bun:

```bash
bun test
bun run check-types
bun run test:pipeline
bun run test:guardrails
bun run check:package
```

The real-provider smoke is optional because it requires external configuration
and network access:

```bash
bun run smoke:sdk
```

The deterministic suite must pass without an API key, listener, or network
connection.

## 15. Acceptance Criteria

The milestone is complete when:

1. `guardrails/v1` accepts exactly the eleven documented PII entity names.
2. Existing three-entity policies retain their current behavior.
3. Every accepted finding passes an entity-specific structural validator; no
   checksum-bearing or parseable entity is accepted solely by regex.
4. Cards require Luhn, IBANs require mod-97 and country length, Aadhaar requires
   Verhoeff, and IP/JWT/database/key candidates pass their documented parsers.
5. Generic secret detection requires explicit context plus length, diversity,
   placeholder rejection, and entropy checks.
6. Positive and negative synthetic fixtures exist for every entity.
7. Overlap resolution always redacts the complete highest-protection span.
8. `allow`, `redact`, and `block` work for every new entity through the existing
   ordered policy model.
9. A redacted or blocked value never reaches the provider.
10. Caller inputs remain unmodified.
11. No matched value or derived sensitive fragment appears in logs, lifecycle
    events, errors, or guardrail results.
12. No-policy, disabled-policy, custom-hub, output validation, provider, and SDK
    packaging behavior remains unchanged.
13. The example policy and README document the expanded input layer accurately.
14. The complete Bun test, type, deterministic-script, and package checks pass.

## 16. Principal Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| False positives from random-looking text | Require distinctive prefixes or explicit assignment context plus structural and entropy checks |
| False negatives from an intentionally bounded catalog | Document exact providers/countries and extend catalogs with fixtures in later releases |
| Inner match leaves part of a larger secret visible | Use protection-oriented overlap groups and prefer complete connection/key/token spans |
| Catastrophic regex behavior on long prompts | Use bounded linear patterns, explicit candidate limits, and boundary tests |
| Numeric entities collide | Validate checksum/length first and use fixed overlap precedence |
| Entropy threshold becomes opaque | Name constants, document rationale, and test values immediately around thresholds |
| Raw secrets leak during debugging | Never attach candidate values to findings/errors/logs; add negative serialization assertions |
| Provider format changes | Isolate provider catalogs and test each format independently; do not weaken generic detection to compensate |
| New detector work disturbs output guardrails | Keep changes inside input modules and retain output regression tests |
| Dependency growth harms SDK portability | Prefer Node 20 standard APIs and pure helpers; require justification and package checks for any new dependency |

## 17. Deferred Extensions

The following are natural later layers but are intentionally deferred:

- country-qualified national-ID policy entities;
- additional national ID formats;
- additional cloud and SaaS credential catalogs;
- JWE and other signed/encrypted token formats;
- client-configurable secret thresholds;
- output PII scanning;
- decoded-JWT claim-level redaction;
- credential revocation or liveness checks;
- external DLP/PII engines;
- streaming, tool-call, multimodal, and retrieved-context guardrails; and
- policy hot reload or remote policy distribution.
