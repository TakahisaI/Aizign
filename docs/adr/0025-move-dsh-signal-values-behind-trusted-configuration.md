# ADR-0025: Move DSH signal values behind trusted configuration

- Status: Accepted
- Date: 2026-08-28
- Related: ADR-0004, ADR-0007, ADR-0012, ADR-0015, ADR-0020, Issue #72, Issue #79, Issue #80

## Context

Protocol v1 permits bounded `artifactRef` and `shortErrorCode` signal fields,
and the closed journal can retain them. Those shapes are useful metadata, but
shape validation cannot establish value provenance or detect credentials,
prompts, model output, or encoded content hidden inside a syntactically valid
opaque string.

The current DSH submit tool exposes both values directly to the model. That
means the ordinary supported DSH path cannot claim end-to-end exclusion of
prohibited content from allowed opaque values. ADR-0015 records this current
limitation and assigns Issue #72 to change both producer authorities together.

The smallest current requirement is fixed trusted injection. DSH does not need
a generic selector, handle table, failure-category registry, or mapping
service. The Protocol and journal shapes also do not need to change: only the
supported adapter path's value producer and model-visible surface move.

## Decision

Require one closed DSH configuration bundle supplied by the operator or trusted
control plane:

```ts
trustedSignalValues: {
  artifactRef?: string;
  blockedShortErrorCode: string;
}
```

`blockedShortErrorCode` is required for implementation and review bindings.
`artifactRef` is required for an implementation binding and optional for a
review binding. The object accepts no alias, compatibility key, default,
`null`, explicit `undefined`, accessor, custom prototype, or unknown member.
Before preflight, tool registration, or any child process, the adapter-owned
plugin-startup path validates:

- `artifactRef` against `^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$`; and
- `blockedShortErrorCode` against `^[A-Z][A-Z0-9_]{0,63}$`.

The adapter constructs a fresh internal record and does not retain the raw
nested source object as mapping authority or in an error cause. A listed
configuration failure is exposed as `INVALID_EXPECTATION`, not an ordinary
Cordis `ValidationError`, and does not echo the rejected value. If the pinned
Cordis/DSH loader cannot preserve that boundary without changing the loader,
adding a dependency, or weakening the required closed contract, implementation
must return to Issue #72 and this ADR.

Contract the ordinary model-visible DSH submit arguments to exactly:

```ts
{ kind, findingCount? }
```

Remove `artifactRef` and `shortErrorCode` from the tool schema, runtime decoder,
examples, and model-facing documentation without an alias, deprecated key,
ignored compatibility input, or deep alternate entrypoint. An old key or any
other unknown key fails as `INVALID_SIGNAL` before the submit client is invoked
and produces only the fixed safe model-facing message.

Keep the existing Protocol v1 `findingCount` matrix. Resolve trusted values by
kind in one synchronous, side-effect-free DSH-internal resolver:

| Kind | Trusted-value resolution |
|---|---|
| `review_findings` | inject configured `artifactRef` when present; otherwise omit it |
| `repair_submitted` | inject the required configured `artifactRef` |
| `blocked` | inject configured `blockedShortErrorCode` as `shortErrorCode` |
| `review_passed` / `implementation_ready` | inject neither value |

The resolver is the sole owner of the validated binding, decoded model
arguments, and trusted-value injection. From the same validated inputs it
returns the exact `WorkflowSignalSubmitPayload` and a
`trustedValueMappingKey`. Submit execution, the provisional payload-digest
presentation path, and future Issue #79 retention consume that pair rather than
reimplementing the matrix.

For each validated binding and trusted-value bundle, construct this fresh
closed record:

```json
{
  "schemaVersion": 1,
  "eventId": "<validated event id>",
  "expected": {
    "workflowId": "...",
    "assignmentId": "...",
    "attemptId": "...",
    "role": "implementation | review",
    "artifactRevision": "...",
    "candidateDigest": {
      "algorithm": "sha256",
      "hex": "..."
    }
  },
  "artifactRef": "... or null",
  "blockedShortErrorCode": "<validated configured value>"
}
```

Compute the lower-case SHA-256 key over UTF-8:

```text
trustedValueMappingKey =
  sha256("aizign:dsh:trusted-signal-values:v1\n" + canonicalJson(record))
```

`artifactRef: null` represents absence only in this adapter-local mapping
record. It is neither valid configuration nor a Protocol payload value.
`canonicalJson` recursively sorts object member names by ascending UTF-8 bytes,
emits standard JSON escaping with no insignificant whitespace, and includes
every defined member. This v1 record has no arrays; a future version would
preserve array order. It is built only from validated primitives and fresh
plain records, so caller accessors, prototypes, `toJSON`, and `undefined` do
not participate. At least one exact record, canonical JSON, and key vector is
pinned by implementation evidence.

The mapping key fingerprints the complete validated binding and complete
trusted-value bundle. It is independent of the model-selected `kind` and
`findingCount`; those remain in the exact payload. A configured value changes
the key even when the selected kind does not use it.

The key is adapter-local collision-resistant correlation data. It is not Issue
#79's logical-submission key, mathematical injectivity, authenticity, remote
attestation, a signature or MAC, a candidate digest, a Protocol or journal
field, a timing or model-facing value, a workflow outcome, or harness-evidence
authority. Issue #72 creates and passes the pair but does not persist it.
Issue #79 owns atomic pre-spawn retention, single-flight, restart fencing,
unknown/reconciliation lifecycle, and later use of the retained pair. Issue
#80 remains the owner of removing the provisional evidence surface.

Keep Protocol v1 and the journal wire/durable shapes, signal kinds, validation
order, bounds, stable codes, process profile, classification, retry rules, and
package exports unchanged. The core still validates and persists a complete
signal without learning DSH configuration provenance. The exported DSH
`PluginConfig` and `Config` schema migration is intentionally breaking before
v0.1: existing configurations must add the required closed bundle, and there
is no default, compatibility alias, or old model-field shim.

The stronger supported-path guarantee begins only after the runtime migration
lands. It covers the ordinary model-visible DSH submit tool: the model can no
longer choose arbitrary strings that become Protocol/journal `artifactRef` or
signal `shortErrorCode`. It does not cover direct Protocol clients, malicious
or compromised adapters or control planes, existing journal records, or
harness-owned copies of the original tool call. It is not semantic secret
scanning, provenance authentication, signing, or attestation. Trusted
configuration producers remain responsible for hard invariant 10's allowed-
value semantics.

## Consequences

### Implementation note — 2026-08-28

The atomic runtime migration is implemented by the DSH adapter. The ordinary
tool arguments are now exactly `{ kind, findingCount? }`; startup validates a
fresh closed `trustedSignalValues` record before preflight and tool
registration; and the sole internal resolver returns the exact payload plus
the pinned mapping key. The stronger supported-path statement is therefore a
current runtime claim, subject to the residual limitations in this ADR.

The exact host-owned startup wrapper chain for rejected trusted configuration
is recorded separately by
[ADR-0026](0026-pin-the-dsh-startup-error-wrapper-boundary.md). Issue #79 still
owns lifecycle/persistence of the resolver pair and Issue #80 still owns
removal of the provisional evidence surface.

### Positive

- The ordinary DSH model-visible surface will no longer own either opaque
  string after the runtime migration lands.
- A single resolver will produce the exact signal and stable mapping data needed by
  the later lifecycle owner without changing Protocol or journal formats.
- The authority, guarantee, and residual threat boundaries remain explicit.
- Both free-string paths close atomically instead of strengthening only one.

### Negative / Risks

- Existing DSH configuration breaks and must supply the new closed bundle.
- Trusted producers can still provide a syntactically valid but semantically
  inappropriate value, and a malicious adapter can bypass the supported path.
- The mapping key is not an authenticity proof or durable lifecycle fence.
- Until the runtime migration lands, the current model-visible limitation and
  `Not guaranteed` threat classification remain true.

### Follow-up

- Land the ADR and normative target wording first without claiming runtime
  enforcement.
- In a separately readied atomic runtime slice, migrate configuration, tool
  schema/decoder, resolver, plugin wiring, provisional presentation metadata,
  examples, fake/live coverage, benchmark consumers, and current-state trust
  documentation together.
- Prove removed-key zero-submit/zero-state behavior relative to the baseline
  immediately after successful preflight; non-disclosure canaries; the exact
  injection matrix; pre-preflight configuration failure; mapping-key vectors;
  no Protocol/journal/timing leakage; package/deep-path removal; and exact-head
  CI plus performance smoke.
- Permit Issue #79 to consume the exact pair only after the runtime migration
  is on `main`. Preserve Issue #80's removal ownership.

## Alternatives considered

- **Keep both values model-visible.** Rejected because it cannot strengthen the
  ordinary supported-path allowed-value guarantee.
- **Move only one value.** Rejected because the other free-string path retains
  the same end-to-end limitation.
- **Add selectors, handles, or a generic mapping registry.** Rejected because
  fixed trusted values satisfy the current requirement with less authority and
  compatibility surface.
- **Change Protocol or journal shapes.** Rejected because the existing bounded
  fields remain appropriate; only their DSH producer authority changes.
- **Add DLP, signing, or attestation.** Rejected as a different security model
  and outside the current v0.1 scope.
