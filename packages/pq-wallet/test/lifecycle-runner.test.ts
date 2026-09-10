import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../scripts/check-lifecycle.ts';

test('lifecycle_runner_never_runs_mock_under_a_live_label', async () => {
  await assert.rejects(main(['--network', 'arc-testnet']), /MOCK-only/);
});
