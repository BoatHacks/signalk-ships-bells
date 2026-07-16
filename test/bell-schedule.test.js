const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bellCountForMinutes, minutesSinceMidnight } = require('../index.js');

test('simple-cycle and pre-1797 cycle 1-8 every 4 hours all day', () => {
  for (let m = 30; m <= 1440; m += 30) {
    const mm = m % 1440;
    const expected = ((m / 30 - 1) % 8) + 1;
    assert.strictEqual(bellCountForMinutes(mm, 'simple-cycle'), expected, `simple-cycle @ ${mm}min`);
    assert.strictEqual(bellCountForMinutes(mm, 'pre-1797'), expected, `pre-1797 @ ${mm}min`);
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

test('pre-1797 continues 5-6-7 then rings 8 through the second dog watch (18:00-20:00)', () => {
  assert.strictEqual(bellCountForMinutes(1110, 'pre-1797'), 5); // 18:30
  assert.strictEqual(bellCountForMinutes(1140, 'pre-1797'), 6); // 19:00
  assert.strictEqual(bellCountForMinutes(1170, 'pre-1797'), 7); // 19:30
  assert.strictEqual(bellCountForMinutes(1200, 'pre-1797'), 8); // 20:00
});

test('simple-cycle matches pre-1797 exactly across every half hour of the day', () => {
  for (let m = 30; m <= 1440; m += 30) {
    const mm = m % 1440;
    assert.strictEqual(
      bellCountForMinutes(mm, 'simple-cycle'),
      bellCountForMinutes(mm, 'pre-1797'),
      `mismatch @ ${mm}min`
    );
  }
});

test('watch changes (00:00, 04:00, 08:00, 12:00, 16:00) always ring 8 bells in every scheme', () => {
  const watchChangeMinutes = [0, 240, 480, 720, 960];
  for (const mm of watchChangeMinutes) {
    for (const scheme of ['traditional', 'simple-cycle', 'pre-1797']) {
      assert.strictEqual(bellCountForMinutes(mm, scheme), 8, `${scheme} @ ${mm}min`);
    }
  }
});

test('minutesSinceMidnight extracts hours/minutes and ignores seconds', () => {
  assert.strictEqual(minutesSinceMidnight(new Date(2026, 0, 1, 18, 30, 45)), 1110);
  assert.strictEqual(minutesSinceMidnight(new Date(2026, 0, 1, 0, 0, 0)), 0);
  assert.strictEqual(minutesSinceMidnight(new Date(2026, 0, 1, 23, 59, 59)), 1439);
});
