#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_FRAME_BYTES } from '../../packages/protocol/lib/index.js';
import { BoundedBuffer } from './bounded-buffer.mjs';

function requestEnvelope(input) {
  const line = input.split('\n').find((candidate) => candidate.trim().length > 0);
  if (line === undefined) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export function requestKind(args, input) {
  if (args[0] === 'hello') return 'hello';
  const decoded = requestEnvelope(input);
  return typeof decoded?.kind === 'string' ? decoded.kind : 'unknown';
}

export function dropsAcknowledgement(kind) {
  return kind === 'workflow.signal.submit';
}

export function proxyFailureFrame(input) {
  const request = requestEnvelope(input);
  return `${JSON.stringify({
    protocol: 'aizign',
    version: 1,
    requestId: typeof request?.requestId === 'string' ? request.requestId : null,
    kind: typeof request?.kind === 'string' ? request.kind : null,
    ok: false,
    error: {
      code: 'BENCHMARK_PROXY_OUTPUT_BOUND',
      message: 'lost-ACK proxy child output exceeded its benchmark bound',
    },
  })}\n`;
}

async function readStdin() {
  const input = new BoundedBuffer(MAX_FRAME_BYTES + 1);
  for await (const chunk of process.stdin) {
    if (!input.append(chunk)) throw new Error('request input exceeded the protocol frame bound');
  }
  return input.toString();
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
    const stdout = new BoundedBuffer(MAX_FRAME_BYTES + 1);
    let outputOverflow = false;
    child.stdout.on('data', (chunk) => {
      if (!stdout.append(chunk) && !outputOverflow) {
        outputOverflow = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.pipe(process.stderr);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (outputOverflow) {
        process.stdout.write(proxyFailureFrame(input));
        process.exitCode = 1;
        resolvePromise();
        return;
      }
      if (!dropsAcknowledgement(kind)) process.stdout.write(stdout.toBuffer());
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
