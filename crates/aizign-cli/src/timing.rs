//! Opt-in, metadata-only timing for one `handle` invocation.

use std::io::Write as _;
use std::time::{Duration, Instant};

use aizign_engine::{EngineObserver, EngineStage};
use aizign_store_jsonl::{StoreObservation, StoreObserver, StoreStage};
use serde_json::{Map, Value};

pub(crate) const TIMING_ENV: &str = "AIZIGN_TIMING_JSON";

pub(crate) fn enabled() -> bool {
    std::env::var(TIMING_ENV).as_deref() == Ok("1")
}

#[derive(Default)]
pub(crate) struct HandlerTiming {
    pub(crate) request_read_ms: Option<f64>,
    pub(crate) decode_ms: Option<f64>,
    pub(crate) engine: EngineTiming,
    pub(crate) store: StoreTiming,
    pub(crate) response_encode_ms: Option<f64>,
    pub(crate) response_write_ms: Option<f64>,
    pub(crate) handler_total_ms: Option<f64>,
    pub(crate) outcome: Option<&'static str>,
    pub(crate) error_code: Option<String>,
    pub(crate) operation_kind: Option<&'static str>,
}

#[derive(Default)]
pub(crate) struct EngineTiming {
    journal_entries: Option<usize>,
    journal_load_decode_ms: Option<f64>,
    replay_ms: Option<f64>,
    decide_us: Option<f64>,
    append_sync_ms: Option<f64>,
}

#[derive(Default)]
pub(crate) struct StoreTiming {
    journal_open_ms: Option<f64>,
    journal_physical_bytes: Option<u64>,
    committed_prefix_read_ms: Option<f64>,
    committed_prefix_hash_ms: Option<f64>,
    committed_prefix_decode_ms: Option<f64>,
    publish_prefix_hash_ms: Option<f64>,
}

impl HandlerTiming {
    pub(crate) fn emit(&self) {
        let metric = self.metric();
        if let Ok(encoded) = serde_json::to_string(&metric) {
            let mut stderr = std::io::stderr().lock();
            let _ = writeln!(stderr, "aizign_timing:{encoded}");
        }
    }

    fn metric(&self) -> Map<String, Value> {
        let mut metric = Map::new();
        metric.insert("schema_version".to_owned(), Value::from(1));
        insert_f64(&mut metric, "request_read_ms", self.request_read_ms);
        insert_f64(&mut metric, "decode_ms", self.decode_ms);
        insert_f64(&mut metric, "journal_open_ms", self.store.journal_open_ms);
        insert_u64(
            &mut metric,
            "journal_physical_bytes",
            self.store.journal_physical_bytes,
        );
        if let Some(entries) = self
            .engine
            .journal_entries
            .and_then(|value| u64::try_from(value).ok())
        {
            metric.insert("journal_entries".to_owned(), Value::from(entries));
        }
        insert_f64(
            &mut metric,
            "journal_load_decode_ms",
            self.engine.journal_load_decode_ms,
        );
        insert_f64(
            &mut metric,
            "committed_prefix_read_ms",
            self.store.committed_prefix_read_ms,
        );
        insert_f64(
            &mut metric,
            "committed_prefix_hash_ms",
            self.store.committed_prefix_hash_ms,
        );
        insert_f64(
            &mut metric,
            "committed_prefix_decode_ms",
            self.store.committed_prefix_decode_ms,
        );
        insert_f64(&mut metric, "replay_ms", self.engine.replay_ms);
        insert_f64(&mut metric, "decide_us", self.engine.decide_us);
        insert_f64(&mut metric, "append_sync_ms", self.engine.append_sync_ms);
        insert_f64(
            &mut metric,
            "publish_prefix_hash_ms",
            self.store.publish_prefix_hash_ms,
        );
        insert_f64(&mut metric, "response_encode_ms", self.response_encode_ms);
        insert_f64(&mut metric, "response_write_ms", self.response_write_ms);
        insert_f64(&mut metric, "handler_total_ms", self.handler_total_ms);
        if let Some(outcome) = self.outcome {
            metric.insert("outcome".to_owned(), Value::from(outcome));
        }
        if let Some(code) = &self.error_code {
            metric.insert("error_code".to_owned(), Value::from(code.clone()));
        }
        if let Some(kind) = &self.operation_kind {
            metric.insert("operation_kind".to_owned(), Value::from(*kind));
        }
        metric
    }
}

pub(crate) struct EngineTimingObserver<'a> {
    timing: &'a mut EngineTiming,
    active: Vec<(EngineStage, Instant)>,
}

impl<'a> EngineTimingObserver<'a> {
    pub(crate) fn new(timing: &'a mut EngineTiming) -> Self {
        Self {
            timing,
            active: Vec::new(),
        }
    }
}

impl EngineObserver for EngineTimingObserver<'_> {
    fn stage_started(&mut self, stage: EngineStage) {
        self.active.push((stage, Instant::now()));
    }

    fn stage_finished(&mut self, stage: EngineStage, journal_entries: Option<usize>) {
        let Some((active, started)) = self.active.pop() else {
            return;
        };
        if active != stage {
            return;
        }
        let elapsed = started.elapsed();
        match stage {
            EngineStage::JournalLoadDecode => {
                self.timing.journal_load_decode_ms = Some(milliseconds(elapsed));
                if let Some(entries) = journal_entries {
                    self.timing.journal_entries = Some(entries);
                }
            }
            EngineStage::Replay => self.timing.replay_ms = Some(milliseconds(elapsed)),
            EngineStage::Decide => self.timing.decide_us = Some(microseconds(elapsed)),
            EngineStage::AppendSync => self.timing.append_sync_ms = Some(milliseconds(elapsed)),
        }
    }
}

pub(crate) struct StoreTimingObserver<'a> {
    timing: &'a mut StoreTiming,
    active: Vec<(StoreStage, Instant)>,
}

impl<'a> StoreTimingObserver<'a> {
    pub(crate) fn new(timing: &'a mut StoreTiming) -> Self {
        Self {
            timing,
            active: Vec::new(),
        }
    }
}

impl StoreObserver for StoreTimingObserver<'_> {
    fn observe(&mut self, observation: StoreObservation) {
        match observation {
            StoreObservation::StageStarted(stage) => {
                self.active.push((stage, Instant::now()));
            }
            StoreObservation::StageFinished(stage) => {
                let Some((active, started)) = self.active.pop() else {
                    return;
                };
                if active != stage {
                    return;
                }
                let elapsed = milliseconds(started.elapsed());
                match stage {
                    StoreStage::JournalOpen => self.timing.journal_open_ms = Some(elapsed),
                    StoreStage::CommittedPrefixRead => {
                        self.timing.committed_prefix_read_ms = Some(elapsed);
                    }
                    StoreStage::CommittedPrefixHash => {
                        self.timing.committed_prefix_hash_ms = Some(elapsed);
                    }
                    StoreStage::CommittedPrefixDecode => {
                        self.timing.committed_prefix_decode_ms = Some(elapsed);
                    }
                    StoreStage::PublishPrefixHash => {
                        self.timing.publish_prefix_hash_ms = Some(elapsed);
                    }
                }
            }
            StoreObservation::JournalPhysicalBytes(bytes) => {
                self.timing.journal_physical_bytes = Some(bytes);
            }
        }
    }
}

pub(crate) fn milliseconds(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

fn microseconds(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000_000.0
}

fn insert_f64(metric: &mut Map<String, Value>, name: &str, value: Option<f64>) {
    if let Some(number) = value.and_then(serde_json::Number::from_f64) {
        metric.insert(name.to_owned(), Value::Number(number));
    }
}

fn insert_u64(metric: &mut Map<String, Value>, name: &str, value: Option<u64>) {
    if let Some(value) = value {
        metric.insert(name.to_owned(), Value::from(value));
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use aizign_engine::{EngineObserver as _, EngineStage};
    use aizign_store_jsonl::{StoreObservation, StoreObserver as _, StoreStage};

    use super::{
        EngineTiming, EngineTimingObserver, HandlerTiming, StoreTiming, StoreTimingObserver,
    };

    #[test]
    fn timing_serialization_has_an_exact_metadata_only_key_set() {
        let timing = HandlerTiming {
            request_read_ms: Some(1.0),
            decode_ms: Some(1.0),
            engine: EngineTiming {
                journal_entries: Some(1),
                journal_load_decode_ms: Some(1.0),
                replay_ms: Some(1.0),
                decide_us: Some(1.0),
                append_sync_ms: Some(1.0),
            },
            store: StoreTiming {
                journal_open_ms: Some(1.0),
                journal_physical_bytes: Some(1),
                committed_prefix_read_ms: Some(1.0),
                committed_prefix_hash_ms: Some(1.0),
                committed_prefix_decode_ms: Some(1.0),
                publish_prefix_hash_ms: Some(1.0),
            },
            response_encode_ms: Some(1.0),
            response_write_ms: Some(1.0),
            handler_total_ms: Some(1.0),
            outcome: Some("accepted"),
            error_code: Some("EVENT_CONFLICT".to_owned()),
            operation_kind: Some("workflow.signal.submit"),
        };
        let actual = timing
            .metric()
            .into_iter()
            .map(|(key, _)| key)
            .collect::<BTreeSet<_>>();
        let expected = [
            "append_sync_ms",
            "committed_prefix_decode_ms",
            "committed_prefix_hash_ms",
            "committed_prefix_read_ms",
            "decide_us",
            "decode_ms",
            "error_code",
            "handler_total_ms",
            "journal_entries",
            "journal_load_decode_ms",
            "journal_open_ms",
            "journal_physical_bytes",
            "operation_kind",
            "outcome",
            "publish_prefix_hash_ms",
            "replay_ms",
            "request_read_ms",
            "response_encode_ms",
            "response_write_ms",
            "schema_version",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
        assert_eq!(actual, expected);
    }

    #[test]
    fn nested_store_stages_preserve_their_aggregate() {
        let mut timing = HandlerTiming::default();
        {
            let mut engine_observer = EngineTimingObserver::new(&mut timing.engine);
            let mut store_observer = StoreTimingObserver::new(&mut timing.store);
            engine_observer.stage_started(EngineStage::JournalLoadDecode);
            store_observer.observe(StoreObservation::StageStarted(
                StoreStage::CommittedPrefixRead,
            ));
            store_observer.observe(StoreObservation::StageFinished(
                StoreStage::CommittedPrefixRead,
            ));
            store_observer.observe(StoreObservation::StageStarted(
                StoreStage::CommittedPrefixHash,
            ));
            store_observer.observe(StoreObservation::StageFinished(
                StoreStage::CommittedPrefixHash,
            ));
            store_observer.observe(StoreObservation::StageStarted(
                StoreStage::CommittedPrefixDecode,
            ));
            store_observer.observe(StoreObservation::StageFinished(
                StoreStage::CommittedPrefixDecode,
            ));
            store_observer.observe(StoreObservation::JournalPhysicalBytes(42));
            engine_observer.stage_finished(EngineStage::JournalLoadDecode, Some(10));
        }
        assert!(timing.engine.journal_load_decode_ms.is_some());
        assert!(timing.store.committed_prefix_read_ms.is_some());
        assert!(timing.store.committed_prefix_hash_ms.is_some());
        assert!(timing.store.committed_prefix_decode_ms.is_some());
        assert_eq!(timing.store.journal_physical_bytes, Some(42));
        assert_eq!(timing.engine.journal_entries, Some(10));
    }
}
