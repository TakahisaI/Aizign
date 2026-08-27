#!/usr/bin/env bash
# Read the repository's single cargo-deny version authority.
#
# This helper intentionally validates the file shape without carrying a second
# version value. The xtask gate performs the same byte-level validation before
# it runs cargo-deny.
set -euo pipefail

version_file="${1:-.cargo-deny-version}"

if [[ ! -f "${version_file}" ]]; then
  echo "cargo-deny version authority not found: ${version_file}" >&2
  exit 1
fi

line_count="$(wc -l < "${version_file}" | tr -d '[:space:]')"
if [[ "${line_count}" != "1" ]]; then
  echo "cargo-deny version authority must contain exactly one LF-terminated line: ${version_file}" >&2
  exit 1
fi

last_byte="$(LC_ALL=C tail -c 1 "${version_file}" | od -An -t x1 | tr -d '[:space:]')"
if [[ "${last_byte}" != "0a" ]]; then
  echo "cargo-deny version authority must end with exactly one LF byte (0x0A): ${version_file}" >&2
  exit 1
fi

version="$(sed -n '1p' "${version_file}")"
if [[ ! "${version}" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "cargo-deny version authority must be MAJOR.MINOR.PATCH with no extra whitespace: ${version_file}" >&2
  exit 1
fi

if ! cmp -s "${version_file}" <(printf '%s\n' "${version}"); then
  echo "cargo-deny version authority must contain exactly one canonical LF-terminated value: ${version_file}" >&2
  exit 1
fi

printf '%s\n' "${version}"
