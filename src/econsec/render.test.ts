import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupAlertsForDisplay } from './render.ts';
import type { EconsecAlert } from './types';

function alert(overrides: Partial<EconsecAlert>): EconsecAlert {
  return {
    date: '2026-07-18T03:00:00.000Z',
    source: 'ofac-sdn',
    type: 'add',
    entity: 'Entity',
    detail: 'SDN',
    ...overrides,
  };
}

test('groupAlertsForDisplay collapses 4+ consecutive same-day/source/type alerts into one group', () => {
  const alerts = [alert({ entity: 'A' }), alert({ entity: 'B' }), alert({ entity: 'C' }), alert({ entity: 'D' })];

  const items = groupAlertsForDisplay(alerts);

  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'group');
});

test('groupAlertsForDisplay leaves a run of exactly 3 as individual items', () => {
  const alerts = [alert({ entity: 'A' }), alert({ entity: 'B' }), alert({ entity: 'C' })];

  const items = groupAlertsForDisplay(alerts);

  assert.equal(items.length, 3);
  assert.ok(items.every((item) => item.kind === 'single'));
});

test('groupAlertsForDisplay group carries every alert from the run (expansion count matches)', () => {
  const alerts = [
    alert({ entity: 'A' }),
    alert({ entity: 'B' }),
    alert({ entity: 'C' }),
    alert({ entity: 'D' }),
    alert({ entity: 'E' }),
  ];

  const items = groupAlertsForDisplay(alerts);
  const item = items[0];

  assert.equal(items.length, 1);
  assert.ok(item);
  assert.equal(item.kind, 'group');
  if (item.kind === 'group') {
    assert.equal(item.group.alerts.length, 5);
    assert.deepEqual(
      item.group.alerts.map((a) => a.entity),
      ['A', 'B', 'C', 'D', 'E'],
    );
  }
});

test('groupAlertsForDisplay only merges a *consecutive* run - an interruption splits it back to individuals', () => {
  const alerts = [
    alert({ entity: 'A' }),
    alert({ entity: 'B' }),
    alert({ source: 'csl', entity: 'Interruption' }),
    alert({ entity: 'C' }),
    alert({ entity: 'D' }),
  ];

  const items = groupAlertsForDisplay(alerts);

  // A,B (2, below threshold) -> single,single; interruption -> single; C,D (2) -> single,single
  assert.equal(items.length, 5);
  assert.ok(items.every((item) => item.kind === 'single'));
});

test('groupAlertsForDisplay groups by JST calendar day, not raw UTC date', () => {
  // 2026-07-18T15:05:00Z is 2026-07-19 00:05 JST - still counts as the same
  // JST day as the other three, which are all JST-morning on 07-19.
  const alerts = [
    alert({ date: '2026-07-18T15:05:00.000Z', entity: 'A' }),
    alert({ date: '2026-07-18T20:00:00.000Z', entity: 'B' }), // 2026-07-19 05:00 JST
    alert({ date: '2026-07-18T21:00:00.000Z', entity: 'C' }), // 2026-07-19 06:00 JST
    alert({ date: '2026-07-18T22:00:00.000Z', entity: 'D' }), // 2026-07-19 07:00 JST
  ];

  const items = groupAlertsForDisplay(alerts);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'group');

  // Now push the first alert one JST day earlier - the run breaks in two.
  const splitAlerts = [
    alert({ date: '2026-07-17T14:00:00.000Z', entity: 'Z' }), // 2026-07-17 23:00 JST
    alert({ date: '2026-07-18T20:00:00.000Z', entity: 'B' }),
    alert({ date: '2026-07-18T21:00:00.000Z', entity: 'C' }),
    alert({ date: '2026-07-18T22:00:00.000Z', entity: 'D' }),
  ];
  const splitItems = groupAlertsForDisplay(splitAlerts);
  // Z alone (different JST day) + B,C,D (3, below threshold) -> all singles
  assert.equal(splitItems.length, 4);
  assert.ok(splitItems.every((item) => item.kind === 'single'));
});
