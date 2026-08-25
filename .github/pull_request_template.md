## Closes

Closes #

## What this slice does

<!-- One pull request = one reviewable slice. State what changes and what does not. -->

## Bounded contexts or process surfaces touched

<!--
Product/runtime example: crates/aizign-core/src/workflow, adapters/dsh/src/mapping.
Repository/process example: CONTRIBUTING.md, review workflow, Issue templates.
Explain why more than one is required.
-->

## Change closure

<!--
Use paths, test names, Issue comment links, and exact revisions rather than
general assurances. This note points to evidence; it does not create or modify
product authority or Maintainer approval.

For a Routine change, use a stated Not applicable form only when the linked
change does not cross the corresponding boundary.
-->

- **Change class:** <!-- Routine change | Boundary change | Milestone review -->
- **Accepted checkpoint:** <!-- Boundary/Milestone: link the approved checkpoint, digest, and approval. Routine: "Not applicable — Routine change within <existing authority or owner-local behavior>." -->
- **Canonical authority:** <!-- Name the normative path or existing owner-local source/tests. -->
- **Canonical implementation owner:** <!-- Name the production owner when behavior changes. -->
- **Duplicate owners removed:** <!-- List removed owners or paths. "Not applicable — no duplicate owner existed or was introduced" is allowed. -->
- **Old paths deleted / migrated / provisional / retained:** <!-- Name every affected old path and its disposition. -->
- **Included ranges:** <!-- Commitment, lifecycle, and consumers. -->
- **Explicitly out of range:** <!-- Area, reason, and owner/follow-up. -->
- **Falsifying tests or observations:** <!-- Name the counterexample and the evidence that detects it. -->
- **Contract divergence discovered:** <!-- "None" or link the returned proposal/contract delta. An unresolved divergence means the PR is not ready. -->
- **Known limitations and evidence gaps:** <!-- "None" or list the limitation/gap, owner, trigger, and retained evidence. -->

## Checklist

- [ ] The pull request title uses Conventional Commits format (`feat(core): ...`).
- [ ] `cargo xtask check` passes locally, or the reason it could not run is recorded with equivalent candidate evidence.
- [ ] Changes to behavior, API, schema, dependency boundaries, or repository process were agreed in an Issue before implementation.
- [ ] Changes requiring an ADR include one, or the ADR field is not applicable under `CONTRIBUTING.md`.
- [ ] Boundary/Milestone work links an approved checkpoint and exact evidence; Routine work uses only the documented exceptions.
- [ ] New Protocol kinds, journal records, and stable error codes are registered in `spec/` and `docs/reference/`, or the field is not applicable.
- [ ] Every affected old or duplicate path has a recorded disposition.
- [ ] Tests are close to the owning context and detect at least one deliberate violation of the boundary they protect, or the change is an allowed prose-only exception.
- [ ] The change contains no raw prompt, model output, credential, private path, or reference to the legacy private repository.
