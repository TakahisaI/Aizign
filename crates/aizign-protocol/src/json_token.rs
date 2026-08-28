//! Version-independent JSON token checks that run before typed deserialization.

use std::collections::{HashMap, HashSet};

const TYPED_JSON_DEPTH_LIMIT: usize = 128;

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
    pub(crate) syntax_error: Option<&'static str>,
    pub(crate) failure: Option<Failure>,
    pub(crate) typed_text: String,
    pub(crate) top_level_object: bool,
    pub(crate) top_level_strings: HashMap<String, String>,
    pub(crate) top_level_booleans: HashMap<String, bool>,
    pub(crate) error_code: Option<String>,
    pub(crate) top_level_numbers: HashMap<String, String>,
    pub(crate) payload_integer_out_of_range: bool,
    pub(crate) payload_exceeds_typed_depth: bool,
}

enum Level {
    Object {
        keys: HashSet<String>,
        in_payload: bool,
        in_error: bool,
        pending_key: Option<String>,
    },
    Array {
        in_payload: bool,
        in_error: bool,
    },
}

impl Level {
    const fn in_payload(&self) -> bool {
        match self {
            Self::Object { in_payload, .. } | Self::Array { in_payload, .. } => *in_payload,
        }
    }

    const fn in_error(&self) -> bool {
        match self {
            Self::Object { in_error, .. } | Self::Array { in_error, .. } => *in_error,
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

fn value_is_error(levels: &[Level]) -> bool {
    let Some(parent) = levels.last() else {
        return false;
    };
    if parent.in_error() {
        return true;
    }
    matches!(
        parent,
        Level::Object {
            pending_key: Some(key),
            ..
        } if levels.len() == 1 && key == "error"
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

fn is_json_number(token: &str) -> bool {
    let bytes = token.as_bytes();
    let mut index = 0;
    if bytes.get(index) == Some(&b'-') {
        index += 1;
    }
    match bytes.get(index) {
        Some(b'0') => index += 1,
        Some(b'1'..=b'9') => {
            index += 1;
            while bytes.get(index).is_some_and(u8::is_ascii_digit) {
                index += 1;
            }
        }
        _ => return false,
    }
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start {
            return false;
        }
    }
    if matches!(bytes.get(index), Some(b'e' | b'E')) {
        index += 1;
        if matches!(bytes.get(index), Some(b'+' | b'-')) {
            index += 1;
        }
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start {
            return false;
        }
    }
    index == bytes.len()
}

fn hex4(bytes: &[u8], start: usize) -> Option<u16> {
    let end = start.checked_add(4)?;
    let digits = bytes.get(start..end)?;
    digits.iter().try_fold(0_u16, |value, byte| {
        let digit = match byte {
            b'0'..=b'9' => u16::from(byte - b'0'),
            b'a'..=b'f' => u16::from(byte - b'a' + 10),
            b'A'..=b'F' => u16::from(byte - b'A' + 10),
            _ => return None,
        };
        Some(value * 16 + digit)
    })
}

/// Returns `(valid JSON string grammar, Unicode scalar sequence)`.
fn string_token_state(bytes: &[u8], start: usize, end: usize) -> (bool, bool) {
    let content_end = end - 1;
    let mut index = start + 1;
    let mut unicode_valid = true;
    while index < content_end {
        match bytes[index] {
            0x00..=0x1f => return (false, unicode_valid),
            b'\\' => {
                index += 1;
                let Some(escape) = bytes.get(index) else {
                    return (false, unicode_valid);
                };
                match escape {
                    b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => index += 1,
                    b'u' => {
                        let Some(unit) = hex4(bytes, index + 1) else {
                            return (false, unicode_valid);
                        };
                        index += 5;
                        if (0xd800..=0xdbff).contains(&unit) {
                            if bytes.get(index..index + 2) == Some(b"\\u") {
                                let Some(low) = hex4(bytes, index + 2) else {
                                    return (false, unicode_valid);
                                };
                                if (0xdc00..=0xdfff).contains(&low) {
                                    index += 6;
                                } else {
                                    unicode_valid = false;
                                }
                            } else {
                                unicode_valid = false;
                            }
                        } else if (0xdc00..=0xdfff).contains(&unit) {
                            unicode_valid = false;
                        }
                    }
                    _ => return (false, unicode_valid),
                }
            }
            _ => index += 1,
        }
    }
    (true, unicode_valid)
}

#[derive(Clone, Copy)]
enum ObjectState {
    KeyOrEnd,
    Key,
    Colon,
    Value,
    CommaOrEnd,
}

#[derive(Clone, Copy)]
enum ArrayState {
    ValueOrEnd,
    Value,
    CommaOrEnd,
}

enum GrammarLevel {
    Object(ObjectState),
    Array(ArrayState),
}

fn consume_json_value(
    bytes: &[u8],
    index: &mut usize,
    levels: &mut Vec<GrammarLevel>,
) -> Result<(), &'static str> {
    match bytes.get(*index).copied() {
        Some(b'{') => {
            levels.push(GrammarLevel::Object(ObjectState::KeyOrEnd));
            *index += 1;
        }
        Some(b'[') => {
            levels.push(GrammarLevel::Array(ArrayState::ValueOrEnd));
            *index += 1;
        }
        Some(b'"') => {
            let end =
                end_of_string(bytes, *index).ok_or("frame contains an unterminated JSON string")?;
            if !string_token_state(bytes, *index, end).0 {
                return Err("frame contains an invalid JSON string token");
            }
            *index = end;
        }
        Some(b't') if bytes.get(*index..*index + 4) == Some(b"true") => *index += 4,
        Some(b'f') if bytes.get(*index..*index + 5) == Some(b"false") => *index += 5,
        Some(b'n') if bytes.get(*index..*index + 4) == Some(b"null") => *index += 4,
        Some(b'-' | b'0'..=b'9') => {
            let end = number_end(bytes, *index);
            let token = std::str::from_utf8(&bytes[*index..end])
                .map_err(|_| "frame contains an invalid JSON number token")?;
            if !is_json_number(token) {
                return Err("frame contains an invalid JSON number token");
            }
            *index = end;
        }
        _ => return Err("frame contains an invalid JSON value"),
    }
    Ok(())
}

/// Validates the complete JSON grammar without recursion or a depth cutoff.
#[allow(clippy::too_many_lines)]
fn validate_json_grammar(bytes: &[u8]) -> Result<(), &'static str> {
    let mut levels = Vec::new();
    let mut index = 0;
    while index < bytes.len() && is_whitespace(bytes[index]) {
        index += 1;
    }
    if index == bytes.len() {
        return Err("frame must contain one JSON value");
    }
    consume_json_value(bytes, &mut index, &mut levels)?;
    loop {
        while index < bytes.len() && is_whitespace(bytes[index]) {
            index += 1;
        }
        let Some(level) = levels.last_mut() else {
            return if index == bytes.len() {
                Ok(())
            } else {
                Err("frame contains bytes after its JSON value")
            };
        };
        match level {
            GrammarLevel::Object(ObjectState::KeyOrEnd) => match bytes.get(index) {
                Some(b'}') => {
                    levels.pop();
                    index += 1;
                }
                Some(b'"') => {
                    let end = end_of_string(bytes, index)
                        .ok_or("frame contains an unterminated JSON string")?;
                    if !string_token_state(bytes, index, end).0 {
                        return Err("frame contains an invalid JSON string token");
                    }
                    *levels.last_mut().expect("level remains") =
                        GrammarLevel::Object(ObjectState::Colon);
                    index = end;
                }
                _ => return Err("JSON object member name must be a string"),
            },
            GrammarLevel::Object(ObjectState::Key) => {
                if bytes.get(index) != Some(&b'"') {
                    return Err("JSON object member name must follow a comma");
                }
                let end = end_of_string(bytes, index)
                    .ok_or("frame contains an unterminated JSON string")?;
                if !string_token_state(bytes, index, end).0 {
                    return Err("frame contains an invalid JSON string token");
                }
                *levels.last_mut().expect("level remains") =
                    GrammarLevel::Object(ObjectState::Colon);
                index = end;
            }
            GrammarLevel::Object(ObjectState::Colon) => {
                if bytes.get(index) != Some(&b':') {
                    return Err("JSON object member name must be followed by a colon");
                }
                *levels.last_mut().expect("level remains") =
                    GrammarLevel::Object(ObjectState::Value);
                index += 1;
            }
            GrammarLevel::Object(ObjectState::Value) => {
                *levels.last_mut().expect("level remains") =
                    GrammarLevel::Object(ObjectState::CommaOrEnd);
                consume_json_value(bytes, &mut index, &mut levels)?;
            }
            GrammarLevel::Object(ObjectState::CommaOrEnd) => match bytes.get(index) {
                Some(b',') => {
                    *levels.last_mut().expect("level remains") =
                        GrammarLevel::Object(ObjectState::Key);
                    index += 1;
                }
                Some(b'}') => {
                    levels.pop();
                    index += 1;
                }
                _ => return Err("JSON object value must be followed by a comma or closing brace"),
            },
            GrammarLevel::Array(ArrayState::ValueOrEnd) => {
                if bytes.get(index) == Some(&b']') {
                    levels.pop();
                    index += 1;
                } else {
                    *levels.last_mut().expect("level remains") =
                        GrammarLevel::Array(ArrayState::CommaOrEnd);
                    consume_json_value(bytes, &mut index, &mut levels)?;
                }
            }
            GrammarLevel::Array(ArrayState::Value) => {
                *levels.last_mut().expect("level remains") =
                    GrammarLevel::Array(ArrayState::CommaOrEnd);
                consume_json_value(bytes, &mut index, &mut levels)?;
            }
            GrammarLevel::Array(ArrayState::CommaOrEnd) => match bytes.get(index) {
                Some(b',') => {
                    *levels.last_mut().expect("level remains") =
                        GrammarLevel::Array(ArrayState::Value);
                    index += 1;
                }
                Some(b']') => {
                    levels.pop();
                    index += 1;
                }
                _ => return Err("JSON array value must be followed by a comma or closing bracket"),
            },
        }
    }
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
    if let Err(message) = validate_json_grammar(bytes) {
        return Scan {
            syntax_error: Some(message),
            failure: None,
            typed_text: text.to_owned(),
            top_level_object: false,
            top_level_strings: HashMap::new(),
            top_level_booleans: HashMap::new(),
            error_code: None,
            top_level_numbers: HashMap::new(),
            payload_integer_out_of_range: false,
            payload_exceeds_typed_depth: false,
        };
    }
    let mut levels = Vec::new();
    let mut typed_replacements: Vec<(usize, usize, &'static str)> = Vec::new();
    let mut top_level_numbers = HashMap::new();
    let mut top_level_strings = HashMap::new();
    let mut top_level_booleans = HashMap::new();
    let mut error_code = None;
    let mut syntax_error = None;
    let mut failure = None;
    let mut payload_integer_out_of_range = false;
    let mut payload_exceeds_typed_depth = false;
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                let Some(end) = end_of_string(bytes, index) else {
                    syntax_error.get_or_insert("frame contains an unterminated JSON string");
                    break;
                };
                let (syntax_valid, unicode_valid) = string_token_state(bytes, index, end);
                if !syntax_valid {
                    syntax_error.get_or_insert("frame contains an invalid JSON string token");
                    index = end;
                    continue;
                }
                let decoded = serde_json::from_str::<String>(&text[index..end]);
                let after = next_non_whitespace(bytes, end);
                let is_member_name = bytes.get(after) == Some(&b':');
                if !unicode_valid {
                    record_failure(
                        &mut failure,
                        Failure {
                            kind: FailureKind::InvalidUnicode,
                            index,
                            in_payload: value_is_payload(&levels),
                            message: "JSON member names and string values must be well-formed Unicode",
                        },
                    );
                } else if decoded.is_err() {
                    syntax_error.get_or_insert("frame contains an invalid JSON string token");
                    index = end;
                    continue;
                }
                if is_member_name {
                    let is_root = levels.len() == 1;
                    if let (
                        Some(name),
                        Some(Level::Object {
                            keys,
                            in_payload,
                            pending_key,
                            ..
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
                    if unicode_valid
                        && let Ok(value) = decoded
                        && let Some(Level::Object {
                            in_error,
                            pending_key: Some(key),
                            ..
                        }) = levels.last()
                    {
                        if levels.len() == 1 {
                            top_level_strings.insert(key.clone(), value.clone());
                        }
                        if *in_error && key == "code" {
                            error_code = Some(value);
                        }
                    }
                    consume_pending_key(&mut levels);
                }
                index = end;
            }
            b'{' | b'[' => {
                let in_payload = value_is_payload(&levels);
                let in_error = value_is_error(&levels);
                if in_payload && levels.len() >= TYPED_JSON_DEPTH_LIMIT {
                    payload_exceeds_typed_depth = true;
                }
                consume_pending_key(&mut levels);
                levels.push(if bytes[index] == b'{' {
                    Level::Object {
                        keys: HashSet::new(),
                        in_payload,
                        in_error,
                        pending_key: None,
                    }
                } else {
                    Level::Array {
                        in_payload,
                        in_error,
                    }
                });
                index += 1;
            }
            b'}' | b']' => {
                levels.pop();
                index += 1;
            }
            b'-' | b'0'..=b'9' => {
                let end = number_end(bytes, index);
                let token = &text[index..end];
                if !is_json_number(token) {
                    syntax_error.get_or_insert("frame contains an invalid JSON number token");
                    index = end;
                    continue;
                }
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
                } else if in_payload && token.parse::<u32>().is_err() {
                    payload_integer_out_of_range = true;
                    typed_replacements.push((index, end, "0"));
                }
                consume_pending_key(&mut levels);
                index = end;
            }
            b't' | b'f' | b'n' => {
                let top_level_key = match levels.last() {
                    Some(Level::Object { pending_key, .. }) if levels.len() == 1 => {
                        pending_key.clone()
                    }
                    _ => None,
                };
                if let Some(key) = top_level_key {
                    if bytes.get(index..index + 4) == Some(b"true") {
                        top_level_booleans.insert(key, true);
                    } else if bytes.get(index..index + 5) == Some(b"false") {
                        top_level_booleans.insert(key, false);
                    }
                }
                consume_pending_key(&mut levels);
                index += 1;
            }
            _ => index += 1,
        }
    }

    let apply_replacements = |replacements: Vec<(usize, usize, &'static str)>| {
        let mut result = String::with_capacity(text.len());
        let mut copied = 0;
        for (start, end, replacement) in replacements {
            result.push_str(&text[copied..start]);
            result.push_str(replacement);
            copied = end;
        }
        result.push_str(&text[copied..]);
        result
    };
    let typed_text = apply_replacements(typed_replacements);
    Scan {
        syntax_error,
        failure,
        typed_text,
        top_level_object: text.trim_start().starts_with('{'),
        top_level_strings,
        top_level_booleans,
        error_code,
        top_level_numbers,
        payload_integer_out_of_range,
        payload_exceeds_typed_depth,
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
    fn separates_json_grammar_errors_from_semantic_token_findings() {
        for token in ["1e", "1.", "01", "-"] {
            let scan = scan_json_tokens(&format!(r#"{{"value":{token}}}"#));
            assert!(scan.syntax_error.is_some(), "{token}");
            assert!(scan.failure.is_none(), "{token}");
        }
        for frame in [r#"{"value":"\q"}"#, r#"{"value":"\u12"}"#] {
            let scan = scan_json_tokens(frame);
            assert!(scan.syntax_error.is_some(), "{frame}");
            assert!(scan.failure.is_none(), "{frame}");
        }
    }

    #[test]
    fn makes_a_lossless_probe_view() {
        let scan = scan_json_tokens(
            r#"{"version":2,"requestId":"req-1","kind":"workflow.future","payload":{"n":999999999999999999999999}}"#,
        );
        assert_eq!(scan.top_level_numbers["version"], "2");
        assert!(scan.syntax_error.is_none());
        assert_eq!(
            scan.typed_text,
            r#"{"version":2,"requestId":"req-1","kind":"workflow.future","payload":{"n":0}}"#
        );
        assert!(scan.payload_integer_out_of_range);
    }
}
