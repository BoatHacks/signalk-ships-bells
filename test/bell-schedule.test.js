const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  bellCountForMinutes,
  minutesSinceMidnight,
  parseTimeToMinutes,
  isWithinQuietHours,
  nextNewYearEveTriggerTime,
  nightVolumeFactorForMoment,
  minutesSinceMidnightUTC,
  effectiveMinutesSinceMidnight,
  effectiveWatchScheme,
  buildBellScheduleTable
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

test('nightVolumeFactorForMoment is 1 (full volume) when the feature is disabled', () => {
  const options = {
    nightVolumeEnabled: false,
    nightVolumeStart: '22:00',
    nightVolumeEnd: '06:00',
    nightVolumeLevel: 30
  };
  assert.strictEqual(nightVolumeFactorForMoment(new Date(2026, 0, 1, 23, 0, 0), options), 1);
});

test('nightVolumeFactorForMoment is 1 outside the configured range, even when enabled', () => {
  const options = {
    nightVolumeEnabled: true,
    nightVolumeStart: '22:00',
    nightVolumeEnd: '06:00',
    nightVolumeLevel: 30
  };
  assert.strictEqual(nightVolumeFactorForMoment(new Date(2026, 0, 1, 12, 0, 0), options), 1); // midday
});

test('nightVolumeFactorForMoment returns level/100 within the configured overnight range', () => {
  const options = {
    nightVolumeEnabled: true,
    nightVolumeStart: '22:00',
    nightVolumeEnd: '06:00',
    nightVolumeLevel: 30
  };
  assert.strictEqual(nightVolumeFactorForMoment(new Date(2026, 0, 1, 23, 0, 0), options), 0.3); // 23:00
  assert.strictEqual(nightVolumeFactorForMoment(new Date(2026, 0, 1, 3, 0, 0), options), 0.3); // 03:00
});

test('minutesSinceMidnightUTC extracts UTC hours/minutes, independent of local timezone', () => {
  assert.strictEqual(minutesSinceMidnightUTC(new Date(Date.UTC(2026, 0, 1, 18, 30, 45))), 1110);
  assert.strictEqual(minutesSinceMidnightUTC(new Date(Date.UTC(2026, 0, 1, 0, 0, 0))), 0);
  assert.strictEqual(minutesSinceMidnightUTC(new Date(Date.UTC(2026, 0, 1, 23, 59, 59))), 1439);
});

test('effectiveMinutesSinceMidnight falls back to local time when the UTC offset is disabled', () => {
  const local = new Date(2026, 0, 1, 12, 0, 0);
  assert.strictEqual(
    effectiveMinutesSinceMidnight(local, { utcOffsetEnabled: false }),
    minutesSinceMidnight(local)
  );
});

test('effectiveMinutesSinceMidnight adds the configured offset to UTC time when enabled', () => {
  const utcNoon = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
  assert.strictEqual(
    effectiveMinutesSinceMidnight(utcNoon, { utcOffsetEnabled: true, utcOffsetMinutes: 90 }),
    12 * 60 + 90
  );
  assert.strictEqual(
    effectiveMinutesSinceMidnight(utcNoon, { utcOffsetEnabled: true, utcOffsetMinutes: 0 }),
    12 * 60
  );
});

test('effectiveMinutesSinceMidnight wraps past midnight when the offset pushes past 24:00', () => {
  const utcLateNight = new Date(Date.UTC(2026, 0, 1, 23, 0, 0)); // 23:00 UTC
  assert.strictEqual(
    effectiveMinutesSinceMidnight(utcLateNight, { utcOffsetEnabled: true, utcOffsetMinutes: 240 }),
    3 * 60 // 23:00 + 4:00 wraps to 03:00
  );
});

test('effectiveWatchScheme forces "simple-cycle" (Standard) when the UTC offset is enabled', () => {
  assert.strictEqual(
    effectiveWatchScheme({ utcOffsetEnabled: true, watchScheme: 'traditional' }),
    'simple-cycle'
  );
  assert.strictEqual(
    effectiveWatchScheme({ utcOffsetEnabled: false, watchScheme: 'traditional' }),
    'traditional'
  );
});

test('nightVolumeFactorForMoment clamps an out-of-range level to 0-100', () => {
  const inRange = new Date(2026, 0, 1, 23, 0, 0);
  assert.strictEqual(
    nightVolumeFactorForMoment(inRange, {
      nightVolumeEnabled: true,
      nightVolumeStart: '22:00',
      nightVolumeEnd: '06:00',
      nightVolumeLevel: 150
    }),
    1
  );
  assert.strictEqual(
    nightVolumeFactorForMoment(inRange, {
      nightVolumeEnabled: true,
      nightVolumeStart: '22:00',
      nightVolumeEnd: '06:00',
      nightVolumeLevel: -20
    }),
    0
  );
});

test('buildBellScheduleTable has 48 rows, one per half-hour mark, in order starting at 00:30', () => {
  const table = buildBellScheduleTable({ watchScheme: 'traditional' });
  assert.strictEqual(table.rows.length, 48);
  assert.strictEqual(table.rows[0].time, '00:30');
  assert.strictEqual(table.rows[47].time, '00:00'); // wraps: mark 1440 -> 00:00
  assert.strictEqual(table.usesUtc, false);
  assert.strictEqual(table.watchScheme, 'traditional');
});

test('buildBellScheduleTable groups rows into the seven traditional watches, midnight belonging to the First Watch', () => {
  const table = buildBellScheduleTable({ watchScheme: 'traditional' });
  const byTime = Object.fromEntries(table.rows.map((r) => [r.time, r]));

  assert.strictEqual(byTime['00:30'].watch, 'Middle Watch');
  assert.strictEqual(byTime['04:00'].watch, 'Middle Watch');
  assert.strictEqual(byTime['04:30'].watch, 'Morning Watch');
  assert.strictEqual(byTime['08:00'].watch, 'Morning Watch');
  assert.strictEqual(byTime['12:00'].watch, 'Forenoon Watch');
  assert.strictEqual(byTime['16:00'].watch, 'Afternoon Watch');
  assert.strictEqual(byTime['16:30'].watch, 'First Dog Watch');
  assert.strictEqual(byTime['18:00'].watch, 'First Dog Watch');
  assert.strictEqual(byTime['18:30'].watch, 'Last Dog Watch');
  assert.strictEqual(byTime['20:00'].watch, 'Last Dog Watch');
  assert.strictEqual(byTime['20:30'].watch, 'First Watch');
  assert.strictEqual(byTime['00:00'].watch, 'First Watch'); // midnight closes the First Watch
});

test('buildBellScheduleTable matches bellCountForMinutes exactly, per row, with no offset', () => {
  const table = buildBellScheduleTable({ watchScheme: 'traditional' });
  for (const row of table.rows) {
    const [h, m] = row.time.split(':').map(Number);
    const minutes = h * 60 + m;
    assert.strictEqual(row.bells, bellCountForMinutes(minutes, 'traditional'), `mismatch @ ${row.time}`);
  }
});

test('buildBellScheduleTable forces simple-cycle and shifts bell counts by the UTC offset when enabled', () => {
  const table = buildBellScheduleTable({
    watchScheme: 'traditional', // ignored -- offset forces simple-cycle
    utcOffsetEnabled: true,
    utcOffsetMinutes: 60
  });

  assert.strictEqual(table.usesUtc, true);
  assert.strictEqual(table.watchScheme, 'simple-cycle');

  const byTime = Object.fromEntries(table.rows.map((r) => [r.time, r]));
  // Row "00:30" is a UTC clock mark; shifted +60min it's effectively
  // 01:30 in the schedule, which simple-cycle counts as 3 bells.
  assert.strictEqual(byTime['00:30'].bells, bellCountForMinutes(90, 'simple-cycle'));
  assert.strictEqual(byTime['00:30'].bells, 3);
});

test('buildBellScheduleTable marks rows within quietHours as muted', () => {
  const table = buildBellScheduleTable({
    watchScheme: 'traditional',
    quietHoursEnabled: true,
    quietHoursStart: '22:00',
    quietHoursEnd: '06:00'
  });
  const byTime = Object.fromEntries(table.rows.map((r) => [r.time, r]));

  assert.strictEqual(byTime['22:00'].muted, true);
  assert.strictEqual(byTime['02:00'].muted, true);
  assert.strictEqual(byTime['05:30'].muted, true);
  assert.strictEqual(byTime['06:00'].muted, false); // exclusive end
  assert.strictEqual(byTime['12:00'].muted, false); // midday
  assert.strictEqual(byTime['22:00'].reducedVolume, false); // muted takes priority, not both
});

test('buildBellScheduleTable marks rows within nightVolume as reducedVolume, unless quietHours already muted them', () => {
  const table = buildBellScheduleTable({
    watchScheme: 'traditional',
    nightVolumeEnabled: true,
    nightVolumeStart: '20:00',
    nightVolumeEnd: '23:00'
  });
  const byTime = Object.fromEntries(table.rows.map((r) => [r.time, r]));

  assert.strictEqual(byTime['20:00'].reducedVolume, true);
  assert.strictEqual(byTime['22:30'].reducedVolume, true);
  assert.strictEqual(byTime['23:00'].reducedVolume, false); // exclusive end
  assert.strictEqual(byTime['12:00'].reducedVolume, false);
  assert.ok(table.rows.every((r) => r.muted === false));

  const overlapping = buildBellScheduleTable({
    watchScheme: 'traditional',
    quietHoursEnabled: true,
    quietHoursStart: '21:00',
    quietHoursEnd: '23:00',
    nightVolumeEnabled: true,
    nightVolumeStart: '20:00',
    nightVolumeEnd: '23:30'
  });
  const overlapByTime = Object.fromEntries(overlapping.rows.map((r) => [r.time, r]));
  // 20:00-21:00 is only in the night-volume window -> reduced.
  assert.strictEqual(overlapByTime['20:00'].reducedVolume, true);
  assert.strictEqual(overlapByTime['20:00'].muted, false);
  // 21:00-23:00 is in both -> muted wins, not double-flagged as reduced too.
  assert.strictEqual(overlapByTime['22:00'].muted, true);
  assert.strictEqual(overlapByTime['22:00'].reducedVolume, false);
  // 23:00-23:30 is only in the night-volume window again (quiet hours ended).
  assert.strictEqual(overlapByTime['23:00'].muted, false);
  assert.strictEqual(overlapByTime['23:00'].reducedVolume, true);
});

test('buildBellScheduleTable leaves muted/reducedVolume false everywhere when neither feature is enabled', () => {
  const table = buildBellScheduleTable({ watchScheme: 'traditional' });
  assert.ok(table.rows.every((r) => r.muted === false && r.reducedVolume === false));
});
