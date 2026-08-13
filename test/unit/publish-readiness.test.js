const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const root = join(__dirname, '..', '..');

function read(filename) {
  return readFileSync(join(root, filename), 'utf8');
}

test('English Store copy explains the Fireplace picker, known remaining time, and safe restoration', () => {
  const description = read('README.txt');

  assert.match(description, /Fireplace duration.*device picker/i);
  assert.match(description, /exact remaining time.*sessions.*Homey/i);
  assert.match(description, /Stop restores the prior ventilation mode.*Homey/i);
  assert.doesNotMatch(description, /(?:disable command|disable Fireplace|private endpoint|reverse.engineer)/i);
});

test('Polish Store copy explains the Fireplace picker, known remaining time, and safe restoration', () => {
  const description = read('README.pl.txt');

  assert.match(description, /czas trybu kominka.*selektorze urządzenia/i);
  assert.match(description, /dokładny pozostały czas.*sesji.*Homey/i);
  assert.match(description, /Zatrzymaj przywraca poprzedni tryb wentylacji.*Homey/i);
  assert.doesNotMatch(description, /(?:polecenie wyłączenia|wyłącz.*tryb kominka|prywatn.*endpoint|inżynieri.*wsteczn)/i);
});
