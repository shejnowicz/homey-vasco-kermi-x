'use strict';

const { readdirSync, readFileSync } = require('node:fs');
const { join, relative } = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const testRoot = join(__dirname, '..');

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.isFile() && entry.name.endsWith('.test.js') ? [path] : [];
  });
}

// The entry point used to be a hand-written list and four files had dropped off
// it, so 25 tests ran nowhere. This asserts the entry point still reaches every
// test file that exists, whatever mechanism it uses to find them.
test('the suite entry point loads every test file on disk', () => {
  const entry = readFileSync(join(testRoot, 'index.js'), 'utf8');
  const discovers = /readdirSync/.test(entry);

  const missing = testFiles(testRoot)
    .map(path => relative(testRoot, path).replace(/\\/g, '/'))
    .filter(name => {
      if (discovers) return false;
      const required = name.replace(/\.js$/, '');
      return !entry.includes(`require('./${required}')`);
    });

  assert.deepEqual(missing, [], `test files absent from the suite: ${missing.join(', ')}`);
  assert.ok(discovers, 'test/index.js must discover test files rather than list them by hand');
});
