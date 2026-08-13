const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

const root = join(__dirname, '..', '..');

function read(...pathParts) {
  return readFileSync(join(root, ...pathParts), 'utf8');
}

function readJson(...pathParts) {
  return JSON.parse(read(...pathParts));
}

function readPngSize(...pathParts) {
  const png = readFileSync(join(root, ...pathParts));
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    `${pathParts.join('/')} must be a PNG`,
  );
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

test('publish manifests reference complete app and driver artwork', () => {
  const app = readJson('.homeycompose', 'app.json');
  const driver = readJson('drivers', 'vasco-kermi-x', 'driver.compose.json');
  const expectedAppImages = {
    small: { width: 250, height: 175 },
    large: { width: 500, height: 350 },
    xlarge: { width: 1000, height: 700 },
  };
  const expectedDriverImages = {
    small: { width: 75, height: 75 },
    large: { width: 500, height: 500 },
    xlarge: { width: 1000, height: 1000 },
  };

  assert.equal(app.brandColor, '#254F5D');
  assert.equal(app.source, 'https://github.com/shejnowicz/homey-vasco-kermi-x');
  assert.equal(app.support, 'https://github.com/shejnowicz/homey-vasco-kermi-x/issues');
  assert.equal(app.bugs.url, app.support);
  assert.equal(existsSync(join(root, 'assets', 'icon.svg')), true);
  assert.equal(existsSync(join(root, 'drivers', 'vasco-kermi-x', 'assets', 'icon.svg')), true);

  for (const [size, dimensions] of Object.entries(expectedAppImages)) {
    const appPath = `/assets/images/${size}.png`;
    assert.equal(app.images[size], appPath);
    assert.deepEqual(readPngSize(...appPath.slice(1).split('/')), dimensions);
  }

  for (const [size, dimensions] of Object.entries(expectedDriverImages)) {
    const driverPath = `/drivers/vasco-kermi-x/assets/images/${size}.png`;
    assert.equal(driver.images[size], driverPath);
    assert.deepEqual(readPngSize(...driverPath.slice(1).split('/')), dimensions);
  }
});

test('store descriptions are plain text and packaging excludes development material', () => {
  for (const filename of ['README.txt', 'README.pl.txt']) {
    const description = read(filename);
    assert.doesNotMatch(description, /^\s*#/m, `${filename} must not contain Markdown headings`);
    assert.doesNotMatch(description, /https?:\/\//i, `${filename} must not contain URLs`);
    assert.doesNotMatch(description, /\[[^\]]+\]\([^)]+\)/, `${filename} must not contain links`);
  }

  const homeyIgnore = read('.homeyignore');
  for (const excluded of [
    '.github/',
    '.superpowers/',
    'docs/',
    'test/',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'assets/images/source.svg',
    'drivers/vasco-kermi-x/assets/images/source.svg',
  ]) {
    assert.match(homeyIgnore, new RegExp(`^${excluded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
  assert.doesNotMatch(homeyIgnore, /^README\.txt$/m);
  assert.doesNotMatch(homeyIgnore, /^README\.pl\.txt$/m);
});

test('public issue inputs never solicit private diagnostic material', () => {
  for (const filename of ['compatibility.yml', 'bug.yml']) {
    const form = read('.github', 'ISSUE_TEMPLATE', filename);
    const requestBlocks = form.split(/\n(?=\s*- type: )/)
      .filter(block => /- type: (?:input|textarea)/.test(block));

    for (const block of requestBlocks) {
      assert.doesNotMatch(
        block,
        /(?:capture|packet|raw (?:account )?response|password|credential|access token|secret)/i,
        `${filename} must not request captures, raw responses, or secrets`,
      );
    }
  }
});
