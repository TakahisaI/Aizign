# ADR-0016: Adopt a repository-owned higher-risk change contract

- Status: Accepted
- Date: 2026-08-26
- Acceptance: [Maintainer decision for Issue #94, comment `5419329850`](https://github.com/TakahisaI/Aizign/issues/94#issuecomment-5419329850)

## Context

Earlier reviews found authority drift, duplicate ownership, silent contract
changes, incomplete evidence, and review context that could not be reproduced.
The accepted scope for this revision keeps the repository contract small and
usable without a particular execution environment.

## Decision

Make [`CONTRIBUTING.md`](../../CONTRIBUTING.md) the sole repository owner of
the public contribution contract for ordinary and higher-risk changes. It
defines:

- Maintainer decision and merge authority as assigned by
  [`GOVERNANCE.md`](../../GOVERNANCE.md), without adding authority beyond that source;
- the ordinary versus higher-risk classification;
- the minimum Issue/ADR and pull-request records and evidence;
- exact-target independent review when the change's risk warrants it;
- canonical ownership and disposition of overlapping old paths;
- the requirement to return to the Issue or ADR before any silent contract
  change; and
- visible evidence gaps and a separate Maintainer merge decision.

Templates collect these records and `AGENTS.md` remains navigation only. The
repository does not require a particular skill, model, agent implementation,
session arrangement, or review tool. Detailed operational notes and optional
execution adapters may exist outside the repository, but they are evidence
only and cannot define the contract or authorize a decision.

## Consequences

Contributors can satisfy the contract manually with the repository's Issue and
pull-request records and ordinary checks. Higher-risk review remains tied to a
specific candidate and named authorities while review depth can match impact.
External execution helpers may reduce repeated work, but their availability or
output is never a prerequisite or proof of compliance. Changes to this contract
must follow the same proposal-first and ADR rules.

## Alternatives considered

- **Keep a detailed execution playbook in the repository.** Rejected because
  it duplicates the public contract and couples contributors to tools or
  operating arrangements that are not repository authority.
- **Require a packet schema, validator, or automated workflow.** Deferred until
  a repeated repository failure demonstrates that the manual records are
  insufficient.
