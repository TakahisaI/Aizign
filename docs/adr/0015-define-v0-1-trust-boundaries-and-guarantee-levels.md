# ADR-0015: Define v0.1 trust boundaries and guarantee levels

- Status: Accepted
- Date: 2026-08-25
- Related: ADR-0003, ADR-0004, ADR-0007, ADR-0012, ADR-0013, ADR-0014, ADR-0028, Issue #52, Issue #72, PR #70

> **Partial supersession:** [ADR-0028](0028-define-crash-monotonic-jsonl-publication.md)
> supersedes this ADR's target-triple-only JSONL support statement and its
> statement that complete current-layout state has no technical downgrade
> fence. The accepted target is store metadata v2 under
> `linux-x86_64-gnu-ext4-local-v1`; only complete v2 state is fenced, while
> pre-marker partial initialization remains unfenced and operator-discard-only.
> The guarantee levels, trust domains, operator assumptions, and all other
> decisions in this ADR remain Accepted.

> **Partial supersession:** [ADR-0027](0027-remove-the-dsh-harness-evidence-read-surface.md)
> supersedes only this ADR's application of its adapter-evidence model to a
> current v0.1 DSH harness-persistence/cold-read surface and current DSH
> binding/payload digest authority. The five guarantee levels, control-journal
> authority, generic conditional limits for any future separately accepted
> adapter evidence, trust domains, and core reconciliation remain Accepted.

> **Partial supersession:** [ADR-0025](0025-move-dsh-signal-values-behind-trusted-configuration.md)
> supersedes only this ADR's accepted direction that leaves the two ordinary
> DSH `artifactRef` and `shortErrorCode` producer authorities model-controlled.
> This ADR's factual description of the current runtime remains true until that
> migration lands. All other trust-boundary decisions and hard invariant 10's
> producer obligation remain Accepted.

## Context

Aizign already has separate rules for closed protocol decoding, metadata-only
journals, trusted assignment binding, owner-only local state, read-only
reconciliation, and non-collapse of unknown outcomes. Those rules did not share
one threat model. As a result, a security statement could omit its trust
assumption or make CI evidence sound like runtime enforcement.

The most important boundaries cannot be inferred from schemas alone. The core
can validate and compare a candidate digest, but it cannot prove that the
digest was computed from the intended bytes. File permissions can isolate a
state directory from other OS users, but they do not authenticate files
against another process running as the same user. Harness persistence can
provide adapter-specific observations, but it does not supersede the Aizign
control journal.

The v0.1 release therefore needs an explicit authority and guarantee model
before security claims are repeated in package documentation.

## Decision

Publish [`docs/security/threat-model.md`](../security/threat-model.md) as the
normative current threat model. Keep
[`docs/architecture/data-boundary.md`](../architecture/data-boundary.md) as the
narrower authority for data allowed to cross component boundaries. ADRs record
why those current documents exist; package READMEs link to them and describe
only package-specific enforcement.

Use five guarantee levels consistently:

1. **Runtime enforced**: an implementation prevents the unsafe transition or
   output.
2. **Detected and fail closed**: an implementation detects the condition and
   refuses to turn it into a stronger outcome.
3. **Trusted assumption**: the release depends on an operator, control plane,
   adapter implementation, OS, or producer behaving as documented.
4. **Regression evidence**: a test, fixture, audit, or live smoke checks a
   claim but is not the runtime enforcement mechanism.
5. **Not guaranteed**: the property is outside the v0.1 contract or is a known
   limitation.

Do not describe regression evidence alone as a runtime guarantee. A
repository-wide guarantee must identify both its enforcement owner and its
regression evidence. Live smoke evidence is reported separately from normal CI.

The authority model is:

- the committed Aizign journal prefix is authoritative for workflow signal
  acceptance;
- the deterministic core owns validation, duplicate/conflict decisions, and
  state transitions over the values it receives;
- the human operator or trusted control plane owns state-directory selection,
  stable assignment identity, `eventId` generation or retention, and candidate
  digest provenance;
- an adapter owns native mapping, identity isolation, and its model-visible
  surface;
- harness persistence is auxiliary adapter-specific evidence and cannot
  override the control journal;
- Protocol v1 schemas own wire shape and bounds, not semantic provenance or
  content authenticity; and
- the local OS kernel and the account running Aizign are trusted. The store
  protects against unsafe path shapes and accidental or cross-user access, not
  a malicious same-user process that can rewrite all state artifacts.

Treat model-visible arguments, protocol frames, persisted journal bytes on
open, and harness/provider records as untrusted input. Treat configuration only
as trusted at the point where the operator or control plane supplies it; the
adapter must still validate its shape before use. A malicious or compromised
adapter can submit a well-formed lie using trusted-looking identifiers. The
core rejects malformed values and inconsistent bindings but cannot recover
provenance that the wire format does not carry.

Interpret hard invariant 10 as both a structural runtime rule and a producer
obligation. Closed Protocol v1 and journal schemas do not define dedicated raw
prompt, model-output, reasoning, environment, or credential fields. They do not
classify the semantics of every allowed string. The current DSH tool accepts
model-supplied `artifactRef` and `shortErrorCode` strings, so end-to-end
exclusion of credentials or encoded content from allowed opaque values is not
a v0.1 runtime guarantee. Changing both authorities to trusted configuration,
finite selectors, or an equivalent bounded mapping requires a separate
behavior contract.

Candidate SHA-256, store committed-prefix SHA-256, and adapter-local binding or
payload digests have separate authorities. None is a signature, MAC, remote
attestation, or proof of authenticity by itself. Candidate authenticity
depends on the trusted artifact authority computing the configured digest from
the intended bytes. The store digest detects disagreement between the commit
document and the prefix read by the store unless an attacker can rewrite both.

Keep reconciliation strictly observational. It may classify a valid committed
snapshot, but it does not repair, publish, synchronize, retry, or authorize
resubmission. Missing storage, an unpublished tail, corruption, a lock failure,
or transport uncertainty remains unknown. Harness-native cold read has only the
durability, retention, attribution, and bounds that its adapter explicitly
documents.

The v0.1 store guarantee remains limited to the verified
`x86_64-unknown-linux-gnu` target. Other targets fail closed. State-directory
selection and same-directory binary downgrade remain operator responsibilities;
v0.1 has no state-instance manifest or downgrade fence.

## Consequences

### Positive

- Security claims identify their authority, enforcement layer, assumptions,
  regression evidence, and residual risk.
- Closed schemas and digests are no longer described as proving provenance or
  authenticity that they cannot observe.
- Core-journal reconciliation and harness-native evidence remain distinct.
- Known local filesystem, configuration, platform, and downgrade limitations
  become part of the release contract.

### Negative / Risks

- Aizign still trusts the operator/control plane, adapter implementation, local
  account, and OS kernel within their stated domains.
- A same-user process can ignore advisory locks and can forge a self-consistent
  journal plus commit document.
- A wrong but valid initialized state directory cannot be distinguished from
  the intended instance.
- The current model-visible DSH `artifactRef` and `shortErrorCode`, as well as a
  malicious adapter, can place sensitive fragments or encoded content into an
  otherwise allowed opaque field. Schema validation is not data-loss
  prevention or provenance attestation.
- Provider, network, and harness-persistence guarantees remain outside the core
  authority and vary by adapter.

### Follow-up

- Keep the threat matrix synchronized when a new effect, credential, remote
  store, transport, adapter capability, or supported platform is introduced.
- Issue #72 owns the separate authority decisions required to remove free
  model-supplied `artifactRef` and `shortErrorCode` values. Closing only one
  path cannot strengthen the end-to-end allowed-value guarantee.
- Require a new Issue and, where the trust boundary changes, an ADR before
  adding signing, remote attestation, automatic retry, a state-instance
  manifest, downgrade fencing, or multi-tenant operation.
- Keep package documentation concise and link to the threat model instead of
  copying its long-form matrix.

## Alternatives considered

- **Keep the boundary distributed across ADRs and READMEs.** Rejected because
  assumptions and guarantee levels cannot be reviewed as one release contract.
- **Make `SECURITY.md` the full normative threat model.** Rejected because that
  file should remain a concise reporting and support entry point.
- **Treat the adapter or same-user filesystem as untrusted and claim end-to-end
  authenticity.** Rejected because v0.1 has no signature, MAC, attestation,
  credential manager, or separate privilege domain that could enforce it.
- **Describe every tested behavior as guaranteed.** Rejected because tests are
  regression evidence and cannot replace runtime enforcement or an explicit
  trust assumption.
