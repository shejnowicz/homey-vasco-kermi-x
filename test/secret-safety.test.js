const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('git excludes representative private reverse-engineering artifacts', () => {
  const paths = ['.env', 'sample.mitm', 'captures/sample.bin', 'private-fixtures/account.json'];
  const output = execFileSync('git', ['check-ignore', '--stdin'], {
    input: `${paths.join('\n')}\n`,
    encoding: 'utf8',
  }).trim().split('\n');
  assert.deepEqual(output, paths);
});
