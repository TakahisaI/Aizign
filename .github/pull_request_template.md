## Closes

Closes #

## What this slice does

<!-- One pull request = one reviewable slice. State what changes and what does not. -->

## Bounded contexts or process surfaces touched

<!--
Product/runtime example: crates/aizign-core/src/workflow, adapters/dsh/src/mapping.
Repository/process example: CONTRIBUTING.md, review workflow, Issue templates, automation.
Explain why more than one is required.
-->

## Change closure

<!--
Use paths, stable IDs, test names, Issue comment links, and exact revisions
rather than general assurances. This note points to evidence; it does not
create or modify product authority or Maintainer approval.

For a Routine change, use a stated Not applicable form only when the linked
change satisfies the canonical Routine predicate in change-workflow.md.
-->

- **Change class:** <!-- Routine change | Boundary change | Milestone review -->
- **Approved checkpoint:** <!-- Boundary/Milestone: checkpoint ID, checkpoint digest, approval reference. Routine: "Not applicable — Routine change within <accepted owner-local contract>." -->
- **Canonical authority:** <!-- Name normative paths or existing owner-local source/tests. -->
- **Canonical implementation owner:** <!-- Name the candidate-artifact owner when artifacts change. -->
- **Duplicate owners removed:** <!-- List removed owners/paths. "Not applicable — no duplicate owner existed or was introduced" is allowed. -->
- **Old paths deleted / migrated / provisional / retained:** <!-- Name every affected old path and disposition. -->
- **Claim IDs:** <!-- CLM-* IDs and statements. -->
- **Range IDs:** <!-- RNG-* commitment/lifecycle/consumer entries and dispositions. -->
- **Evidence requirement IDs:** <!-- EVD-* IDs, falsification, and detecting evidence. -->
- **Review assignments:** <!-- Perspective IDs and assigned subject IDs. -->
- **Explicitly out of range:** <!-- Area, reason, and owner/follow-up. -->
- **Contract divergence discovered:** <!-- "None" or link the returned proposal/contract delta. An unresolved divergence means the PR is not ready. -->
- **Known limitations and evidence gaps:** <!-- "None" or list stable gap ID, owner, trigger, and retained evidence. -->

## Checklist

- [ ] The pull request title uses Conventional Commits format (`feat(core): ...`).
- [ ] `cargo xtask check` passes locally.
- [ ] Changes to behavior, API, schema, dependency boundaries, or repository process were agreed in an Issue before implementation.
- [ ] Changes requiring an ADR include an added and accepted ADR before the corresponding implementation transition, or ADR is not applicable under `CONTRIBUTING.md`.
- [ ] Boundary/Milestone work links approved checkpoint content, digest, approval, and exact evidence; Routine work satisfies the canonical Routine predicate.
- [ ] New Protocol kinds, journal records, and stable error codes are registered in `spec/` and `docs/reference/`, or the field is not applicable.
- [ ] Every affected old or duplicate path has a recorded disposition.
- [ ] Every declared claim, non-out-of-range range, and evidence requirement is assigned to at least one review perspective.
- [ ] Tests are close to the owning context and detect at least one deliberate violation of the boundary they protect, or the change is an allowed prose-only exception.
- [ ] The change contains no raw prompt, model output, credential, private path, or reference to the legacy private repository.
