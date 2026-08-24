//! Opt-in, metadata-only timing for one `handle` invocation.

use std::io::Write as _;
use std::time::{Duration, Instant};

use aizign_engine::{EngineObserver, EngineStage};
use serde_json::{Map, Value};

pub(crate) const TIMING_ENV: &str = "AIZIGN_TIMING_JSON";

pub(crate) fn enabled() -> bool {
    std::env::var(TIMING_ENV).as_deref() == Ok("1")
}

#[derive(Default)]
pub(crate) struct HandlerTiming {
    pub(crate) request_read_ms: Option<f64>,
    pub(crate) decode_ms: Option<f64>,
    pub(crate) journal_open_ms: Option<f64>,
    pub(crate) journal_physical_bytes: Option<u64>,
    pub(crate) journal_entries: Option<usize>,
    pub(crate) journal_load_decode_ms: Option<f64>,
    pub(crate) committed_prefix_read_ms: Option<f64>,
    pub(crate) committed_prefix_hash_ms: Option<f64>,
    pub(crate) committed_prefix_decode_ms: Option<f64>,
    pub(crate) replay_ms: Option<f64>,
    pub(crate) decide_us: Option<f64>,
    pub(crate) append_sync_ms: Option<f64>,
    pub(crate) publish_prefix_hash_ms: Option<f64>,
    pub(crate) response_encode_ms: Option<f64>,
    pub(crate) response_write_ms: Option<f64>,
    pub(crate) handler_total_ms: Option<f64>,
    pub(crate) outcome: Option<&'static str>,
    pub(crate) error_code: Option<String>,
    pub(crate) operation_kind: Option<&'static str>,
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
        insert_f64(&mut metric, "journal_open_ms", self.journal_open_ms);
        insert_u64(
            &mut metric,
            "journal_physical_bytes",
            self.journal_physical_bytes,
        );
        if let Some(entries) = self
            .journal_entries
            .and_then(|value| u64::try_from(value).ok())
        {
            metric.insert("journal_entries".to_owned(), Value::from(entries));
        }
        insert_f64(
            &mut metric,
            "journal_load_decode_ms",
            self.journal_load_decode_ms,
        );
        insert_f64(
            &mut metric,
            "committed_prefix_read_ms",
            self.committed_prefix_read_ms,
        );
        insert_f64(
            &mut metric,
            "committed_prefix_hash_ms",
            self.committed_prefix_hash_ms,
        );
        insert_f64(
            &mut metric,
            "committed_prefix_decode_ms",
            self.committed_prefix_decode_ms,
        );
        insert_f64(&mut metric, "replay_ms", self.replay_ms);
        insert_f64(&mut metric, "decide_us", self.decide_us);
        insert_f64(&mut metric, "append_sync_ms", self.append_sync_ms);
        insert_f64(
            &mut metric,
            "publish_prefix_hash_ms",
            self.publish_prefix_hash_ms,
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

pub(crate) struct StageTimingObserver<'a> {
    timing: &'a mut HandlerTiming,
    active: Vec<(EngineStage, Instant)>,
}

impl<'a> StageTimingObserver<'a> {
    pub(crate) fn new(timing: &'a mut HandlerTiming) -> Self {
        Self {
            timing,
            active: Vec::new(),
        }
    }
}

impl EngineObserver for StageTimingObserver<'_> {
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
            EngineStage::CommittedPrefixRead => {
                self.timing.committed_prefix_read_ms = Some(milliseconds(elapsed));
            }
            EngineStage::CommittedPrefixHash => {
                self.timing.committed_prefix_hash_ms = Some(milliseconds(elapsed));
            }
            EngineStage::CommittedPrefixDecode => {
                self.timing.committed_prefix_decode_ms = Some(milliseconds(elapsed));
            }
            EngineStage::Replay => self.timing.replay_ms = Some(milliseconds(elapsed)),
            EngineStage::Decide => self.timing.decide_us = Some(microseconds(elapsed)),
            EngineStage::AppendSync => self.timing.append_sync_ms = Some(milliseconds(elapsed)),
            EngineStage::PublishPrefixHash => {
                self.timing.publish_prefix_hash_ms = Some(milliseconds(elapsed));
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

    use super::{HandlerTiming, StageTimingObserver};

    #[test]
    fn timing_serialization_has_an_exact_metadata_only_key_set() {
        let timing = HandlerTiming {
            request_read_ms: Some(1.0),
            decode_ms: Some(1.0),
            journal_open_ms: Some(1.0),
            journal_physical_bytes: Some(1),
            journal_entries: Some(1),
            journal_load_decode_ms: Some(1.0),
            committed_prefix_read_ms: Some(1.0),
            committed_prefix_hash_ms: Some(1.0),
            committed_prefix_decode_ms: Some(1.0),
            replay_ms: Some(1.0),
            decide_us: Some(1.0),
            append_sync_ms: Some(1.0),
            publish_prefix_hash_ms: Some(1.0),
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
            let mut observer = StageTimingObserver::new(&mut timing);
            observer.stage_started(EngineStage::JournalLoadDecode);
            observer.stage_started(EngineStage::CommittedPrefixRead);
            observer.stage_finished(EngineStage::CommittedPrefixRead, None);
            observer.stage_started(EngineStage::CommittedPrefixHash);
            observer.stage_finished(EngineStage::CommittedPrefixHash, None);
            observer.stage_started(EngineStage::CommittedPrefixDecode);
            observer.stage_finished(EngineStage::CommittedPrefixDecode, None);
            observer.stage_finished(EngineStage::JournalLoadDecode, Some(10));
        }
        assert!(timing.journal_load_decode_ms.is_some());
        assert!(timing.committed_prefix_read_ms.is_some());
        assert!(timing.committed_prefix_hash_ms.is_some());
        assert!(timing.committed_prefix_decode_ms.is_some());
        assert_eq!(timing.journal_entries, Some(10));
    }
}
