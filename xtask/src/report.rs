//! Minimal progress and finding output shared by every xtask command.

/// Prints a stage banner so the log reads the same locally and in CI.
pub(crate) fn stage(name: &str) {
    println!("\n==> {name}");
}

/// Accumulates findings for one audit and turns them into a single error.
#[derive(Default)]
pub(crate) struct Findings {
    items: Vec<String>,
}

impl Findings {
    pub(crate) fn push(&mut self, finding: impl Into<String>) {
        self.items.push(finding.into());
    }

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.items.len()
    }

    /// Prints every finding and returns an error naming the audit that failed.
    pub(crate) fn finish(self, audit: &str) -> Result<(), String> {
        if self.items.is_empty() {
            println!("{audit}: ok");
            return Ok(());
        }
        for item in &self.items {
            println!("  - {item}");
        }
        Err(format!("{audit}: {} finding(s)", self.items.len()))
    }
}
