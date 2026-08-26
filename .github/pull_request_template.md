## Closes

Closes #

## What this slice does

<!-- One pull request = one reviewable slice. State what changes and what does not. -->

## Required records

- **Change class:** <!-- Ordinary change | Higher-risk change -->
- **Accepted decision:** <!-- Higher-risk: link the accepted Issue or ADR. Ordinary: name the accepted owner-local contract or the allowed no-Issue exception. -->
- **Affected paths or contexts:**
- **Explicitly out of scope:**
- **Canonical authority and owner:**
- **Old or duplicate paths and disposition:** <!-- deleted | migrated | provisional with owner and trigger | retained for a distinct responsibility -->
- **Commands, tests, or inspections run:**
- **Concrete failure case checked:**
- **Known limitations or evidence gaps:** <!-- Include an owner or next action. -->
- **Contract divergence:** <!-- None, or link the Issue/ADR decision updated before implementation. -->

## Independent review for higher-risk changes

<!--
Ordinary: write "Not required — remains within the accepted owner-local contract."
Higher-risk: bind review to the exact candidate commit and record the authorities,
review question, reviewer, findings, evidence, and unresolved gaps. A Markdown
record, pull-request review, or equivalent retained project record is sufficient;
no particular tool or format is required.
-->

- **Exact target commit SHA (higher-risk):**
- **Authorities and revisions inspected (higher-risk):**
- **Review scope/question and reviewer (higher-risk):**
- **Review record and findings (higher-risk):**

## Maintainer decision

<!-- Record this separately from review evidence. It is the merge decision, not a reviewer or checklist result. -->

- **Decision:**

## Checklist

- [ ] The pull request title uses Conventional Commits format (`feat(core): ...`).
- [ ] `cargo xtask check` passes locally, or the PR explains why a narrower documented check is sufficient.
- [ ] Behavior, API, schema, dependency-boundary, architecture, security, support, compatibility, release, or repository-process changes were accepted in an Issue before implementation.
- [ ] Changes requiring an ADR include one, or ADR is not applicable under `CONTRIBUTING.md`.
- [ ] Every affected old or duplicate path has an explicit disposition.
- [ ] Tests or inspections cover at least one concrete failure case, or the change is an allowed prose-only exception.
- [ ] Higher-risk changes include an exact-target independent review record, or the PR records why the change is Ordinary.
- [ ] Known limitations and evidence gaps have an owner or next action.
- [ ] The change contains no raw prompt, model output, credential, private path, or reference to the legacy private repository.
