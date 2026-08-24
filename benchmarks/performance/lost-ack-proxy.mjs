#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function requestKind(args, input) {
  if (args[0] === 'hello') return 'hello';
  const line = input.split('\n').find((candidate) => candidate.trim().length > 0);
  if (line === undefined) return 'unknown';
  try {
    const decoded = JSON.parse(line);
    return typeof decoded?.kind === 'string' ? decoded.kind : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function dropsAcknowledgement(kind) {
  return kind === 'workflow.signal.submit';
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv) {
  const [binary, ...args] = argv;
  if (binary === undefined) throw new Error('usage: lost-ack-proxy.mjs <aizign> <subcommand>');
  const input = await readStdin();
  const kind = requestKind(args, input);
  const counter = process.env.AIZIGN_LOST_ACK_COUNTER;
  if (counter !== undefined) appendFileSync(counter, `${kind}\n`, { mode: 0o600 });

  await new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, {
      env: {
        PATH: process.env.PATH ?? '',
        ...(process.env.AIZIGN_TIMING_JSON === '1' ? { AIZIGN_TIMING_JSON: '1' } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.pipe(process.stderr);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (!dropsAcknowledgement(kind)) process.stdout.write(Buffer.concat(stdout));
      if (signal !== null) process.kill(process.pid, signal);
      process.exitCode = code ?? 1;
      resolvePromise();
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `lost-ack proxy failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
