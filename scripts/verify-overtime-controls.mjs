import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vite = await createServer({
	root,
	appType: 'custom',
	logLevel: 'silent',
	server: { middlewareMode: true }
});

try {
	const { classifyOvertimeByCalendarMonth, priceDay } = await vite.ssrLoadModule(
		'/src/collections/payroll_runs/lib/overtime.ts'
	);

	const day = (date, hours, totalWorkHours, dayType = 'ORDINARY') => ({
		date,
		timeEntryId: `time:${date}`,
		dayType,
		hours,
		normalHours: 8.5,
		totalWorkHours
	});

	const elevenHours = classifyOvertimeByCalendarMonth({
		days: [day('2026-01-06', 2.5, 11)],
		dailyWorkLimit: 12,
		monthlyOrdinaryOvertimeLimit: 104
	})[0];
	assert.equal(elevenHours.retainedHours, 2.5);
	assert.equal(elevenHours.excessHours, 0);

	const thirteenHours = classifyOvertimeByCalendarMonth({
		days: [day('2026-01-06', 4.5, 13)],
		dailyWorkLimit: 12,
		monthlyOrdinaryOvertimeLimit: 104
	})[0];
	assert.equal(thirteenHours.retainedHours, 3.5);
	assert.equal(thirteenHours.excessHours, 1);

	const flooredDailySurplus = classifyOvertimeByCalendarMonth({
		days: [day('2026-01-06', 4, 12.9)],
		dailyWorkLimit: 12,
		monthlyOrdinaryOvertimeLimit: 104
	})[0];
	assert.equal(flooredDailySurplus.retainedHours, 3.5);
	assert.equal(flooredDailySurplus.excessHours, 0.5);

	const monthly = classifyOvertimeByCalendarMonth({
		days: [
			day('2026-01-01', 100, 108.5),
			day('2026-01-02', 10, 10, 'REST_DAY'),
			day('2026-01-03', 10, 10, 'PUBLIC_HOLIDAY'),
			day('2026-01-31', 6, 14.5),
			day('2026-02-01', 6, 14.5)
		],
		dailyWorkLimit: null,
		monthlyOrdinaryOvertimeLimit: 104
	});
	assert.deepEqual(
		monthly.map(({ retainedHours, excessHours }) => ({ retainedHours, excessHours })),
		[
			{ retainedHours: 100, excessHours: 0 },
			{ retainedHours: 10, excessHours: 0 },
			{ retainedHours: 10, excessHours: 0 },
			{ retainedHours: 4, excessHours: 2 },
			{ retainedHours: 6, excessHours: 0 }
		]
	);

	const ordinaryRule = {
		norbital_id: 'ordinary-1.5',
		authority: 'EA 1955 s.60A(3)(a)',
		day_type: 'ORDINARY',
		band: {
			measure: 'BEYOND_NORMAL',
			from_hours: 0,
			to_hours: null,
			from_fraction: 0,
			to_fraction: null
		},
		award: { kind: 'HOURLY_MULTIPLE', multiple: 1.5 }
	};
	const priced = priceDay({
		day: day('2026-01-06', 4.5, 13),
		rules: [ordinaryRule],
		retainedHours: 3.5
	});
	assert.equal(
		priced.segments.reduce((sum, row) => sum + row.hours, 0),
		3.5
	);
	assert.deepEqual(
		priced.excess.map(({ hours, units, valuedAt }) => ({ hours, units, valuedAt })),
		[{ hours: 1, units: 1.5, valuedAt: 'ORDINARY_HOURLY' }]
	);

	console.log('Overtime controls verified: 5 checks passed.');
} finally {
	await vite.close();
}
