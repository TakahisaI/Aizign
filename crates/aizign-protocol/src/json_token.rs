//! Version-independent JSON token checks that run before typed deserialization.

use std::collections::{HashMap, HashSet};

const MAX_SCAN_DEPTH: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FailureKind {
    DuplicateMember,
    InvalidUnicode,
    NoncanonicalNumber,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Failure {
    pub(crate) kind: FailureKind,
    pub(crate) index: usize,
    pub(crate) in_payload: bool,
    pub(crate) message: &'static str,
}

#[derive(Clone, Debug)]
pub(crate) struct Scan {
    pub(crate) failure: Option<Failure>,
    pub(crate) probe_text: String,
    pub(crate) top_level_numbers: HashMap<String, String>,
}

enum Level {
    Object {
        keys: HashSet<String>,
        in_payload: bool,
        pending_key: Option<String>,
    },
    Array {
        in_payload: bool,
    },
}

impl Level {
    const fn in_payload(&self) -> bool {
        match self {
            Self::Object { in_payload, .. } | Self::Array { in_payload } => *in_payload,
        }
    }
}

fn is_whitespace(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r')
}

fn end_of_string(bytes: &[u8], start: usize) -> Option<usize> {
    let mut index = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b'"' => return Some(index + 1),
            _ => index += 1,
        }
    }
    None
}

fn next_non_whitespace(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && is_whitespace(bytes[index]) {
        index += 1;
    }
    index
}

fn value_is_payload(levels: &[Level]) -> bool {
    let Some(parent) = levels.last() else {
        return false;
    };
    if parent.in_payload() {
        return true;
    }
    matches!(
        parent,
        Level::Object {
            pending_key: Some(key),
            ..
        } if levels.len() == 1 && key == "payload"
    )
}

fn consume_pending_key(levels: &mut [Level]) {
    if let Some(Level::Object { pending_key, .. }) = levels.last_mut() {
        *pending_key = None;
    }
}

fn number_end(bytes: &[u8], start: usize) -> usize {
    let mut index = start;
    while index < bytes.len()
        && !is_whitespace(bytes[index])
        && !matches!(bytes[index], b',' | b']' | b'}' | b':')
    {
        index += 1;
    }
    index
}

fn is_canonical_integer(token: &str) -> bool {
    if token == "0" {
        return true;
    }
    let digits = token.strip_prefix('-').unwrap_or(token);
    !digits.is_empty()
        && !digits.starts_with('0')
        && digits.bytes().all(|byte| byte.is_ascii_digit())
}

fn record_failure(current: &mut Option<Failure>, candidate: Failure) {
    if current
        .as_ref()
        .is_none_or(|existing| candidate.index < existing.index)
    {
        *current = Some(candidate);
    }
}

/// Scans strings, members, and raw number tokens without numeric coercion.
// This single pass deliberately keeps duplicate, Unicode, and number findings
// in source order; splitting it by finding type would create competing scans.
#[allow(clippy::too_many_lines)]
pub(crate) fn scan_json_tokens(text: &str) -> Scan {
    let bytes = text.as_bytes();
    let mut levels = Vec::new();
    let mut replacements: Vec<(usize, usize, &'static str)> = Vec::new();
    let mut top_level_numbers = HashMap::new();
    let mut failure = None;
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                let Some(end) = end_of_string(bytes, index) else {
                    break;
                };
                let decoded = serde_json::from_str::<String>(&text[index..end]);
                if decoded.is_err() {
                    record_failure(
                        &mut failure,
                        Failure {
                            kind: FailureKind::InvalidUnicode,
                            index,
                            in_payload: value_is_payload(&levels),
                            message: "JSON member names and string values must be well-formed Unicode",
                        },
                    );
                    replacements.push((index, end, "\"\""));
                }
                let after = next_non_whitespace(bytes, end);
                if bytes.get(after) == Some(&b':') {
                    let is_root = levels.len() == 1;
                    if let (
                        Some(name),
                        Some(Level::Object {
                            keys,
                            in_payload,
                            pending_key,
                        }),
                    ) = (decoded.ok(), levels.last_mut())
                    {
                        if !keys.insert(name.clone()) {
                            record_failure(
                                &mut failure,
                                Failure {
                                    kind: FailureKind::DuplicateMember,
                                    index,
                                    in_payload: *in_payload || (is_root && name == "payload"),
                                    message: "frame repeats a JSON member; repeated members are not part of the contract",
                                },
                            );
                        }
                        *pending_key = Some(name);
                    }
                } else {
                    consume_pending_key(&mut levels);
                }
                index = end;
            }
            b'{' | b'[' => {
                let in_payload = value_is_payload(&levels);
                consume_pending_key(&mut levels);
                if levels.len() < MAX_SCAN_DEPTH {
                    levels.push(if bytes[index] == b'{' {
                        Level::Object {
                            keys: HashSet::new(),
                            in_payload,
                            pending_key: None,
                        }
                    } else {
                        Level::Array { in_payload }
                    });
                }
                index += 1;
            }
            b'}' | b']' => {
                levels.pop();
                index += 1;
            }
            b'-' | b'0'..=b'9' => {
                let end = number_end(bytes, index);
                let token = &text[index..end];
                let top_level_key = match levels.last() {
                    Some(Level::Object { pending_key, .. }) if levels.len() == 1 => {
                        pending_key.clone()
                    }
                    _ => None,
                };
                if let Some(key) = top_level_key {
                    top_level_numbers.insert(key, token.to_owned());
                }
                let in_payload = value_is_payload(&levels);
                if !is_canonical_integer(token) {
                    record_failure(
                        &mut failure,
                        Failure {
                            kind: FailureKind::NoncanonicalNumber,
                            index,
                            in_payload,
                            message: "Protocol numbers must use canonical integer spelling",
                        },
                    );
                }
                replacements.push((index, end, "0"));
                consume_pending_key(&mut levels);
                index = end;
            }
            b't' | b'f' | b'n' => {
                consume_pending_key(&mut levels);
                index += 1;
            }
            _ => index += 1,
        }
    }

    let mut probe_text = String::with_capacity(text.len());
    let mut copied = 0;
    for (start, end, replacement) in replacements {
        probe_text.push_str(&text[copied..start]);
        probe_text.push_str(replacement);
        copied = end;
    }
    probe_text.push_str(&text[copied..]);
    Scan {
        failure,
        probe_text,
        top_level_numbers,
    }
}

#[cfg(test)]
mod tests {
    use super::{FailureKind, scan_json_tokens};

    #[test]
    fn scans_duplicates_unicode_and_numbers_in_source_order() {
        assert_eq!(
            scan_json_tokens(r#"{"a":1,"a":2,"b":1e0}"#)
                .failure
                .unwrap()
                .kind,
            FailureKind::DuplicateMember
        );
        assert_eq!(
            scan_json_tokens(r#"{"a":1e0,"a":2}"#).failure.unwrap().kind,
            FailureKind::NoncanonicalNumber
        );
        assert!(
            scan_json_tokens(r#"{"payload":{"n":1e400}}"#)
                .failure
                .unwrap()
                .in_payload
        );
    }

    #[test]
    fn makes_a_lossless_probe_view() {
        let scan = scan_json_tokens(
            r#"{"version":2,"requestId":"req-1","kind":"workflow.future","payload":{"n":999999999999999999999999}}"#,
        );
        assert_eq!(scan.top_level_numbers["version"], "2");
        assert_eq!(
            scan.probe_text,
            r#"{"version":0,"requestId":"req-1","kind":"workflow.future","payload":{"n":0}}"#
        );
    }
}
