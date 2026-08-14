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
    pl: 'Rekuperacja Vasco/Kermi',
  });
  assert.deepEqual(app.description, {
    en: 'Comfortable ventilation for every Homey routine',
    pl: 'Komfortowa rekuperacja dopasowana do rytmu domu',
  });
  assert.deepEqual(app.tags.pl, ['jakość powietrza', 'rekuperacja']);
  assert.equal(app.version, '1.0.1');
});

test('Polish release surfaces use rekuperacja terminology', () => {
  const driver = readJson('drivers/vasco-kermi-x/driver.compose.json');
  const store = read('README.pl.txt');
  const changelog = readJson('.homeychangelog.json');
  const releaseCopy = [store, changelog['1.0.0'].pl].join('\n');

  assert.equal(driver.name.pl, 'Rekuperator Vasco/Kermi D / T / X');
  assert.match(store, /Połącz rekuperację Vasco i Kermi/);
  assert.match(changelog['1.0.0'].pl, /dla rekuperatorów Vasco\/Kermi/);
  assert.doesNotMatch(releaseCopy, /wentylacj|central(?:a|e|i|ą) wentylacyjn/i);
});

test('patch release documents the Flow card icon fix', () => {
  const changelog = readJson('.homeychangelog.json');

  assert.match(changelog['1.0.1'].en, /Flow card icon/i);
  assert.match(changelog['1.0.1'].pl, /ikon.*kart(?:ach|y)? Flow/i);
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

test('public documentation describes D/T/X scope and current Fireplace control', () => {
  const readme = read('README.md');
  const driverReadme = read('drivers/vasco-kermi-x/README.md');
  const compatibility = read('.github/ISSUE_TEMPLATE/compatibility.yml');
  const contributing = read('CONTRIBUTING.md');

  assert.match(readme, /^# Vasco\/Kermi Ventilation for Homey$/m);
  assert.match(readme, /D, T and X/i);
  assert.match(readme, /Fireplace.*toggle.*selected duration/i);
  assert.match(readme, /turn.*Fireplace.*off/i);
  assert.doesNotMatch(readme, /explicit disabling is not offered/i);
  assert.doesNotMatch(readme, /exact remaining time|restores? the prior/i);
  assert.match(driverReadme, /^# Vasco\/Kermi Ventilation driver$/m);
  assert.match(driverReadme, /D, T and X/i);
  assert.match(driverReadme, /verified.*X500/i);
  assert.match(driverReadme, /runtime.*implemented/i);
  assert.doesNotMatch(driverReadme, /X Series driver|runtime .* introduced by/i);
  assert.match(compatibility, /D, T (?:and|or) X/i);
  assert.match(contributing, /test|homey-validate|dependency-audit/i);
});

test('CI exposes the three protected checks without publishing', () => {
  const workflow = read('.github/workflows/validate.yml');

  assert.match(workflow, /^\s{2}workflow_dispatch:\s*$/m);
  assert.match(workflow, /^\s{2}test:\s*$/m);
  assert.match(workflow, /^\s{2}homey-validate:\s*$/m);
  assert.match(workflow, /^\s{2}dependency-audit:\s*$/m);
  assert.match(workflow, /node-version:\s*22/);
  assert.match(workflow, /npm install --global homey@4\.4\.1/);
  assert.match(workflow, /git diff --exit-code -- app\.json/);
  assert.match(workflow, /homey app validate --level publish/);
  assert.match(workflow, /npm audit --omit=dev --audit-level=high/);
  assert.match(workflow, /cancel-in-progress:\s*true/);
  assert.doesNotMatch(workflow, /homey app publish|HOMEY_TOKEN|ATHOM_TOKEN/i);
});
