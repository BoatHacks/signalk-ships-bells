const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  bellCountForMinutes,
  minutesSinceMidnight,
  parseTimeToMinutes,
  isWithinQuietHours,
  nextNewYearEveTriggerTime
} = require('../index.js');

test('simple-cycle cycles 1-8 every 4 hours all day, including through the second dog watch', () => {
  for (let m = 30; m <= 1440; m += 30) {
    const mm = m % 1440;
    const expected = ((m / 30 - 1) % 8) + 1;
    assert.strictEqual(bellCountForMinutes(mm, 'simple-cycle'), expected, `simple-cycle @ ${mm}min`);
  }
});

test('traditional matches the general cycle everywhere except the second dog watch', () => {
  for (let m = 30; m <= 1440; m += 30) {
    const mm = m % 1440;
    const inSecondDogWatch = mm > 1080 && mm <= 1200;
    if (inSecondDogWatch) {
      continue; // covered by the dedicated test below
    }
    const expected = ((m / 30 - 1) % 8) + 1;
    assert.strictEqual(bellCountForMinutes(mm, 'traditional'), expected, `traditional @ ${mm}min`);
  }
});

test('traditional resets to 1-2-3 then rings 8 through the second dog watch (18:00-20:00)', () => {
  assert.strictEqual(bellCountForMinutes(1110, 'traditional'), 1); // 18:30
  assert.strictEqual(bellCountForMinutes(1140, 'traditional'), 2); // 19:00
  assert.strictEqual(bellCountForMinutes(1170, 'traditional'), 3); // 19:30
  assert.strictEqual(bellCountForMinutes(1200, 'traditional'), 8); // 20:00
});

test('simple-cycle continues 5-6-7 then rings 8 through the second dog watch (18:00-20:00)', () => {
  assert.strictEqual(bellCountForMinutes(1110, 'simple-cycle'), 5); // 18:30
  assert.strictEqual(bellCountForMinutes(1140, 'simple-cycle'), 6); // 19:00
  assert.strictEqual(bellCountForMinutes(1170, 'simple-cycle'), 7); // 19:30
  assert.strictEqual(bellCountForMinutes(1200, 'simple-cycle'), 8); // 20:00
});

test('watch changes (00:00, 04:00, 08:00, 12:00, 16:00) always ring 8 bells in every scheme', () => {
  const watchChangeMinutes = [0, 240, 480, 720, 960];
  for (const mm of watchChangeMinutes) {
    for (const scheme of ['traditional', 'simple-cycle']) {
      assert.strictEqual(bellCountForMinutes(mm, scheme), 8, `${scheme} @ ${mm}min`);
    }
  }
});

test('minutesSinceMidnight extracts hours/minutes and ignores seconds', () => {
  assert.strictEqual(minutesSinceMidnight(new Date(2026, 0, 1, 18, 30, 45)), 1110);
  assert.strictEqual(minutesSinceMidnight(new Date(2026, 0, 1, 0, 0, 0)), 0);
  assert.strictEqual(minutesSinceMidnight(new Date(2026, 0, 1, 23, 59, 59)), 1439);
});

test('nextNewYearEveTriggerTime returns 23:59:47 on Dec 31 of the current year, if that is still ahead', () => {
  const now = new Date(2026, 5, 1, 12, 0, 0); // June 1, 2026, midday
  const result = nextNewYearEveTriggerTime(now);
  assert.strictEqual(result.getFullYear(), 2026);
  assert.strictEqual(result.getMonth(), 11);
  assert.strictEqual(result.getDate(), 31);
  assert.strictEqual(result.getHours(), 23);
  assert.strictEqual(result.getMinutes(), 59);
  assert.strictEqual(result.getSeconds(), 47);
});

test('nextNewYearEveTriggerTime rolls over to next year once this year\'s has passed', () => {
  const justAfter = new Date(2026, 11, 31, 23, 59, 48); // 1 second after the trigger time
  const result = nextNewYearEveTriggerTime(justAfter);
  assert.strictEqual(result.getFullYear(), 2027);
  assert.strictEqual(result.getMonth(), 11);
  assert.strictEqual(result.getDate(), 31);
  assert.strictEqual(result.getHours(), 23);
  assert.strictEqual(result.getMinutes(), 59);
  assert.strictEqual(result.getSeconds(), 47);

  // Exactly at the trigger time counts as "already passed" too (>=, not >)
  const exactlyAt = new Date(2026, 11, 31, 23, 59, 47);
  const result2 = nextNewYearEveTriggerTime(exactlyAt);
  assert.strictEqual(result2.getFullYear(), 2027);
});

test('nextNewYearEveTriggerTime is always in the future relative to "now", never in the past', () => {
  for (const now of [
    new Date(2026, 0, 1, 0, 0, 0),
    new Date(2026, 11, 31, 0, 0, 0),
    new Date(2026, 11, 31, 23, 59, 46),
    new Date(2026, 11, 31, 23, 59, 47),
    new Date(2026, 11, 31, 23, 59, 48)
  ]) {
    assert.ok(nextNewYearEveTriggerTime(now).getTime() > now.getTime(), `failed for now=${now.toISOString()}`);
  }
});

test('parseTimeToMinutes parses valid HH:MM and rejects everything else', () => {
  assert.strictEqual(parseTimeToMinutes('00:00'), 0);
  assert.strictEqual(parseTimeToMinutes('06:00'), 360);
  assert.strictEqual(parseTimeToMinutes('22:00'), 1320);
  assert.strictEqual(parseTimeToMinutes('23:59'), 1439);
  assert.ok(Number.isNaN(parseTimeToMinutes('24:00')));
  assert.ok(Number.isNaN(parseTimeToMinutes('12:60')));
  assert.ok(Number.isNaN(parseTimeToMinutes('not a time')));
  assert.ok(Number.isNaN(parseTimeToMinutes(undefined)));
  assert.ok(Number.isNaN(parseTimeToMinutes('')));
});

test('isWithinQuietHours handles a same-day range (e.g. 13:00-15:00)', () => {
  assert.strictEqual(isWithinQuietHours(12 * 60, '13:00', '15:00'), false); // 12:00
  assert.strictEqual(isWithinQuietHours(13 * 60, '13:00', '15:00'), true); // 13:00, inclusive start
  assert.strictEqual(isWithinQuietHours(14 * 60, '13:00', '15:00'), true); // 14:00
  assert.strictEqual(isWithinQuietHours(15 * 60, '13:00', '15:00'), false); // 15:00, exclusive end
});

test('isWithinQuietHours handles an overnight range spanning midnight (e.g. 22:00-06:00)', () => {
  assert.strictEqual(isWithinQuietHours(21 * 60 + 59, '22:00', '06:00'), false); // 21:59
  assert.strictEqual(isWithinQuietHours(22 * 60, '22:00', '06:00'), true); // 22:00
  assert.strictEqual(isWithinQuietHours(0, '22:00', '06:00'), true); // 00:00
  assert.strictEqual(isWithinQuietHours(5 * 60 + 59, '22:00', '06:00'), true); // 05:59
  assert.strictEqual(isWithinQuietHours(6 * 60, '22:00', '06:00'), false); // 06:00, exclusive end
  assert.strictEqual(isWithinQuietHours(12 * 60, '22:00', '06:00'), false); // 12:00, midday
});

test('isWithinQuietHours treats an equal or invalid start/end as "no range" rather than "muted all day"', () => {
  assert.strictEqual(isWithinQuietHours(12 * 60, '22:00', '22:00'), false);
  assert.strictEqual(isWithinQuietHours(12 * 60, undefined, undefined), false);
  assert.strictEqual(isWithinQuietHours(12 * 60, 'garbage', '06:00'), false);
});
