// The shell's pure parts restored for 0.0.1: every framework string in zh (L-BOLT-535, 619, 765), the environment
// badge label (L-BOLT-513), the record-sheet URL stack (L-BOLT-514), and the finder's page matches and stale-answer
// drop (L-BOLT-497, 512).
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { SHELL_ZH } from '../src/shell/i18n.ts';
import { environmentLabel, recordsOf, withRecords, type NavNode } from '../src/shell/nav.ts';
import {
	pageHits,
	recordFinder,
	type FinderAnswer,
	type FinderRead
} from '../src/shell/finder/model.ts';

const SHELL = new URL('../src/shell/', import.meta.url);
/** Keys the shell passes through `t` as values, not literals (statuses, ops, tables, section titles). */
const DYNAMIC = [
	'queued',
	'running',
	'succeeded',
	'failed',
	'stopped',
	'skipped',
	'open',
	'accepted',
	'revoked',
	'expired',
	'create',
	'update',
	'delete',
	'member',
	'invitation',
	'Progress',
	'Input',
	'Result',
	'Collapse navigation',
	'Expand navigation',
	'steps',
	'This invitation is accepted.',
	'This invitation is revoked.',
	'This invitation is expired.'
];

describe('framework catalogs', () => {
	it('every string the shell translates has its zh text', () => {
		const keys = new Set(DYNAMIC);
		for (const f of [
			...readdirSync(SHELL),
			...readdirSync(new URL('integration/', SHELL)).map((n) => `integration/${n}`)
		].filter((n) => n.endsWith('.svelte') || n === 'model.ts')) {
			const src = readFileSync(new URL(f, SHELL), 'utf8');
			for (const m of src.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)+)\1/g))
				keys.add(m[2]!.replace(/\\'/g, "'"));
			for (const m of src.matchAll(/\b(?:leaf|group)\('[^']+', '([^']+)'/g)) keys.add(m[1]!);
			// literal maps whose values reach `t`: Settings' TITLES, Studio's SECTION_TITLES
			for (const map of src.matchAll(/const (?:TITLES|SECTION_TITLES)\b[^=]*=\s*\{([\s\S]*?)\};/g))
				for (const v of map[1]!.matchAll(/:\s*'((?:\\.|[^'])+)'/g))
					keys.add(v[1]!.replace(/\\'/g, "'"));
		}
		expect([...keys].filter((k) => SHELL_ZH[k] === undefined)).toEqual([]);
	});
});

describe('environment badge', () => {
	it('hides production and an unset environment, reads development as local, shows any other name', () => {
		expect(
			[undefined, '', ' production ', 'development', 'staging', 'preview-7'].map(environmentLabel)
		).toEqual([null, null, null, 'local', 'staging', 'preview-7']);
	});
});

describe('record-sheet stack', () => {
	it('reads every ?record= in order and closes a sheet with those above it', () => {
		const url = new URL(
			'https://x.example/app/sales?tab=1&record=orders/o1&record=bad&record=customers/c9'
		);
		expect(recordsOf(url)).toEqual([
			{ model: 'orders', id: 'o1' },
			{ model: 'customers', id: 'c9' }
		]);
		const closed = withRecords(url, 1);
		expect(closed.searchParams.getAll('record')).toEqual(['orders/o1']);
		expect(closed.searchParams.get('tab')).toBe('1');
		expect(withRecords(url, 0).searchParams.has('record')).toBe(false);
	});
});

describe('finder', () => {
	const nav: NavNode[] = [
		{
			kind: 'app',
			name: 'sales',
			title: 'Sales',
			description: '',
			icon: 'i',
			href: '/app/sales/deals',
			pages: [
				{ name: 'deals', title: 'Deals', href: '/app/sales/deals' },
				{ name: 'quotes', title: 'Quotes', href: '/app/sales/quotes' }
			]
		},
		{
			kind: 'group',
			name: 'ops',
			title: 'Operations',
			icon: 'i',
			href: '/app/ops/jobs',
			children: [
				{
					kind: 'app',
					name: 'ops/jobs',
					title: 'Jobs',
					description: '',
					icon: 'i',
					href: '/app/ops/jobs/board',
					pages: [{ name: 'board', title: 'Board', href: '/app/ops/jobs/board' }]
				}
			]
		}
	];
	it('matches pages by their title or their app’s, case-insensitively', () => {
		expect(pageHits(nav, 'quo', (k) => k).map((h) => h.label)).toEqual(['Quotes']);
		expect(pageHits(nav, 'SALES', (k) => k).map((h) => h.label)).toEqual(['Deals', 'Quotes']);
		expect(pageHits(nav, 'jobs', (k) => k)).toMatchObject([
			{ label: 'Jobs', context: 'Operations', href: '/app/ops/jobs/board' }
		]);
	});

	it.effect('searches every searchable model, labels rows and drops a stale answer', () =>
		Effect.gen(function* () {
			const pending: (() => void)[] = [];
			// one read request per searchable root: `{ <model>: { search, limit } }`, answered under that root
			const read: FinderRead = (request) =>
				Effect.callback<FinderAnswer>((resume) => {
					const [model = '', layer] = Object.entries(request)[0] ?? [];
					const search = layer?.['search'] ?? '';
					pending.push(() =>
						resume(
							Effect.succeed({
								[model]: {
									rows: [{ id: `${model}-1`, name: `hit ${String(search)}`, code: 'C1' }]
								}
							})
						)
					);
				});
			const finder = yield* recordFinder(
				{
					customers: { label: ['name', 'code'], search: ['name'], fields: {} },
					notes: { label: ['name'], fields: {} }
				},
				read,
				(key) => key
			);
			expect(finder.models).toEqual(['customers']);
			const first = yield* finder.search('ac').pipe(Effect.forkScoped);
			yield* Effect.yieldNow;
			const second = yield* finder.search('acme').pipe(Effect.forkScoped);
			yield* Effect.yieldNow;
			for (const finish of pending) finish();
			expect(yield* Fiber.join(first)).toBeNull();
			expect(yield* Fiber.join(second)).toEqual([
				{
					kind: 'record',
					key: 'customers/customers-1',
					label: 'hit acme · C1',
					context: 'customers',
					model: 'customers',
					id: 'customers-1'
				}
			]);
			expect(yield* finder.search('  ')).toEqual([]);
		})
	);
});
