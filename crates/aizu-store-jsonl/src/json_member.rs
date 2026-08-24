//! JSON object-member checks that must run before typed deserialization.

use std::collections::HashSet;
use std::fmt;

use serde::de::{DeserializeSeed, Error as _, MapAccess, SeqAccess, Visitor};

const DUPLICATE_MEMBER_MARKER: &str = "duplicate JSON member";

#[derive(Clone, Copy)]
struct ValueWithoutDuplicates;

impl<'de> DeserializeSeed<'de> for ValueWithoutDuplicates {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for ValueWithoutDuplicates {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value without duplicate object members")
    }

    fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_string<E>(self, _value: String) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(())
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        while sequence.next_element_seed(Self)?.is_some() {}
        Ok(())
    }

    fn visit_map<A>(self, mut object: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut seen = HashSet::new();
        while let Some(name) = object.next_key::<String>()? {
            if !seen.insert(name) {
                return Err(A::Error::custom(DUPLICATE_MEMBER_MARKER));
            }
            object.next_value_seed(Self)?;
        }
        Ok(())
    }
}

/// Whether valid JSON syntax encountered so far contains a repeated decoded
/// member name at any object depth. Other syntax errors remain the record
/// decoder's responsibility.
pub(crate) fn has_duplicate_members(line: &str) -> bool {
    let mut deserializer = serde_json::Deserializer::from_str(line);
    ValueWithoutDuplicates
        .deserialize(&mut deserializer)
        .and_then(|()| deserializer.end())
        .is_err_and(|error| error.to_string().starts_with(DUPLICATE_MEMBER_MARKER))
}

#[cfg(test)]
mod tests {
    use super::has_duplicate_members;

    #[test]
    fn finds_decoded_names_at_every_depth() {
        assert!(has_duplicate_members(r#"{"a":1,"a":2}"#));
        assert!(has_duplicate_members(r#"{"a":1,"\u0061":2}"#));
        assert!(has_duplicate_members(r#"[{"a":1,"a":2}]"#));
        assert!(has_duplicate_members(r#"{"outer":{"a":1,"a":2}}"#));
        assert!(!has_duplicate_members(r#"{"a":1,"b":{"a":2}}"#));
    }
}
