//! A [`Clock`] that returns a fixed, in-range timestamp.

use aizign_core::BoundedTimestamp;
use aizign_engine::{Clock, ClockError};

/// Returns the same timestamp every time, or a configured failure.
#[derive(Clone, Debug)]
pub struct FixedClock {
    now: Result<BoundedTimestamp, ClockError>,
}

impl FixedClock {
    /// A clock stuck at `now`.
    #[must_use]
    pub fn at(now: BoundedTimestamp) -> Self {
        Self { now: Ok(now) }
    }

    /// A clock that fails with `error`.
    #[must_use]
    pub fn failing(error: ClockError) -> Self {
        Self { now: Err(error) }
    }
}

impl Default for FixedClock {
    fn default() -> Self {
        Self::at(crate::signals::at(0))
    }
}

impl Clock for FixedClock {
    fn now(&self) -> Result<BoundedTimestamp, ClockError> {
        self.now.clone()
    }
}
