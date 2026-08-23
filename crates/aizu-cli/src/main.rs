//! The `aizu` binary: the composition root and the only place in the
//! workspace that touches arguments, stdin/stdout, the system clock, and the
//! state directory.
//!
//! ```text
//! aizu hello                    # handshake response, no state needed
//! aizu handle --state <dir>     # one request frame on stdin -> one response frame on stdout
//! ```
//!
//! stdout carries exactly one protocol frame; diagnostics go to stderr and
//! never include request or journal contents (ADR-0003).

#![forbid(unsafe_code)]

mod run;

use std::process::ExitCode;

const USAGE: &str = "\
usage:
  aizu hello                    print the hello response (protocol version, capabilities)
  aizu handle --state <dir>     read one request frame from stdin, write one response frame to stdout
  aizu --version
";

/// Exit codes. A response frame was written whenever the exit code is 0,
/// even if that frame reports an error; the other codes mean no frame
/// could be written.
mod exit {
    pub(crate) const OK: u8 = 0;
    pub(crate) const USAGE: u8 = 2;
    pub(crate) const IO: u8 = 3;
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("hello") if args.len() == 1 => run::hello(),
        Some("handle") => match parse_state(&args[1..]) {
            Some(state) => run::handle(&state),
            None => usage(),
        },
        Some("--version" | "-V") => {
            println!("aizu {}", env!("CARGO_PKG_VERSION"));
            exit::OK
        }
        Some("--help" | "-h" | "help") => {
            print!("{USAGE}");
            exit::OK
        }
        _ => usage(),
    };
    ExitCode::from(code)
}

fn usage() -> u8 {
    eprint!("{USAGE}");
    exit::USAGE
}

fn parse_state(args: &[String]) -> Option<std::path::PathBuf> {
    match args {
        [flag, value] if flag == "--state" && !value.is_empty() => Some(value.into()),
        [combined] => combined
            .strip_prefix("--state=")
            .filter(|v| !v.is_empty())
            .map(Into::into),
        _ => None,
    }
}
