import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinDetailParts, mapUkslGroupType, buildPageChangeDetail } from './econsec-watch.mjs';

// ---- joinDetailParts ----

test('joinDetailParts joins non-empty parts with the pipe separator', () => {
  assert.equal(joinDetailParts('Iran (E13662)', '団体'), 'Iran (E13662)｜団体');
});

test('joinDetailParts omits missing/empty parts instead of showing a blank slot', () => {
  assert.equal(joinDetailParts('Iran (E13662)', ''), 'Iran (E13662)');
  assert.equal(joinDetailParts('', '団体'), '団体');
  assert.equal(joinDetailParts(null, undefined), '');
});

// ---- mapUkslGroupType ----

test('mapUkslGroupType translates the UK Sanctions List Group Type to Japanese', () => {
  assert.equal(mapUkslGroupType('Individual'), '個人');
  assert.equal(mapUkslGroupType('Entity'), '団体');
});

test('mapUkslGroupType passes through unrecognized values and empty stays empty', () => {
  assert.equal(mapUkslGroupType('Ship'), 'Ship');
  assert.equal(mapUkslGroupType(''), '');
  assert.equal(mapUkslGroupType(undefined), '');
});

// ---- buildPageChangeDetail ----

test('buildPageChangeDetail keeps a real body-text line change and drops a script-noise line change mixed in the same diff', () => {
  const prevLines = [
    'Entity List Update Notice',
    'NOISE_PLACEHOLDER_TOKEN_1',
    'Effective as of January 2026, the following entities are added.',
    '2026',
  ];
  const newLines = [
    'Entity List Update Notice',
    'NOISE_PLACEHOLDER_TOKEN_2',
    'Effective as of March 2026, the following entities are added.',
    '2026',
  ];

  const detail = buildPageChangeDetail(prevLines, newLines);

  assert.match(detail, /Effective as of January 2026/);
  assert.match(detail, /Effective as of March 2026/);
  assert.doesNotMatch(detail, /NOISE_PLACEHOLDER_TOKEN/);
});

test('buildPageChangeDetail reports display-only change when every changed line is noise', () => {
  const prevLines = ['Entity List Update Notice', '12345', 'var x = 1;'];
  const newLines = ['Entity List Update Notice', '67890', 'var x = 2;'];

  const detail = buildPageChangeDetail(prevLines, newLines);

  assert.equal(detail, '表示上の変更のみ（本文変更なし）');
});

test('buildPageChangeDetail caps output at 3 changed-line pairs and 120 chars per side', () => {
  const longOld = 'A'.repeat(200);
  const longNew = 'B'.repeat(200);
  const prevLines = [longOld, 'one old sentence here', 'two old sentence here', 'three old sentence here', 'four old sentence here'];
  const newLines = [longNew, 'one new sentence here', 'two new sentence here', 'three new sentence here', 'four new sentence here'];

  const detail = buildPageChangeDetail(prevLines, newLines);
  const pairLines = detail.split('\n');

  assert.equal(pairLines.length, 3);
  for (const line of pairLines) {
    const [oldPart, newPart] = line.split('／');
    assert.ok(oldPart.replace(/^－/, '').length <= 120);
    assert.ok(newPart.replace(/^＋/, '').length <= 120);
  }
});
