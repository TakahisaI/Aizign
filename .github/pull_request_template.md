## Closes

Closes #

## What this slice does

<!-- One pull request = one reviewable slice. State what changes and what does not. -->

## Scope

- **Change class:** <!-- Routine change | Boundary change | Milestone review -->
- **Accepted decision:** <!-- Issue or ADR link. -->
- **Affected contexts or process surfaces:**
- **Explicitly out of scope:**

## Authority and ownership

- **Canonical authority:** <!-- Normative document, accepted ADR, specification, or owner-local source/tests. -->
- **Canonical implementation owner:**
- **Old or duplicate paths:** <!-- deleted | migrated | provisional with trigger | retained for a distinct responsibility -->

## Evidence

- **Commands and tests run:**
- **Concrete failure case checked:**
- **Known limitations or evidence gaps:**
- **Contract divergence discovered:** <!-- None, or link the returned proposal/ADR change. -->

## Independent review

<!--
Routine: "Not applicable — remains within <accepted owner-local contract>."
Boundary/Milestone: link the review brief, Breaker reports, and adjudication.
The review brief is a manual Markdown record; no generated packet or digest is required during the pilot.
-->

- **Review brief:**
- **Breaker reports:**
- **Adjudication:**
- **Conductor readiness assessment:**
- **Maintainer decision:** <!-- Keep separate from the Conductor assessment. -->

## Checklist

- [ ] The pull request title uses Conventional Commits format (`feat(core): ...`).
- [ ] `cargo xtask check` passes locally, or the PR explains why a narrower documented check is sufficient.
- [ ] Behavior, API, schema, dependency-boundary, architecture, security, support, compatibility, release, or repository-process changes were accepted in an Issue before implementation.
- [ ] Changes requiring an ADR include one, or ADR is not applicable under `CONTRIBUTING.md`.
- [ ] Every affected old or duplicate path has an explicit disposition.
- [ ] Tests or inspections cover at least one concrete failure case, or the change is an allowed prose-only exception.
- [ ] Boundary/Milestone work follows the proportional review depth in `docs/development/change-workflow.md`.
- [ ] The change contains no raw prompt, model output, credential, private path, or reference to the legacy private repository.
