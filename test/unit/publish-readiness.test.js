const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const root = join(__dirname, '..', '..');

function read(filename) {
  return readFileSync(join(root, filename), 'utf8');
}

function readJson(filename) {
  return JSON.parse(read(filename));
}

test('Homey Store identity uses the D/T/X community product name', () => {
  const app = readJson('.homeycompose/app.json');

  assert.deepEqual(app.name, {
    en: 'Vasco/Kermi Ventilation',
    pl: 'Wentylacja Vasco/Kermi',
  });
  assert.deepEqual(app.description, {
    en: 'Comfortable ventilation for every Homey routine',
    pl: 'Komfortowa wentylacja dopasowana do rytmu domu',
  });
  assert.equal(app.version, '0.1.0');
});

for (const [filename, languagePattern] of [
  ['README.txt', /developed and tested with Vasco X500/i],
  ['README.pl.txt', /opracowano i przetestowano z Vasco X500/i],
]) {
  test(`${filename} states the verified model and community scope`, () => {
    const description = read(filename);

    assert.match(description, /D, T (?:and|i) X/i);
    assert.match(description, languagePattern);
    assert.match(description, /community verification|weryfikacji społeczności/i);
    assert.doesNotMatch(
      description,
      /remaining time|pozostały czas|restores? the prior|przywraca poprzedni|local session|lokaln.*sesj/i,
    );
  });
}
