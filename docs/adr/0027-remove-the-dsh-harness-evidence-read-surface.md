# ADR-0027: Remove the DSH harness-evidence read surface

- Status: Accepted
- Date: 2026-08-29
- Related: ADR-0012, ADR-0015, ADR-0020, ADR-0025, Issue #74, Issue #80
- Implementation checkpoint: [`I80-4B0E009-A`](https://github.com/TakahisaI/Aizign/issues/80#issuecomment-5458957567), amended by [`I80-4B0E009-A1`](https://github.com/TakahisaI/Aizign/issues/80#issuecomment-5459131488)
- Readiness: [Maintainer decision for slice `S1`](https://github.com/TakahisaI/Aizign/issues/80#issuecomment-5459213427)

## Partial supersession

This decision partially supersedes only:

- ADR-0012's two list items that describe current DSH `bindingDigest` and
  `payloadDigest` as harness-session-evidence digests;
- ADR-0015's application of its adapter-evidence model to a current v0.1 DSH
  harness-persistence/cold-read surface and current DSH binding/payload digest
  authority; and
- ADR-0020's `./experimental/evidence` export, presentation metadata/digest
  exports, DSH cold-read support, and repository consumers of that subpath.

ADR-0012's candidate binding and digest decisions, ADR-0015's guarantee and
authority model, and ADR-0020's stable plugin root, sole production TypeScript
transport owner, `./experimental/transport`, dependency direction, and export
auditing remain Accepted. ADR-0025's `trustedValueMappingKey` remains
adapter-local correlation data and is not superseded.

## Context

The DSH evidence source returned an already materialized event array. Its
caller timeout and post-read event-count guard did not bound source I/O,
allocation, event size, page count, or work that continued after cancellation.
Consequently the API could not support its bounded cold-read description.

The supported submit and reconciliation paths do not require DSH session
persistence. Workflow-signal acceptance remains authoritative in the Aizign
control journal, and `workflow.signal.reconcile` already provides the supported
bounded read-only observation of that journal.

## Decision

Remove the DSH harness-evidence read surface without replacement:

- delete `./experimental/evidence`, `EvidenceSource`, the cold-read operation,
  presentation metadata, binding/payload evidence digests, and their tests;
- remove the fake DSH session log and all supported-path waits on or
  classifications from harness observation;
- remove the DSH evidence benchmark sweep, operation kind, timing metric, and
  event count without creating a replacement metric; and
- keep the stable DSH root limited to the plugin entry and retain only
  `./experimental/transport` as the closed repository-only subpath.

The tool's model-visible success value remains `{ disposition, eventId }`.
`canonicalJson` and SHA-256 remain private implementation details solely for
the unchanged trusted-value mapping key. They are not evidence APIs.

Generic adapter guidance may continue to describe conditions that a future
adapter must satisfy if a separately accepted contract claims native
persistence. No current v0.1 DSH supported path claims session cold read,
retention, durability, cancellation, or source-side bounds.

## Consequences

- Submit, failure mapping, and core reconciliation operate with no harness
  persistence dependency.
- The package and benchmark surfaces no longer imply a resource guarantee the
  source cannot enforce.
- Historical baseline and decision records remain history and are not
  rewritten.
- Reintroducing harness-native evidence requires a new accepted contract with
  source-controlled page, record, byte, event-size, cancellation, and work
  bounds.

## Alternatives considered

- **Keep the caller timeout and result-array guard.** Rejected because neither
  bounds source work or memory.
- **Redesign a paginated bounded source now.** Deferred because no supported
  v0.1 submit or reconciliation consumer requires it.
- **Keep a compatibility alias or hidden reader.** Rejected because it would
  preserve the unsupported contract and a second completion observation path.
