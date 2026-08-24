//! The behaviour every [`Journal`] implementation must share. Real stores
//! call [`run`] from their own tests with a fresh, empty journal.

use aizign_core::workflow::WorkflowEvent;
use aizign_engine::Journal;

use crate::signals;

/// Exercises append order, sequence numbering, and read-after-append on an
/// empty journal. Panics with a descriptive message on the first violation.
pub fn run<J: Journal>(journal: &mut J) {
    assert!(
        journal.load().expect("empty journal loads").is_empty(),
        "fresh journal must be empty"
    );

    let first = WorkflowEvent::SignalAccepted {
        signal: signals::implementation_ready("evt-1"),
    };
    let second = WorkflowEvent::SignalAccepted {
        signal: signals::blocked("evt-2", "CONTRACT"),
    };

    let entry = journal
        .append(&first, signals::at(0))
        .expect("first append");
    assert_eq!(entry.seq, 1, "sequence numbers start at 1");
    assert_eq!(entry.event, first);
    assert_eq!(entry.at, signals::at(0));

    let entry = journal
        .append(&second, signals::at(5))
        .expect("second append");
    assert_eq!(entry.seq, 2, "sequence numbers are contiguous");

    let loaded = journal.load().expect("load after appends");
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[0].seq, 1);
    assert_eq!(loaded[0].event, first);
    assert_eq!(loaded[1].seq, 2);
    assert_eq!(loaded[1].event, second);
    assert_eq!(loaded[1].at, signals::at(5));

    let entry = journal
        .append(&first, signals::at(9))
        .expect("journals do not deduplicate");
    assert_eq!(
        entry.seq, 3,
        "the journal records what it is told; deduplication is the core's job"
    );
}

#[cfg(test)]
mod tests {
    use super::run;
    use crate::MemoryJournal;

    #[test]
    fn memory_journal_satisfies_the_contract() {
        run(&mut MemoryJournal::new());
    }
}
