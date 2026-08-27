#!/usr/bin/env bash
# Verify the installed cargo-deny executable against the repository authority.
#
# The command output is compared as bytes so an extra line, missing terminal LF,
# or other wrapper output cannot be hidden by shell command substitution.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
authority_file="${1:-${script_dir}/../../.cargo-deny-version}"
version="$(bash "${script_dir}/read-cargo-deny-version.sh" "${authority_file}")"

tmp_dir="$(mktemp -d)"
actual_file="${tmp_dir}/actual"
expected_file="${tmp_dir}/expected"
cleanup() { rm -rf -- "${tmp_dir}"; }
trap cleanup EXIT

if ! cargo deny --version >"${actual_file}"; then
  echo "cargo deny --version failed; cargo-deny ${version} is required" >&2
  exit 1
fi

printf 'cargo-deny %s\n' "${version}" >"${expected_file}"
if ! cmp -s "${expected_file}" "${actual_file}"; then
  echo "cargo deny --version output does not exactly match the authority" >&2
  echo "expected exactly: cargo-deny ${version} followed by one LF byte" >&2
  exit 1
fi

printf '%s\n' "${version}"
