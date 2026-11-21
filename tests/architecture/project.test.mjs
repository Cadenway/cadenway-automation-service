import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyNestArchitecture } from '@cadenway/nest-testing/architecture';

const generatedActionClients = new Set([
  'src/modules/automations/infrastructure/adapters/task-service/generated/task-service.ts',
  'src/modules/automations/infrastructure/adapters/notification-service/generated/notification-service.ts',
]);

test('authored code follows the Cadenway architecture', () => {
  // Orval writes multiple declarations to this file. CI checks it against the published spec.
  const findings = verifyNestArchitecture({
    rootDir: fileURLToPath(new URL('../..', import.meta.url)),
    tsconfig: 'tsconfig.json',
    profile: 'service',
    convention: 'strict',
  }).filter(
    ({ file, rule }) => !generatedActionClients.has(file) || rule !== 'strict-contract-file',
  );
  assert.equal(
    findings.length,
    0,
    findings
      .map(({ file, line, rule, message }) => `${file}:${line} [${rule}] ${message}`)
      .join('\n'),
  );
});
