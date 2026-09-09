#!/usr/bin/env node
// The executor service, from the command line.
//
//   node cre/run-executor.ts --port 8090 --trigger-url https://…/trigger
//
// --trigger-url is optional. Without it, intents queue and nothing forwards
// them, which is the correct configuration while awaiting Confidential
// Workflows enrolment: a queue that visibly is not draining beats a payment
// that silently disappeared.

import { ProtocolFailure } from '@opaque/protocol-types';

import { createExecutorServer } from './executor-server.ts';

const flags = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  const key = argv[i];
  const value = argv[i + 1];
  if (key === undefined || !key.startsWith('--') || value === undefined) {
    throw new ProtocolFailure('INVALID_INPUT', `expected --flag value, got ${String(key)}`);
  }
  flags.set(key.slice(2), value);
}

if (import.meta.filename === process.argv[1]) {
  const port = Number(flags.get('port') ?? 8090);
  const triggerUrl = flags.get('trigger-url');
  const server = createExecutorServer(triggerUrl === undefined ? {} : { triggerUrl });
  await server.listen(port);
  // The only line this process ever writes. Not a request, not an intent id.
  process.stdout.write(
    `executor listening on ${port}${triggerUrl === undefined ? ' (queue only, no trigger configured)' : ''}\n`,
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void server.close().then(() => process.exit(0)));
  }
}
