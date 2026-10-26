import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { StudioInspectInput, StudioInspection } from '../src/shell/studio/inspection.ts';

const inspection: StudioInspection = {
	canInspect: false,
	asOf: '2026-10-26T08:00:00.000Z',
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
				view: 'activity',
				build: 'a'.repeat(40),
				run: 'run-1',
				level: 'warn',
				text: 'timeout'
			})
		).toMatchObject({ range: '24h', view: 'activity', run: 'run-1', level: 'warn' });
	});
	it.each([
		{ range: 'forever', view: 'resources' },
		{ range: '7d', view: 'source' },
		{ range: '7d', view: 'logs', level: 'debug' },
		{ range: '7d', view: 'logs', run: 'x'.repeat(201) },
		{ range: '7d', view: 'logs', text: 'x'.repeat(201) },
		{ range: '7d', view: 'activity', build: 'a'.repeat(65) }
	])('refuses unsupported or oversized scopes: %o', (input) => {
		expect(() => Schema.decodeUnknownSync(StudioInspectInput)(input)).toThrow();
	});
	it('does not infer an administrator capability from member inventory', () => {
		const native = Schema.decodeUnknownSync(StudioInspection)({ ...inspection, canInspect: true, members: null, errors: null });
		expect(native.canInspect).toBe(true);
		expect(native.members).toBeNull();
		expect(() => Schema.decodeUnknownSync(StudioInspection)({ ...inspection, canInspect: undefined })).toThrow();
	});
	it('keeps unknown gauges distinct from measured zero', () => {
		const decoded = Schema.decodeUnknownSync(StudioInspection)(inspection);
		expect(decoded.usage[0]?.lines[0]?.points.map((point) => point.value)).toEqual([null, 0]);
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
