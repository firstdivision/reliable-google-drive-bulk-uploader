const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const privacy = readFileSync('legal/privacy/index.html', 'utf8');
const terms = readFileSync('legal/terms/index.html', 'utf8');

test('privacy policy discloses each current data flow and Limited Use compliance', () => {
  for (const disclosure of [
    'display name, email address, and Drive permission ID',
    'Names, IDs, and write capabilities',
    'Selected media bytes travel directly from your browser to Google Drive',
    'GitHub Pages serves the static website',
    'Limited Use requirements',
    'never deletes source media',
  ]) assert.match(privacy, new RegExp(disclosure));
  assert.doesNotMatch(privacy, /client secret|refresh token/i);
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
