const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const privacy = readFileSync('legal/privacy/index.html', 'utf8');
const terms = readFileSync('legal/terms/index.html', 'utf8');
const homepage = readFileSync('site/index.html', 'utf8');

test('privacy policy discloses each current data flow and Limited Use compliance', () => {
  for (const disclosure of [
    'display name, email address, and Drive permission ID',
    'Names, IDs, and write capabilities',
    'Selected media bytes travel directly from your browser to Google Drive',
    'GitHub Pages serves the static website',
    'Limited Use requirements',
    'never deletes source media',
    'browser’s IndexedDB',
    'resumable session URLs',
    'does not persist media bytes, live File objects, OAuth access tokens',
    'first and last 64 KiB',
    'duplicate-prevention history',
  ]) assert.match(privacy, new RegExp(disclosure));
  assert.doesNotMatch(privacy, /client secret|refresh token/i);
});

test('homepage presents the independent BatchHarbor brand and policy links', () => {
  assert.match(homepage, /<title>BatchHarbor/);
  assert.match(homepage, /href="privacy\/"/);
  assert.match(homepage, /href="terms\/"/);
  assert.match(homepage, /not affiliated with or endorsed by Google/);
  assert.doesNotMatch(homepage, /<script|<form|google-analytics|googletagmanager/i);
});

test('home and app expose static Open Graph metadata with a deployable preview image', () => {
  const origin = 'https://batchharbor.killfly.com';
  for (const [source, path, title] of [
    [homepage, '/', 'Reliable photo and video uploads'],
    [readFileSync('phase4/index.html', 'utf8'), '/app/', 'Upload to Google Drive'],
  ]) {
    const head = source.split('</head>')[0];
    const metadata = Object.fromEntries(Array.from(head.matchAll(/<meta property="([^"]+)" content="([^"]+)"/g), match => [match[1], match[2]]));
    assert.equal(metadata['og:type'], 'website');
    assert.equal(metadata['og:site_name'], 'BatchHarbor');
    assert.equal(metadata['og:title'], title);
    assert.match(metadata['og:description'], /directly from your browser/);
    assert.equal(metadata['og:url'], `${origin}${path}`);
    assert.equal(metadata['og:image'], `${origin}/assets/brand/reliable-uploader-logo.png`);
    assert.equal(metadata['og:image:type'], 'image/png');
    assert.equal(metadata['og:image:alt'], 'BatchHarbor logo');
    const image = readFileSync(`.${new URL(metadata['og:image']).pathname}`);
    assert.equal(Number(metadata['og:image:width']), image.readUInt32BE(16));
    assert.equal(Number(metadata['og:image:height']), image.readUInt32BE(20));
    assert.ok(image.byteLength < 10 * 1024 * 1024);
    assert.match(head, /rel="apple-touch-icon"/);
  }
});

test('legal pages have no scripts, forms, analytics, or remote embedded content', () => {
  for (const page of [privacy, terms]) {
    assert.doesNotMatch(page, /<script|<form|google-analytics|googletagmanager/i);
    assert.match(page, /Content-Security-Policy/);
    assert.match(page, /reliable-uploader-logo\.png/);
  }
});

test('terms identify experimental behavior and user verification responsibility', () => {
  assert.match(terms, /experimental software under active development/);
  assert.match(terms, /verify uploaded files in Drive/);
  assert.match(terms, /not affiliated with or endorsed by Google/);
});
