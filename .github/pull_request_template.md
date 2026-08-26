## Issue record

<!--
Issue-backed work:
- write `Refs #<number>` for an intermediate slice;
- write `Closes #<number>` only when this PR satisfies the Issue's remaining outcome-level completion evidence.
Allowed Ordinary no-Issue work: write `No Issue — <applicable exception>`.
-->

## What this slice does

<!-- One pull request = one reviewable slice. State what changes and what does not. -->

## Implementation authorization

- **Implementation checkpoint:** <!-- Higher-risk: link the accepted exact-base Issue comment and name its checkpoint ID. Ordinary: Not required. -->
- **Planning base:** <!-- Higher-risk: exact main commit inspected by the checkpoint. Ordinary: Not required. -->
- **Ready for implementation decision:** <!-- Higher-risk: link the separate Maintainer decision. Ordinary: Not required. -->
- **Slice ID and purpose:** <!-- Higher-risk: name one authorized slice. Ordinary: describe the owner-local slice. -->

## Required records

- **Change class:** <!-- Ordinary change | Higher-risk change -->
- **Accepted decision:** <!-- Higher-risk: link the accepted Issue and any ADR required by Governance or CONTRIBUTING.md. Ordinary: name the accepted owner-local contract. -->
- **Affected paths or contexts:**
- **Explicitly out of scope:**
- **Canonical authority and owner:**
- **Old or duplicate paths and disposition:** <!-- deleted | migrated | provisional with owner and trigger | retained for a distinct responsibility -->
- **Commands, tests, or inspections run:**
- **Concrete failure case checked:**
- **Known limitations or evidence gaps:** <!-- Include an owner or next action. -->
- **Contract or checkpoint divergence:** <!-- None, or link the revised Issue/ADR/checkpoint and renewed readiness decision before implementation continues. -->

## Independent review for higher-risk changes

<!--
Ordinary: write "Not required — remains within the accepted owner-local contract."
Higher-risk: bind review to the exact candidate commit and record the accepted
checkpoint, authorities, authorized slice, review question, reviewer, findings,
evidence, and unresolved gaps. A Markdown record, pull-request review, or
equivalent retained project record is sufficient; no particular tool or format
is required.
-->

- **Exact target commit SHA (higher-risk):**
- **Accepted checkpoint and slice inspected (higher-risk):**
- **Authorities and revisions inspected (higher-risk):**
- **Review scope/question and reviewer (higher-risk):**
- **Review record and findings (higher-risk):**

## Maintainer decision

<!-- Record this separately from readiness and review evidence. It is the merge decision, not a reviewer or checklist result. -->

- **Decision:**

## Checklist

- [ ] The pull request title uses Conventional Commits format (`feat(core): ...`).
- [ ] `cargo xtask check` passes locally.
- [ ] An accepted Issue is linked above when required; otherwise this is an allowed Ordinary no-Issue exception recorded in the Issue record above.
- [ ] Changes requiring an ADR include one, or ADR is not applicable under `CONTRIBUTING.md`.
- [ ] Higher-risk work links an accepted exact-base implementation checkpoint, a separate `Ready for implementation` decision, and one authorized slice.
- [ ] The planning base, authority, owner, scope, old-path disposition, and slice still match the accepted checkpoint; otherwise the checkpoint was revised and readiness renewed before implementation continued.
- [ ] Every affected old or duplicate path has an explicit disposition.
- [ ] Tests or inspections cover at least one concrete failure case.
- [ ] `Closes #...` is used only when this PR satisfies the Issue's remaining outcome-level completion evidence.
- [ ] Higher-risk changes include an exact-target independent review record, or the PR records why the change is Ordinary.
- [ ] Known limitations and evidence gaps have an owner or next action.
- [ ] The change contains no raw prompt, model output, credential, private path, or reference to the legacy private repository.
