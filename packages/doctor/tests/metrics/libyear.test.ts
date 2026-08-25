/**
 * libyear against an injected registry and a fixed `now` (2026-01-01T00:00:00Z).
 *
 * Dates were chosen so ages land on exact multiples of the 365.25-day year: 2022-01-01 is
 * precisely 1461 days back (four year-units), 2024-01-01T12:00 is two units back, and
 * 2024-12-31T18:00 is 365.25 days back (365 leap-free days plus a six-hour quarter day).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeLibyear, parseRange } from '../../build/metrics/index.js';
import type { LibyearManifest } from '../../build/metrics/index.js';

const NOW = new Date('2026-01-01T00:00:00Z');

const RELEASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	alpha: { '^2.0.0': '2022-01-01T00:00:00Z', latest: '2024-01-01T12:00:00Z' },
	'aaa-pkg': { '~1.5.0': '2024-01-01T12:00:00Z', latest: '2024-12-31T18:00:00Z' },
	// Resolvable, but the installed pin has no known release date.
	delta: { latest: '2025-01-01T00:00:00Z' }
};

const resolve = async (pkg: string) => {
	if (pkg === 'gamma') return undefined;
	const releases = RELEASES[pkg];
	return { releaseDateOf: (version: string) => releases?.[version] };
};

test('rows sort by name, duplicates collapse, contributions subtract ages', async () => {
	const manifests: ReadonlyArray<LibyearManifest> = [
		{
			name: 'app',
			dependencies: { alpha: '^2.0.0', beta: '^9.9.9' },
			devDependencies: { gamma: '*', 'aaa-pkg': '~1.5.0' }
		},
		// Same pin again in another workspace — one row, not two.
		{ name: 'lib', dependencies: { alpha: '^2.0.0' } }
	];
	const report = await computeLibyear(manifests, resolve, NOW);
	assert.deepEqual(report.rows, [
		{ pkg: 'aaa-pkg', current: '~1.5.0', latest: '2024-12-31T18:00:00Z', libyears: 1 },
		{ pkg: 'alpha', current: '^2.0.0', latest: '2024-01-01T12:00:00Z', libyears: 2 }
	]);
	assert.ok(Math.abs(report.totals.libyears - 3) < 1e-12);
	assert.equal(report.totals.stalest, 'alpha');
});

test('unmeasurable packages are tolerated silently', async () => {
	const manifests: ReadonlyArray<LibyearManifest> = [
		{
			name: 'app',
			dependencies: {
				gamma: '^1.0.0', // resolver knows nothing of it
				beta: '^2.0.0', // resolvable, but no dates at all
				delta: '=0.8.1' // latest dated, installed pin not
			}
		}
	];
	const report = await computeLibyear(manifests, resolve, NOW);
	assert.deepEqual(report.rows, []);
	assert.equal(report.totals.libyears, 0);
	assert.equal(report.totals.stalest, null);
});

test('parseRange reduces specifiers to their base version', () => {
	assert.equal(parseRange('^1.2.3'), '1.2.3');
	assert.equal(parseRange('~2.0.0-beta.1'), '2.0.0');
	assert.equal(parseRange('>=3.4.5'), '3.4.5');
	assert.equal(parseRange('=4.0.0'), '4.0.0');
	assert.equal(parseRange('v5.1.0'), '5.1.0');
	assert.equal(parseRange('6.0.0-rc.1+build.7'), '6.0.0');
	assert.equal(parseRange('>= 7.2'), '7.2');
	assert.equal(parseRange('*'), undefined);
	assert.equal(parseRange(''), undefined);
});
