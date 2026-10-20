import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { permitsImport, resolveImportStart } from '../src/engine/integrations/import-start.ts';
import type { ImportStart } from '../src/protocol/instance-status.ts';

const NOW = Date.parse('2026-10-21T01:40:12.345Z');

describe('an integration import start', () => {
	it.effect('retains the full-history and provider-native choices', () =>
		Effect.gen(function* () {
			expect(yield* resolveImportStart({ kind: 'all' }, NOW)).toEqual({ kind: 'all' });
			const native = {
				kind: 'native',
				provider: 'archive',
				values: { mailbox: 'INBOX', checkpoint: 'opaque:2026/10+21=' }
			} as const;
			expect(yield* resolveImportStart(native, NOW)).toEqual({
				...native,
				selectedAt: '2026-10-21T01:40:12.345Z'
			});
		})
	);

	it.effect(
		'captures the supplied instant for now, including its milliseconds and chosen zone',
		() =>
			Effect.gen(function* () {
				expect(yield* resolveImportStart({ kind: 'now', zone: 'Asia/Seoul' }, NOW)).toEqual({
					kind: 'since',
					at: '2026-10-21T01:40:12.345Z',
					zone: 'Asia/Seoul',
					origin: 'now'
				});
			})
	);

	it.effect(
		'persists now at the beginning of the second when the provider declares second precision',
		() =>
			Effect.gen(function* () {
				const start = yield* resolveImportStart(
					{ kind: 'now', zone: 'UTC' },
					Date.parse('2026-10-21T00:00:00.800Z'),
					'second'
				);
				expect(start).toEqual({
					kind: 'since',
					at: '2026-10-21T00:00:00.000Z',
					zone: 'UTC',
					origin: 'now'
				});
				expect(permitsImport(start, '2026-10-21T00:00:00.000Z')).toBe(true);
				expect(permitsImport(start, '2026-10-21T00:00:01.000Z')).toBe(true);
				expect(permitsImport(start, '2026-10-20T23:59:59.999Z')).toBe(false);
			})
	);

	it.effect('keeps now exact when the provider declares no timestamp precision', () =>
		Effect.gen(function* () {
			const start = yield* resolveImportStart(
				{ kind: 'now', zone: 'UTC' },
				Date.parse('2026-10-21T00:00:00.800Z')
			);
			expect(start).toEqual({
				kind: 'since',
				at: '2026-10-21T00:00:00.800Z',
				zone: 'UTC',
				origin: 'now'
			});
			expect(permitsImport(start, '2026-10-21T00:00:00.000Z')).toBe(false);
			expect(permitsImport(start, '2026-10-21T00:00:00.800Z')).toBe(true);
		})
	);

	it.effect('keeps date choices exact even when the provider declares second precision', () =>
		Effect.gen(function* () {
			const start = yield* resolveImportStart(
				{ kind: 'since', date: '2026-10-21', zone: 'UTC' },
				NOW,
				'second'
			);
			expect(start).toEqual({
				kind: 'since',
				at: '2026-10-21T00:00:00.000Z',
				zone: 'UTC',
				origin: 'date'
			});
			expect(permitsImport(start, '2026-10-20T23:59:59.999Z')).toBe(false);
		})
	);

	it.effect('begins a selected date at midnight in its zone rather than UTC', () =>
		Effect.gen(function* () {
			expect(
				yield* resolveImportStart({ kind: 'since', date: '2026-10-21', zone: 'Asia/Seoul' }, NOW)
			).toEqual({
				kind: 'since',
				at: '2026-10-20T15:00:00.000Z',
				zone: 'Asia/Seoul',
				origin: 'date'
			});
			expect(
				yield* resolveImportStart(
					{ kind: 'since', date: '2026-10-21', zone: 'Asia/Singapore' },
					NOW
				)
			).toMatchObject({ at: '2026-10-20T16:00:00.000Z' });
			expect(
				yield* resolveImportStart({ kind: 'since', date: '2024-02-29', zone: 'UTC' }, NOW)
			).toMatchObject({ at: '2024-02-29T00:00:00.000Z' });
		})
	);

	it.effect('uses the offset at the beginning of a daylight saving transition date', () =>
		Effect.gen(function* () {
			for (const [date, at] of [
				['2026-03-08', '2026-03-08T05:00:00.000Z'],
				['2026-11-01', '2026-11-01T04:00:00.000Z']
			] as const)
				expect(
					yield* resolveImportStart({ kind: 'since', date, zone: 'America/New_York' }, NOW)
				).toMatchObject({ at });
		})
	);

	it.effect('starts an existing date whose midnight is skipped at its first valid instant', () =>
		Effect.gen(function* () {
			expect(
				yield* resolveImportStart(
					{ kind: 'since', date: '2018-11-04', zone: 'America/Sao_Paulo' },
					NOW
				)
			).toMatchObject({ at: '2018-11-04T03:00:00.000Z' });
		})
	);

	it.effect('refuses malformed or impossible dates instead of rolling into another day', () =>
		Effect.gen(function* () {
			for (const date of [
				'',
				'2026-1-2',
				'2026-10-21T00:00:00Z',
				'2026-02-29',
				'2026-04-31',
				'2026-13-01',
				'2026-00-01',
				'2026-01-00'
			])
				expect(
					yield* resolveImportStart({ kind: 'since', date, zone: 'UTC' }, NOW).pipe(Effect.flip),
					date
				).toMatchObject({ code: 'invalidInput' });
		})
	);

	it.effect('refuses an entire civil day removed from its timezone', () =>
		Effect.gen(function* () {
			expect(
				yield* resolveImportStart(
					{ kind: 'since', date: '2011-12-30', zone: 'Pacific/Apia' },
					NOW
				).pipe(Effect.flip)
			).toMatchObject({ code: 'invalidInput' });
		})
	);

	it.effect('refuses an unknown timezone for both now and a selected date', () =>
		Effect.gen(function* () {
			for (const zone of ['', 'Not/A_Real_Zone']) {
				expect(
					yield* resolveImportStart({ kind: 'now', zone }, NOW).pipe(Effect.flip)
				).toMatchObject({ code: 'invalidInput' });
				expect(
					yield* resolveImportStart({ kind: 'since', date: '2026-10-21', zone }, NOW).pipe(
						Effect.flip
					)
				).toMatchObject({ code: 'invalidInput' });
			}
		})
	);
});

describe('admission at an import start', () => {
	const start: ImportStart = {
		kind: 'since',
		at: '2026-10-20T15:00:00.000Z',
		zone: 'Asia/Seoul',
		origin: 'date'
	};

	it('compares instants inclusively, regardless of the timestamp offset', () => {
		expect(permitsImport(start, '2026-10-20T14:59:59.999Z')).toBe(false);
		expect(permitsImport(start, '2026-10-20T15:00:00.000Z')).toBe(true);
		expect(permitsImport(start, '2026-10-21T00:00:00+09:00')).toBe(true);
		expect(permitsImport(start, '2026-10-21T00:00:00.001+09:00')).toBe(true);
	});

	it('does not admit missing or unreadable timestamps through a date boundary', () => {
		for (const at of [undefined, '', 'not an instant'])
			expect(permitsImport(start, at)).toBe(false);
	});

	it('keeps legacy, full-history, and provider-native admission without a standard date boundary', () => {
		const native: ImportStart = {
			kind: 'native',
			provider: 'archive',
			values: { checkpoint: 'opaque' },
			selectedAt: '2026-10-21T01:40:12.345Z'
		};
		for (const choice of [undefined, null, { kind: 'all' }, native] as const) {
			expect(permitsImport(choice, '1999-01-01T00:00:00.000Z')).toBe(true);
			expect(permitsImport(choice, undefined)).toBe(true);
		}
	});
});
