// Every `*.test.js` under this directory is loaded, found rather than listed.
//
// This used to be a hand-written list of requires, and four files had fallen
// off it: flow-cards, homey-runtime, vasco-control-duration and
// vasco-websocket-client - 25 tests that ran in nobody's gate, including CI's.
// One of them had rotted in the meantime and nothing reported it. A list that
// must be edited by hand to keep coverage is a list that silently loses it.
//
// `test/unit/coverage-wiring.test.js` asserts this discovery actually reaches
// every file on disk.
'use strict';

const { readdirSync } = require('node:fs');
const { join } = require('node:path');

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return testFiles(path);
      return entry.isFile() && entry.name.endsWith('.test.js') ? [path] : [];
    });
}

for (const file of testFiles(__dirname)) {
  require(file);
}
