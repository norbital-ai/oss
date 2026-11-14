import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { StudioInspectInput, StudioInspection } from '@norbital-ai/host-api';

const inspection: StudioInspection = {
	can_inspect: false,
	as_of: '2026-10-26T08:00:00.000Z',
	usage: [
		{
			title: 'Memory held',
			unit: 'MiB',
			lines: [
				{
					label: 'Memory held',
					bound: false,
					points: [
						{ at: 0, value: null },
						{ at: 1, value: 0 }
					]
				}
			],
			utilization: null
		}
	],
	members: null,
	studio: null,
	logs: null,
	bundles: null,
	cache: null,
	errors: {
		access: 'Not an administrator.',
		studio: null,
		logs: null,
		bundles: null,
		cache: null,
		build: null
	},
	filters: { level: null, text: '', run: '', build: null }
};

describe('Studio operational inspection boundary', () => {
	it('accepts the bounded scope used by both Studio and Realm', () => {
		expect(
			Schema.decodeUnknownSync(StudioInspectInput)({
				range: '24h',
				view: 'bundle',
				build: 'a'.repeat(40),
				run: 'run-1',
				level: 'warn',
				text: 'timeout'
			})
		).toMatchObject({ range: '24h', view: 'bundle', run: 'run-1', level: 'warn' });
	});
	it.each([
		{ range: 'forever', view: 'telemetry' },
		{ range: '7d', view: 'source' },
		{ range: '7d', view: 'logs', level: 'debug' },
		{ range: '7d', view: 'logs', run: 'x'.repeat(201) },
		{ range: '7d', view: 'logs', text: 'x'.repeat(201) },
		{ range: '7d', view: 'bundle', build: 'a'.repeat(65) }
	])('refuses unsupported or oversized scopes: %o', (input) => {
		expect(() => Schema.decodeUnknownSync(StudioInspectInput)(input)).toThrow();
	});
	it('does not infer an administrator capability from member inventory', () => {
		const native = Schema.decodeUnknownSync(StudioInspection)({
			...inspection,
			can_inspect: true,
			members: null,
			errors: null
		});
		expect(native.can_inspect).toBe(true);
		expect(native.members).toBeNull();
		expect(() =>
			Schema.decodeUnknownSync(StudioInspection)({ ...inspection, can_inspect: undefined })
		).toThrow();
	});
	it('keeps unknown gauges distinct from measured zero', () => {
		const decoded = Schema.decodeUnknownSync(StudioInspection)(inspection);
		expect(decoded.usage[0]?.lines[0]?.points.map((point) => point.value)).toEqual([null, 0]);
	});
	it('carries a selected build log and diagnostics through the curated inspection boundary', () => {
		const build = { commit: 'c1', at: '2026-10-26T08:00:00Z', status: 'failed', message: 'Build rejected', deployed: false, live: false, lines: 1, diagnostics: 1 } as const;
		const log = [{ at: build.at, level: 'error', message: 'Invalid model field' }] as const;
		const diagnostics = [{ code: 'model/field', path: 'src/data/model/order/+model.ts', line: 3, message: 'Unknown field', help: 'Declare the field.', severity: 'error' }] as const;
		const snapshot: StudioInspection = { ...inspection, can_inspect: true, errors: null,
			studio: { commit: 'c0', message: 'Current live version', builds: [build], releases: [], environments: [], changes: [], log: [], diagnostics: [], build: { build, log, diagnostics } },
			filters: { level: null, text: '', run: '', build: 'c1' }
		};
		expect(Schema.decodeUnknownSync(StudioInspection)(snapshot, { onExcessProperty: 'error' })).toEqual(snapshot);
		expect(() => Schema.decodeUnknownSync(StudioInspection)({ ...snapshot, studio: { ...snapshot.studio, build: { build, log: {}, diagnostics } } })).toThrow();
	});
	it('refuses an invalid inspection payload before the shared UI consumes it', () => {
		expect(() =>
			Schema.decodeUnknownSync(StudioInspection)({ ...inspection, members: [{ id: 'u' }] })
		).toThrow();
		expect(() =>
			Schema.decodeUnknownSync(StudioInspection)({
				...inspection,
				usage: [{ title: 'Bad', unit: 'bytes', lines: [], utilization: Infinity }]
			})
		).toThrow();
	});
});
