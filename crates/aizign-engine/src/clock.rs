//! The clock port: the only way time enters the engine.

use core::fmt;

use aizign_core::BoundedTimestamp;

/// Why the shell could not supply a timestamp.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClockError {
    /// The system time is outside the bounded range the core accepts.
    OutOfRange,
}

impl fmt::Display for ClockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::OutOfRange => f.write_str("system time is outside the bounded range"),
        }
    }
}

impl core::error::Error for ClockError {}

/// Supplies the current time as a bounded timestamp. The engine never reads
/// a clock itself; the composition root implements this with the system
/// clock and tests with a fixed value.
pub trait Clock {
    /// The current time.
    fn now(&self) -> Result<BoundedTimestamp, ClockError>;
}
