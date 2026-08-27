# Process profiles

This directory owns the process transport around Aizign Protocol bodies. It
does not own Protocol JSON shapes, operation semantics, or client outcomes.

| Profile | Status | Contract |
|---|---|---|
| [`v1`](v1/README.md) | Current target; runtime migration pending Issue #76 S2 | Canonical one-shot adapter argv, framing, stdin/stdout/EOF/exit/watchdog lifecycle, bootstrap-version selection, correlation, and parent process faults |

The current runtime still contains pre-profile behavior documented as migration
debt in the v1 contract. A process profile is independent of package and
operation Protocol versions.
