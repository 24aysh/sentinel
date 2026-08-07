# Layer 2 Prompt-Injection Guardrail: Implementation Plan

## 1. Document Purpose

This document converts `12_layer2.md` into an implementation-ready plan for a
second input-guardrail layer that detects prompt-injection attempts after the
existing PII layer has completed.

The recommended first release audits four supplied Hugging Face datasets in a
private Kaggle workflow, normalizes their incompatible schemas, and trains and
evaluates one local binary classifier. Python is allowed only for this offline
ML workflow. Runtime detection remains in-process and does not download
datasets, call Hugging Face, persist prompts, or require a vector database.

This is a plan. It does not implement prompt-injection detection or download any
dataset or model.

## 2. Direct Answers to the Design Questions

### 2.1 What a Hugging Face dataset does

A dataset is labeled source material, not an executable detector. A typical
prompt-injection dataset contains rows resembling:

```text
text                                      label
----------------------------------------  ---------
Summarize this document.                  benign
Ignore all previous instructions ...     injection
```

The rows can be used in three different ways:

1. train a classifier that predicts `benign` or `injection`;
2. evaluate a detector on examples it did not train on; or
3. create reference embeddings for similarity search.

The recommended MVP uses the datasets primarily for training and evaluation.
It will also benchmark embedding similarity, but will not add a vector database
unless that approach produces a material measured benefit.

### 2.2 Whether the datasets should be combined

The source datasets should be downloaded and audited independently, then
normalized into one canonical dataset for training. Combining them avoids
running one detector per dataset and gives the model one consistent label
contract.

The combined artifact is not a database. It should be versioned Parquet files
plus a manifest. Every row retains its source dataset, source split, original
label, and stable source-row identifier so results can still be analyzed per
dataset.

Blind concatenation is not sufficient. The curation process must reconcile
labels, remove duplicates and near-duplicates, reject unusable licenses, inspect
class balance, and prevent examples derived from the same template from
appearing in both training and evaluation splits.

### 2.3 How embeddings differ from a trained classifier

A trained classifier learns a decision boundary from both benign and malicious
examples. At runtime it directly returns a score for the prompt-injection
class.

An embedding detector converts the incoming text and known attacks into
vectors, then asks whether the incoming vector is sufficiently close to a known
attack. This is useful for recognizing paraphrases of recorded attacks, but it
has important limitations:

- a new attack may not be close to any stored example;
- a legitimate prompt can be semantically close to an attack discussion;
- thresholds depend on the embedding model and corpus;
- storing one vector per dataset row increases artifact size and memory use; and
- a live vector database adds privacy, retention, tenancy, and poisoning risks.

For this gateway, a classifier is the primary recommendation. A static,
offline-built nearest-neighbor index is a benchmark candidate. An online vector
database of production prompts is explicitly deferred.

### 2.4 Whether previous attacks should be stored automatically

No request should be added automatically to a future-attack store merely
because the detector blocked it. That creates a feedback loop an attacker can
poison and would conflict with the gateway's current no-prompt-persistence
posture.

If reviewed production examples are added later, they must be:

- confirmed and labeled by an authorized reviewer;
- stripped of PII and credentials;
- isolated by tenant and environment;
- governed by retention and deletion policies;
- versioned into a new offline dataset release; and
- evaluated before the rebuilt detector is promoted.

### 2.5 Canary decision

Canary generation, injection, logging, and output scanning are excluded from
this plan. They require a separate specification if revisited.

## 3. Audited Project Baseline

The current package is private `@llm-gateway/sdk` version `0.4.0`. Its public
execution path remains:

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

Relevant current behavior:

| Area              | Current state                                                            |
| ----------------- | ------------------------------------------------------------------------ |
| Input guardrail   | Local PII detection with `allow`, `redact`, and `block`                  |
| Policy            | Strict local `guardrails/v1` YAML loaded once                            |
| Input roles       | `system`, `user`, and `assistant`                                        |
| Evaluation        | One synchronous PII evaluator behind an async hub method                 |
| Failure handling  | Existing policy-controlled fail-open or fail-closed path                 |
| Provider boundary | A block prevents all provider calls                                      |
| Privacy           | Findings and logs exclude matched values and prompt content              |
| Persistence       | Prompts, findings, and decisions are not persisted                       |
| Runtime           | Bun development; built SDK compatible with Node.js 20+                   |
| Network           | No inbound server; only the configured model provider uses outbound HTTP |

Layer 2 should extend the input hub rather than add a second pipeline, facade,
listener, or transport.

## 4. Recommended Release Scope

The proposed release is package version `0.5.0` and remains an additive
`guardrails/v1` change.

It includes:

1. an offline, reproducible private Kaggle dataset-curation workflow;
2. a normalized prompt-injection target that preserves separate harmful-content
   semantics;
3. benchmark comparison of a compact classifier and static embedding search;
4. one selected, versioned local model artifact;
5. an injectable asynchronous runtime detector contract;
6. a `prompt_injection` YAML input-rule type;
7. strict PII-then-prompt-injection ordering;
8. bounded per-message classification and policy thresholding;
9. sanitized lifecycle and logger metadata; and
10. unit, integration, model-quality, performance, and package tests.

The default assumptions are:

- English text only for the first model;
- direct prompt injection and common jailbreak-style instruction overrides are
  one public `PROMPT_INJECTION` finding type;
- user messages are scanned by the example policy;
- other roles remain configurable because assistant history or retrieved text
  may be untrusted in consuming applications;
- model assets are loaded once during gateway construction;
- runtime inference is local and makes no network call; and
- prompt-injection matches support `allow` and `block`, not redaction.

## 5. Confirmed Inputs and Remaining Release Gates

Confirmed inputs are:

- Python is allowed for isolated offline tooling;
- data curation and training run on Kaggle, not local training hardware;
- the four source repositories are those audited in Section 9.2; and
- canaries are out of scope.

The workflow can start with these defaults: English-only and a model intended
for ordinary CPU inference. Before selecting a production model, confirm the
maximum installed model size, cold-load time, warm p95 latency, and memory
budget.

Dataset licensing is a release gate rather than a blocker for metadata and
schema planning. Restricted or unlicensed row content must not be used for
training, evaluation, or redistribution until the necessary rights are
documented.

## 6. Goals

The implementation must:

1. run PII evaluation first;
2. stop immediately when PII policy blocks the request;
3. pass the PII-redacted request, when present, to prompt-injection detection;
4. keep caller-owned inputs immutable;
5. classify only roles selected by prompt-injection policy rules;
6. load the detector and model once, not once per request;
7. keep runtime inference bounded, local, and free of dataset downloads;
8. prevent a prompt-injection block from reaching the model provider;
9. reuse the existing generic `INPUT_GUARDRAIL_BLOCKED` public error;
10. reuse fail-open and fail-closed behavior for detector failures;
11. preserve existing PII rule ordering and behavior;
12. preserve no-policy, disabled-policy, custom-hub, and output-validation paths;
13. avoid logging or returning prompt text, tokens, embeddings, or model inputs;
14. make dataset revisions, licenses, transformations, model version, and
    threshold reproducible; and
15. measure both malicious recall and benign false-positive rate before release.

## 7. Non-goals

This milestone must not:

- claim prompt injection can be eliminated completely;
- inspect images, audio, files, tool results, retrieved documents, or web pages;
- add an inbound HTTP service;
- call a hosted classifier or Hugging Face API during a gateway request;
- download a model during a gateway request;
- automatically store production prompts or embeddings;
- add a production vector database;
- train or fine-tune a model inside the gateway process;
- execute code or instructions contained in a dataset row;
- add canary injection or canary output handling;
- add tool authorization, capability controls, or network egress controls;
- merge prompt injection with PII entity redaction;
- expose raw model scores as a security guarantee;
- change the public chat-completion operation; or
- change JSON Schema output-repair behavior.

## 8. Target Input Workflow

```text
normalized ChatRequest
        |
        v
PII detector and policy resolution
        |
        +-- block --------------------> generic input-block error
        |
        +-- redact/allow
        v
PII-sanitized request
        |
        v
prompt-injection detector
        |
        +-- score below threshold ---> provider
        |
        +-- matching allow rule ------> provider
        |
        +-- matching block rule ------> generic input-block error
```

The second layer runs after a PII `allow` or `redact` result. It does not run
after a PII block. This ordering keeps redacted secrets out of classifier input
when policy has chosen redaction and avoids unnecessary model work on requests
that are already blocked.

Prompt-injection classification must not modify the request. A safe request sent
to the provider is exactly the PII evaluator's resulting request.

## 9. Hugging Face Dataset Workflow

### 9.1 Offline tooling layout

Add a small offline-only directory:

```text
apps/gateway/ml/prompt-injection/
  README.md
  requirements-kaggle.txt
  datasets.yaml
  pipeline.py
  tests/
```

One CLI should expose `audit`, `curate`, `train`, `evaluate`, and `export`
subcommands rather than repeating loading and normalization across scripts.
Python is limited to offline dataset/model work. It does not change the Bun
requirement for gateway development, TypeScript tests, builds, or packaging.

`datasets.yaml` records, for every source:

- Hugging Face repository ID;
- immutable revision commit SHA;
- subset/config name;
- source splits;
- text column;
- label column and label mapping;
- declared language;
- dataset-card URL;
- repository/upstream license;
- `rights_status: approved | restricted | unresolved`;
- whether the dataset is gated; and
- notes about synthetic, adversarial, or human-authored content.

Do not use floating `main` revisions for a release build. Do not enable remote
dataset code. A gated dataset may require an offline developer token, but the
token must never enter source control or the runtime SDK.

### 9.2 Audited sources and source-specific mappings

The source cards expose materially different tasks. Their numeric labels cannot
be concatenated directly.

| Source | Observed schema | Canonical mapping | Planned use |
| ------ | --------------- | ----------------- | ----------- |
| `rogue-security/prompt-injections-benchmark` | 5,000 `text`/`label` rows; string labels `benign` and `jailbreak`; gated; CC BY-NC 4.0 | `benign` -> `pi_label=0`; `jailbreak` -> `pi_label=1`; retain `canonical_class=prompt_injection` and an `attack_family=jailbreak_or_injection` qualifier | Held-out research evaluation only when the project use is non-commercial or permission is obtained; do not publish rows |
| `xxz224/prompt-injection-attack-dataset` | 3,747 source rows; benign task text plus five generated attack columns; no prompt-injection class column or visible license | Explode `naive_attack`, `escape_attack`, `ignore_attack`, `fake_comp_attack`, and `combine_attack` into positive rows; map audited `target_text` and `inject_text` fields to provisional negatives; keep original task labels only as provenance | Schema audit only; training, evaluation, and redistribution are blocked until rights and negative-row semantics are confirmed |
| `jayavibhav/prompt-injection-safety` | 60,000 rows; `text` plus undocumented integer labels `0`, `1`, `2`; 50,000 train and 10,000 test; no visible license | Working hypothesis: `0` benign, `1` prompt injection, `2` harmful non-injection. Validate stratified samples before accepting any mapping | Schema audit only; training, evaluation, and redistribution are blocked until label semantics and rights are confirmed |
| `deepset/prompt-injections` | 662 `text`/`label` rows; integer labels `0` benign and `1` injection; train/test splits; Apache-2.0 | `0` -> `pi_label=0`; `1` -> `pi_label=1` | Eligible for training and evaluation |

The `target_label` and `inject_label` fields in `xxz224` describe the original
sentiment, spam, or related task. They must never be interpreted as
prompt-injection labels. Every row exploded from the same source record receives
the same `group_id` so its benign text and attack variants cannot cross dataset
splits.

Under the working `jayavibhav` mapping, the three labels require two targets:

| Source label | `pi_label` | `content_safety_label` | `canonical_class` |
| ------------ | ---------- | ---------------------- | ----------------- |
| `0` | `0` | `0` | `benign` |
| `1` | `1` | `null` | `prompt_injection` |
| `2` | `0` | `1` | `harmful_non_injection` |

A harmful request is not automatically a prompt injection. The secondary
content-safety target is retained for future work but is not used to train or
enforce Layer 2. If Kaggle sample review does not confirm these meanings, all
affected rows remain quarantined instead of guessing a mapping.

The current cards are an audit starting point. The first Kaggle run must resolve
each repository's full commit SHA with `HfApi.dataset_info(...).sha`, inspect
label-stratified samples, and write the full SHA and findings into the manifest.
Short commit prefixes and floating `main` revisions are not reproducible inputs.

### 9.3 Canonical row schema

Every accepted row becomes:

```text
text: string
pi_label: 0 | 1              # sole Layer 2 training target
content_safety_label: 0 | 1 | null
canonical_class: benign | prompt_injection | harmful_non_injection
source: string
source_revision: string
source_split: string
source_row_id: string
original_label: string
attack_family: string | null
language: string
group_id: string             # duplicate/template family boundary
usage: train_candidate | eval_only | quarantined
```

The canonical artifact must not discard provenance after concatenation. The
runtime classifier trains only on `pi_label`; it does not become a general
harmful-content classifier.

### 9.4 Curation sequence

The deterministic curation script will:

1. load each pinned source with Hugging Face `datasets.load_dataset()`;
2. select only the audited configs, splits, and columns;
3. assert each source's columns, label set, split sizes, and pinned revision;
4. explode the five `xxz224` attack columns without losing the shared source ID;
5. map source labels into `pi_label` and the separate content-safety field;
6. reject null, empty, non-string, and over-limit rows;
7. normalize a local comparison copy with Unicode NFKC, control-character
   handling, and bounded whitespace normalization;
8. preserve the original text used for training unless a documented
   transformation is required;
9. remove exact duplicates by normalized-text hash;
10. identify near-duplicate and templated families before splitting;
11. resolve conflicting labels through a report and explicit rule, never silently;
12. inspect and report class, language, source, length, and usage distributions;
13. create deterministic train, validation, and test splits by `group_id` using
    only license-eligible rows;
14. preserve official test splits as evaluation-only where practical;
15. reserve at least one source-held-out evaluation slice when dataset count
    permits it;
16. export versioned Parquet splits and a machine-readable summary; and
17. record SHA-256 checksums for the manifest, curated artifacts, and scripts.

The source-held-out result is important: a detector can score well on random
rows while merely memorizing attack templates duplicated across datasets.

### 9.5 Dataset safety and licensing

Before a source is admitted:

- read its dataset card and repository license;
- trace the original upstream dataset when the Hub repository is a mirror;
- quarantine missing or incompatible redistribution terms from release data;
- record any usage restrictions;
- inspect samples from every label and split;
- scan for accidental live credentials and personal data;
- treat all row content as inert text; and
- never execute dataset-provided scripts or commands.

Curated data and trained artifacts may carry obligations from their sources.
License review is therefore a release gate, not documentation cleanup.

Current disposition:

- `deepset` declares Apache-2.0 and is the only immediately release-eligible
  source among the four;
- `rogue-security` is gated and CC BY-NC 4.0, so it is restricted to
  non-commercial research evaluation unless additional rights are obtained;
- `xxz224` and `jayavibhav` show no usable license declaration; availability is
  not permission, so content use for training/evaluation/distribution is blocked
  pending author permission or a documented license; and
- no curated dataset containing gated or unclear-license raw rows may be made a
  public Kaggle Dataset, notebook output, repository artifact, or model bundle.

### 9.6 First-time Kaggle workflow

Keep every notebook private because the workflow touches gated or
unclear-license data.

#### Account and secret setup

1. Create and sign in to Hugging Face and Kaggle accounts.
2. Open the `rogue-security` dataset page while signed in and accept its access
   conditions. A token does not bypass the dataset's gated access approval.
3. In Hugging Face settings, create a separate read-only or fine-grained token
   for Kaggle. Do not use a write token.
4. In Kaggle, choose **Code -> New Notebook** and leave the accelerator set to
   **None** for the data-audit notebook.
5. Enable Internet for the notebook because Hugging Face data must be fetched.
6. Add a Kaggle secret named `HF_TOKEN`, paste the Hugging Face token into the
   secret value, and attach/enable it for this notebook. Never paste or print the
   token in a code cell.

Use this authentication cell:

```python
from kaggle_secrets import UserSecretsClient
from huggingface_hub import login

hf_token = UserSecretsClient().get_secret("HF_TOKEN")
login(token=hf_token, add_to_git_credential=False)
```

Install only the pinned offline requirements in the first cell. During the
initial experiment this may use `pip install`, but the successful versions must
be frozen into `requirements-kaggle.txt` before a reproducible run.

#### Notebook 1: audit and curate on CPU

1. Resolve and record each full revision SHA:

   ```python
   from huggingface_hub import HfApi

   repo_ids = [
       "rogue-security/prompt-injections-benchmark",
       "xxz224/prompt-injection-attack-dataset",
       "jayavibhav/prompt-injection-safety",
       "deepset/prompt-injections",
   ]
   revisions = {
       repo_id: HfApi().dataset_info(repo_id, token=hf_token).sha
       for repo_id in repo_ids
   }
   ```

2. Load row content only when its manifest `rights_status` permits the intended
   use. For unresolved sources, record repository metadata and schema but keep
   row ingestion disabled. Print only feature names, split sizes, label counts,
   and bounded reviewed samples; never print the token.
3. For sources approved for content use, assert the mappings in Section 9.2 and
   manually review stratified examples. In particular, validate all three
   `jayavibhav` labels and the proposed `xxz224` negative fields before enabling
   them. If a rights, assertion, or semantic check fails, stop and update the
   manifest instead of guessing.
4. Normalize, explode, deduplicate, group, and split using the shared offline
   pipeline. Keep `eval_only` and `quarantined` rows separate from eligible
   training files.
5. Write Parquet files, the pinned manifest, checksums, and an audit report under
   `/kaggle/working/curated/`.
6. Save a private notebook version. Do not make its outputs public. Download the
   eligible artifacts or attach the private notebook output as input to the next
   notebook.

Pandas, Parquet processing, and the linear scikit-learn baseline do not benefit
from a GPU, so using one here only consumes Kaggle's accelerator quota.

#### Notebook 2: train and evaluate

1. Create a second private notebook and attach Notebook 1's saved output as an
   input.
2. Train the n-gram linear baseline with the accelerator still set to **None**.
3. For compact-transformer fine-tuning, change the notebook accelerator to
   **GPU**, restart the session, and verify it with:

   ```python
   import torch
   assert torch.cuda.is_available()
   print(torch.cuda.get_device_name(0))
   ```

4. Train only on `usage=train_candidate` rows and `pi_label`. Evaluate separately
   on eligible test data, permission-compatible evaluation-only sources, and
   hand-authored hard negatives. Report quarantined-source coverage as `not run`
   unless its `rights_status` permits evaluation. Never merge evaluation-only
   results back into training.
5. Save the selected model, tokenizer, threshold, metrics, and checksums under
   `/kaggle/working/artifacts/`. Stop the session when training finishes so GPU
   quota is not wasted.

#### Notebook 3: export and verify on CPU

Attach the private model output to a CPU notebook, export the candidate runtime
artifact, run reference-score fixtures, and create the metadata described in
Section 10.3. Download only the model artifact, aggregate metrics, manifests,
and license-safe fixtures into the repository. Raw gated rows and the combined
private dataset remain outside source control.

Kaggle's **Save Version** reruns a notebook from the beginning. Run every cell
top-to-bottom successfully before saving a version, and save/download important
outputs rather than relying on a temporary interactive session.

## 10. Detector Selection and Model Training

### 10.1 Candidates to benchmark

The offline evaluation should compare at least:

1. a character/word n-gram linear classifier as a small, fast baseline;
2. a compact pretrained text-classification model fine-tuned on the curated
   dataset; and
3. cosine similarity against a static index of attack embeddings.

Simple keyword matching may be measured as a baseline but must not be the only
detector because it is easy to evade and prone to blocking benign discussions.

### 10.2 Selection rule

The production detector is selected from measured results, not preference. The
report must include:

- precision, recall, and F1 for the injection label;
- PR-AUC and ROC-AUC;
- false-positive rate on benign prompts;
- results per source dataset;
- results on the source-held-out slice;
- results on obfuscated and multilingual probes, even if unsupported;
- score calibration and chosen threshold;
- artifact size and peak resident memory;
- cold-load time; and
- warm p50/p95 classification latency on documented CPU hardware.

The release threshold must be chosen on validation data and frozen before the
test set is evaluated. The score should be called a model score unless it has
been calibrated; it must not be described as a guaranteed probability of
attack.

Provisional quality targets are at least 90% injection recall with no more than
2% false positives on the curated held-out set. If no candidate meets both,
implementation should stop at the evaluation report rather than weaken the
target invisibly.

### 10.3 Recommended production form

The expected winner is a compact classifier exported for local JavaScript
inference. If a transformer wins, export its model and tokenizer to a pinned
local artifact supported by Transformers.js or another justified Node 20+
runtime. Remote model loading must be disabled.

If the linear baseline meets the quality targets with materially lower size and
latency, prefer it to keep the SDK small. Its exporter must emit a versioned,
bounded artifact, and TypeScript inference must have golden-vector parity tests
against the Python implementation.

The model artifact metadata includes:

```text
artifact_version
model_family
label_map
threshold
maximum_input_tokens
normalizer_version
dataset_manifest_checksum
training_code_checksum
model_file_checksums
quality_metrics
```

## 11. Runtime Detector Contract

Prompt-injection inference is asynchronous internally, even when a selected
runner currently completes locally and synchronously.

A narrow internal/public injection boundary should resemble:

```ts
export interface PromptInjectionDetector {
  readonly identity: { name: string; version: string };

  score(
    messages: readonly ChatMessage[],
    roles: readonly ChatRole[],
  ): Promise<readonly PromptInjectionScore[]>;
}

export interface PromptInjectionScore {
  messageIndex: number;
  role: ChatRole;
  score: number;
}
```

The raw text, normalized text, token IDs, embeddings, and nearest dataset rows
must not be included in a score result. The evaluator turns a score that crosses
a matching policy threshold into a sanitized prompt-injection finding.

The detector should be injectable so deterministic tests and advanced consumers
do not depend on a specific ML runtime. A first-party local implementation may
be exported if its artifact and dependency costs pass the model-selection gate.
Custom `GuardrailHub` injection remains supported unchanged. The standard
composition path adds one optional dependency:

```ts
const detector = await LocalPromptInjectionDetector.create({
  artifactPath: "./models/prompt-injection/v1",
});

const gateway = await ModelGateway.create({
  provider,
  defaultModel: "model-name",
  policyPath: "./policies/example-policy.yaml",
  promptInjectionDetector: detector,
});
```

`ModelGatewayCreateOptions.promptInjectionDetector` is optional when no enabled
prompt-injection rule exists and required when one does. This keeps the YAML
policy responsible for enforcement while application composition owns the
model artifact and runtime dependency.

## 12. Runtime Preprocessing and Bounds

Runtime preprocessing must be generated from or tested against the same
normalizer contract used for training.

For each configured message:

1. retain the original request unchanged;
2. derive a local normalized detection view;
3. apply the selected tokenizer's explicit maximum length;
4. use bounded overlapping windows instead of silently truncating long text;
5. classify windows in bounded batches;
6. use the maximum injection score for that message; and
7. emit at most one finding per message.

Hard limits must cover message characters, token windows, windows per message,
batch size, and total eligible messages. Over-limit behavior must be explicit:
either classify a bounded prefix/suffix strategy documented by the model or
raise a detector failure handled by the existing fail-open/fail-closed policy.
Silent unbounded work is not acceptable.

The classifier is loaded once during `ModelGateway.create()` or explicit local
detector construction. Importing `src/index.ts` must not load a model, access the
filesystem, start a worker, or make a network call.

## 13. Policy Contract

Existing PII rules retain their exact shape. Add a discriminated
`prompt_injection` rule:

```yaml
input:
  - id: redact-sensitive-input
    detector: pii
    entities: [EMAIL, API_KEY, JWT]
    action:
      type: redact

  - id: block-prompt-injection
    detector: prompt_injection
    roles: [user]
    threshold: 0.90
    action:
      type: block
```

Prompt-injection rule constraints:

- `entities` is forbidden;
- `threshold` is required and must be finite and greater than `0` through `1`;
- `roles` is optional and retains current role semantics;
- action type is `allow` or `block`;
- `redact` and `replacement` are forbidden; and
- the first rule whose role matches and whose threshold is crossed wins for
  that message score.

An `allow` rule supports explicit role exceptions and observation-only rollout.
The existing `defaults.input_action` continues to govern unmatched PII findings
only; it must not silently convert a model score into a prompt-injection action.

Prompt-injection inference runs only when the enabled policy contains at least
one such rule. If the rule exists but no detector/model is configured,
`ModelGateway.create()` fails with a sanitized `ConfigurationError` rather than
discovering the mistake on the first request.

## 14. Evaluation and Decision Composition

Refactor the current input evaluator into small sequential steps without
duplicating policy or redaction logic:

```text
evaluateInput
  -> evaluatePii
  -> if blocked, return
  -> evaluatePromptInjection on PII result request
  -> compose sanitized metadata
  -> return allow/redact/block
```

Composition rules:

1. PII block wins immediately and skips ML inference.
2. PII redactions are applied before ML inference.
3. Prompt-injection block discards any intermediate redacted request and returns
   the existing generic block result.
4. If prompt injection allows, retain the PII decision and request.
5. A PII redaction plus prompt-injection allow returns `redact`.
6. No finding returns the original normalized request.

Add sanitized detector metadata, for example
`detectorTypes: ["pii", "prompt_injection"]`, while retaining `entityTypes` for
PII compatibility. Do not log prompt text, scores, thresholds, token counts,
embeddings, nearest examples, or model input fragments.

## 15. Failure and Security Behavior

Expected invalid or benign inputs produce a normal score and are not runtime
errors. Unexpected tokenizer, model-load, inference, or artifact-integrity
failures use the existing runtime failure mode:

- `closed`: throw sanitized `GUARDRAIL_EVALUATION_FAILED`;
- `open`: allow the PII-processed request and record only sanitized failure
  metadata.

Configuration failures such as a missing model, checksum mismatch, unsupported
artifact version, invalid threshold, or prompt-injection rule without a detector
must fail during construction.

The runtime must:

- verify local artifact version and checksums;
- reject paths outside the configured model root;
- disable remote model resolution;
- avoid dynamic code from model repositories;
- place strict size bounds on model files and inputs;
- avoid shared mutable per-request buffers;
- remain safe under concurrent requests; and
- never treat model output as executable instructions.

## 16. Planned Source Changes

The final file names may adjust to the selected runtime, but responsibilities
should remain separated:

| Area                                                | Planned change                                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/guardrails/types.ts`                           | Add discriminated input-rule types, prompt-injection finding/detector contracts, and sanitized detector metadata |
| `src/guardrails/config/policy-loader.ts`            | Strictly parse both PII and prompt-injection rules and validate incompatible fields                              |
| `src/guardrails/input/input-evaluator.ts`           | Orchestrate PII first, then async prompt-injection evaluation, and compose decisions                             |
| `src/guardrails/input/prompt-injection-detector.ts` | Implement bounded preprocessing, batching, scoring, and finding creation behind the detector contract            |
| `src/guardrails/input/prompt-normalizer.ts`         | Share a versioned normalization contract with offline parity fixtures if needed                                  |
| `src/guardrails/guardrail-hub.ts`                   | Accept the configured detector and await the sequential input evaluator                                          |
| `src/model-gateway.ts`                              | Compose or accept the detector during async construction without changing the chat API                           |
| `src/index.ts`                                      | Export only the intended detector configuration/types; remain side-effect-free                                   |
| `src/pipeline/lifecycle.ts`                         | Add `detectorTypes` metadata only if required; do not add prompt content or scores                               |
| `ml/prompt-injection/*`                             | Add pinned offline curation, training, evaluation, export, and documentation tooling                             |
| `policies/example-policy.yaml`                      | Add a user-role prompt-injection block rule after the PII rule once an artifact is available                     |
| `scripts/test-guardrails.ts`                        | Prove PII redaction precedes injection classification and blocked prompts never reach the provider               |
| `scripts/smoke-sdk.ts`                              | Preserve current prompt logging; show the post-input provider request only for allowed prompts                   |
| `README.md`                                         | Explain model setup, dataset provenance, policy, limitations, and local-only runtime behavior                    |
| `package.json`                                      | Advance to `0.5.0` and add only the runtime dependency justified by benchmarking                                 |

The implementation must not add a second gateway pipeline or duplicate
provider, retry, logger, or lifecycle logic in `ModelGateway`.

## 17. Test Plan

### 17.1 Dataset and training tests

- manifest schema and immutable revisions;
- label mapping for every source;
- deterministic row IDs and splits;
- exact and near-duplicate grouping;
- conflicting-label reporting;
- source provenance retention;
- length and null filtering;
- no group crossing train/validation/test;
- reproducible artifact checksums;
- license manifest completeness; and
- Python-to-TypeScript normalization/inference parity fixtures.

### 17.2 Policy tests

- existing PII-only YAML remains valid and unchanged;
- prompt-injection rules load with valid roles, threshold, and actions;
- missing detector configuration fails during enabled gateway construction;
- invalid thresholds, entities, redaction, replacement, and unknown fields fail;
- duplicate rule IDs still fail globally;
- disabled policies still validate all fields; and
- errors do not echo model paths containing secrets or prompt/dataset content.

### 17.3 Input evaluator and hub tests

- PII block skips prompt-injection detection;
- PII redaction occurs before the detector sees messages;
- classifier block prevents provider access;
- classifier allow preserves the PII-redacted request;
- role filtering and first-match allow exceptions work;
- multiple messages use the maximum per-message/window score correctly;
- caller inputs remain immutable;
- findings and metadata contain no raw prompt or embedding;
- detector errors obey fail-open and fail-closed behavior; and
- concurrent requests do not share scores or buffers.

All deterministic TypeScript tests use a fake detector. They must not load a
large model, download artifacts, or require a Hugging Face token.

### 17.4 Model runtime tests

- a small checked-in test artifact loads locally;
- remote model loading is disabled;
- invalid version, checksum, labels, and thresholds fail safely;
- golden prompts match exported reference scores within a declared tolerance;
- Unicode, control characters, long prompts, and window boundaries are covered;
- supported positive and hard-negative examples are classified as expected;
- model loading occurs once; and
- Bun and Node.js 20+ produce compatible decisions.

### 17.5 Privacy and pipeline tests

- blocked text never reaches the provider;
- redacted PII, not the raw value, reaches the classifier;
- logs, lifecycle events, public errors, and results contain no prompt text;
- no runtime files contain stored incoming prompts or embeddings;
- no-policy and disabled-policy requests remain byte-for-byte unaffected;
- output validation and retry behavior remain unchanged;
- custom `GuardrailHub` implementations remain source-compatible; and
- importing the public entry performs no filesystem, model, worker, or network
  side effect.

### 17.6 Quality and performance tests

The offline report must use the frozen test set and include all metrics in
Section 10.2. Performance tests must document hardware, Bun/Node version, model
artifact, batch size, input length, cold load, warm latency, and memory.

## 18. Implementation Phases

### Phase 0: Freeze constraints

1. Use the four repository IDs and source dispositions in Section 9.2.
2. Use Python only in private Kaggle notebooks/offline tooling.
3. Keep canaries out of scope.
4. Confirm English-only scope or list required languages.
5. Set maximum model size, cold-load time, warm latency, and memory budgets.
6. Obtain a commercial-use decision and any missing dataset permissions before
   promoting more than the Apache-2.0 source into production training.

### Phase 1: Curate data reproducibly

1. Create the private CPU Kaggle audit/curation notebook.
2. Resolve full source revisions and validate schemas, labels, licenses, and
   stratified samples.
3. Implement the source-specific mappings, two-target schema, `xxz224`
   explosion, provenance, normalization, and deduplication.
4. Build leakage-safe grouped splits while separating `train_candidate`,
   `eval_only`, and `quarantined` rows.
5. Produce Parquet outputs, summary, and checksum manifests.

### Phase 2: Benchmark detector strategies

1. Train the CPU linear baseline in Kaggle.
2. Fine-tune a compact classifier in a private GPU Kaggle notebook.
3. Build and measure static embedding similarity only as a benchmark.
4. Evaluate quality, size, latency, and memory per source and usage class.
5. Select one license-eligible production approach or stop if quality, runtime,
   or licensing gates are not met.

### Phase 3: Define runtime and policy contracts

1. Add the detector interface and fake implementation fixtures.
2. Add discriminated YAML rule parsing.
3. Add model configuration and construction-time validation.
4. Preserve PII-only and custom-hub compatibility.

### Phase 4: Implement sequential evaluation

1. Split PII evaluation from orchestration without duplicating logic.
2. Run the selected detector on the PII-processed request.
3. Apply role, threshold, and first-match policy behavior.
4. Compose decisions and sanitized metadata.
5. Verify provider blocking and fail-open/fail-closed behavior.

### Phase 5: Integrate the selected local model

1. Export the model and tokenizer/runtime artifact.
2. Add integrity, version, path, size, and remote-loading controls.
3. Add bounded tokenization, windowing, and batching.
4. Add golden parity and concurrency tests.
5. Benchmark Bun and Node.js 20+.

### Phase 6: Documentation and release verification

1. Update example policy, deterministic script, smoke guidance, and README.
2. Document supported languages, threshold, model identity, and known limits.
3. Advance package version to `0.5.0`.
4. Run the complete deterministic and package verification matrix.
5. Record final metrics and implementation deviations in an as-built spec.

## 19. Verification Commands

The existing gateway checks remain mandatory:

```bash
cd apps/gateway
bun test
bun run check-types
bun run test:pipeline
bun run test:guardrails
bun run check:package
```

Offline ML work runs in the private Kaggle notebooks described in Section 9.6.
The shared pipeline should expose a flow equivalent to:

```bash
python ml/prompt-injection/pipeline.py audit --manifest ml/prompt-injection/datasets.yaml
python ml/prompt-injection/pipeline.py curate --manifest ml/prompt-injection/datasets.yaml
python ml/prompt-injection/pipeline.py train
python ml/prompt-injection/pipeline.py evaluate
python ml/prompt-injection/pipeline.py export
```

Deterministic gateway tests and package checks must pass without Python, a
Hugging Face token, network access, or the full training dataset.

## 20. Acceptance Criteria

The milestone is complete when:

1. dataset sources and licenses are explicit and pinned;
2. curated splits are reproducible, deduplicated, and provenance-preserving;
3. model selection is supported by a checked-in evaluation report;
4. the chosen detector meets the agreed quality and runtime budgets;
5. PII block skips prompt-injection inference;
6. PII redaction precedes prompt-injection inference;
7. a prompt-injection block results in zero provider calls;
8. PII-only policies remain backward compatible;
9. invalid prompt-injection policy/model configuration fails at construction;
10. runtime inference is local, bounded, and network-free;
11. no production prompt, token sequence, embedding, or nearest example is
    persisted or logged;
12. fail-open and fail-closed behavior remains correct;
13. no-policy, disabled-policy, custom-hub, output validation, and package
    behavior remains unchanged;
14. public imports remain side-effect-free;
15. no canary behavior or online vector memory is included; and
16. all Bun, type, deterministic-script, model-parity, and package checks pass.

## 21. Principal Risks and Mitigations

| Risk                                            | Mitigation                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Dataset labels disagree                         | Preserve original labels, report conflicts, and require explicit mapping decisions       |
| Duplicate templates inflate metrics             | Group exact/near duplicates before splitting and report source-held-out results          |
| Dataset license is unclear                      | Reject the source until redistribution and model-use rights are confirmed                |
| Detector blocks benign security discussion      | Include hard negatives and release against a measured false-positive target              |
| Obfuscation bypasses detection                  | Normalize a detection-only view and include adversarial transformations in evaluation    |
| Long prompts evade a truncated classifier       | Use bounded overlapping windows and maximum-score aggregation                            |
| Model/runtime makes package too large           | Benchmark a linear baseline and require size/latency approval before dependency adoption |
| Runtime downloads leak prompts or fail offline  | Load pinned local artifacts once and disable all remote model resolution                 |
| Feedback loop is poisoned                       | Do not automatically store blocked production prompts or embeddings                      |
| Logs leak malicious or private text             | Emit only counts, rule IDs, detector names, and generic errors                           |
| Prompt detector is treated as complete security | Document residual risk and keep authorization/egress controls outside model judgment     |

## 22. Deferred Extensions

- reviewed production-example ingestion;
- a static or managed vector index if benchmarking justifies it;
- multilingual models and language-specific thresholds;
- indirect injection in retrieved documents, web pages, files, and tool output;
- tool-call authorization and capability isolation;
- output/action provenance tracking;
- ensemble detectors;
- threshold configuration by tenant or application;
- remote managed classifiers; and
- streaming prompt-injection enforcement.

## 23. References

- The audited source pages are
  [`rogue-security/prompt-injections-benchmark`](https://huggingface.co/datasets/rogue-security/prompt-injections-benchmark),
  [`xxz224/prompt-injection-attack-dataset`](https://huggingface.co/datasets/xxz224/prompt-injection-attack-dataset),
  [`jayavibhav/prompt-injection-safety`](https://huggingface.co/datasets/jayavibhav/prompt-injection-safety),
  and
  [`deepset/prompt-injections`](https://huggingface.co/datasets/deepset/prompt-injections).
- Kaggle explains accelerator availability, quota management, and when GPU use
  is appropriate: [Efficient GPU Usage Tips](https://www.kaggle.com/docs/efficient-gpu-usage).
- Hugging Face documents notebook authentication and recommends a separate,
  least-privilege token per application:
  [`login()` authentication](https://huggingface.co/docs/huggingface_hub/en/package_reference/authentication)
  and [user access tokens](https://huggingface.co/docs/hub/security-tokens).
- Hugging Face documents loading Hub datasets, local files, and Parquet through
  `load_dataset()`: [Datasets loading guide](https://huggingface.co/docs/datasets/loading).
- Hugging Face documents filtering, mapping, splitting, concatenation, and
  Parquet export: [Datasets processing guide](https://huggingface.co/docs/datasets/process).
- Dataset cards provide license, language, size, bias, and usage metadata that
  must be audited before curation: [Dataset Cards](https://huggingface.co/docs/hub/en/datasets-cards).
- Transformers.js supports local Node.js text-classification and feature-
  extraction pipelines, including disabling remote model loading:
  [Transformers.js Node.js guide](https://huggingface.co/docs/transformers.js/main/tutorials/node)
  and [pipeline API](https://huggingface.co/docs/transformers.js/en/api/pipelines).
- OWASP recommends independent output inspection and warns that system prompts
  should not be treated as secrets or authorization controls:
  [OWASP System Prompt Leakage](https://genai.owasp.org/llmrisk/llm072025-system-prompt-leakage/).
- Microsoft's defense-in-depth guidance explains why prompt injection cannot be
  handled as a single input-validation problem:
  [Defend against indirect prompt injection](https://learn.microsoft.com/en-us/security/zero-trust/sfi/defend-indirect-prompt-injection).
