# ADR-0019: Separate engine and store observation ownership

- Status: Accepted
- Date: 2026-08-26
- Related: ADR-0005, ADR-0014, Issue #74, Issue #88
- Acceptance: [Maintainer v0.1 guarantee rebaseline](https://github.com/TakahisaI/Aizign/issues/74#issuecomment-5421509913)
- Implementation checkpoint: [`I88-1102A30-A`](https://github.com/TakahisaI/Aizign/issues/88#issuecomment-5425116355)
- Readiness: [Maintainer decision for slice `S1`](https://github.com/TakahisaI/Aizign/issues/88#issuecomment-5425507131)

## Context

The engine owns use-case execution and the `JournalReader` / `Journal` ports.
Its optional observer originally also named JSONL implementation details:
committed-prefix reads, SHA-256 verification, record decoding, and publication
hashing. The generic journal ports carried special observed methods solely to
pass that engine observer into the JSONL store. The CLI then matched every
physical stage and inspected the journal path directly to obtain its byte
length.

That layout makes a change to the JSONL commit protocol look like an engine API
change, makes a pathless journal invent filesystem observation, and gives the
CLI knowledge of store internals. Issue #87 first removed the duplicate
plain/observed workflow transitions, so observation ownership can now move
without duplicating workflow semantics.

Child timing remains opt-in, internal, provisional operational evidence. This
decision must preserve its current flat fields, units, measurement intervals,
omission rules, source qualification, and internal `schema_version: 1`. It must
also preserve every workflow result, error, journal mutation, WIRE/DURABLE
shape, dependency direction, and durability barrier.

## Decision

Keep the engine observer limited to aggregate use-case stages:
`JournalLoadDecode`, `Replay`, `Decide`, and `AppendSync`.

Remove committed-prefix read, hash, decode, and publication-hash variants from
`EngineStage`. Remove `load_committed_observed` and `append_observed` from the
generic engine journal ports. Both plain and engine-observed use cases call the
same ordinary `load_committed` and `append` methods. A pathless journal needs no
observer API or physical vocabulary.

Make `aizign-store-jsonl` the single owner of JSONL physical observation. The
store defines a closed `StoreStage` / `StoreObservation` vocabulary, a
`StoreObserver` callback, and a best-effort panic boundary. Store-owned
observed journal wrappers implement the ordinary engine ports while emitting:

- journal open and the successful post-open physical byte count;
- committed-prefix read;
- committed-prefix SHA-256 calculation;
- committed-prefix UTF-8 and record decode; and
- next-prefix hash calculation before commit publication.

The raw JSONL types remain the timing-disabled path and perform no observer
callback or observation-only metadata stat. Observation does not split or
reorder the read, append, barrier, hash, or publication state machine.

Keep `aizign-cli` as the composition consumer. It maps engine and store
observations into disjoint internal timing state and serializes the same flat
child record. It does not define either stage vocabulary and no longer reads a
journal path or filesystem metadata directly.

Delete the now-unowned observed journal methods, physical engine variants,
CLI path inspection, and JSONL journal path accessors. Do not retain aliases or
a second compatibility path: no current repository consumer has a distinct
accepted responsibility for them, and the timing surface is not stable public
compatibility.

## Consequences

### Positive

- Engine observation describes engine use cases rather than one store's
  physical format.
- The JSONL store can change its internal observation vocabulary together with
  its commit protocol owner, subject to the timing stop conditions.
- Pathless engine journal implementations use only the ordinary journal ports.
- The CLI composes observations without inspecting store paths or physical
  implementation details.
- Timing-disabled execution retains the direct raw store and engine path with
  no observation-only I/O.

### Negative / Risks

- The CLI maintains two internal observer adapters and must keep their output
  mapped into one exact child record.
- Observed JSONL wrappers add store-owned public Rust types before the first
  release. They are instrumentation adapters, not a generic multi-store API.
- Platform-specific physical observation tests require the supported
  x86_64 GNU/Linux CI profile; other local targets can prove compilation and
  owner separation but not the store runtime contract.
- Preserving measurement intervals while moving their callback owner requires
  explicit exact-key, ordering, and omission tests.

### Follow-up

- Keep engine differential tests, add JSONL observation tests, and retain CLI
  and benchmark exact-key validation.
- Issue #81 may prepare its committed-prefix work only after this ownership
  transition is merged.
- Return to Issue #88 and a new or superseding ADR before changing child timing
  semantics, stabilizing timing, adding observation I/O to the disabled path,
  or introducing a generic/second-store abstraction.

## Alternatives considered

- **Keep physical stages in `EngineStage`.** Rejected because it preserves the
  ownership leak and makes JSONL changes engine API changes.
- **Pass a store observer through new generic engine journal methods.** Rejected
  because the generic port would still transport store-only instrumentation
  and pathless implementations would retain irrelevant methods.
- **Remove physical timing fields.** Rejected because ownership can move while
  preserving the current provisional benchmark evidence; changing field
  semantics is outside Issue #88.
- **Create a repository-wide generic store-observation abstraction.** Rejected
  because v0.1 has one supported store and no accepted second-store consumer.
- **Split engine, store, and CLI migration across pull requests.** Rejected
  because intermediate states require dual ownership, missing timing, or a
  compatibility path with no current consumer.
