import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { environmentLabel, recordsOf, withRecords, type NavNode } from '../src/shell/nav.ts';
import {
	pageHits,
	recordFinder,
	recordScopes,
	recordMentions,
	searchRecords,
	searchScopes,
	scopeQuery,
	scopeSuggestions,
	scopedPages,
	manifestMatches,
	type FinderAnswer,
	type FinderRead
} from '../src/shell/finder/model.ts';

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

	it('one parser resolves explicit scopes, name collisions and multiword queries', () => {
		const scopes = searchScopes(
			nav,
			{
				sales: { record_label: 'record.name', label: ['name'], search: ['name'], fields: {} },
				customers: { record_label: 'record.name', label: ['name'], search: ['name'], fields: {} },
				ops: { record_label: 'record.name', label: ['name'], search: ['name'], fields: {} }
			},
			(key) => key
		);
		expect(scopeQuery(scopes, 'Acme')).toMatchObject({ explicit: false, scope: undefined });
		expect(scopeQuery(scopes, '/customers Acme & Sons')).toMatchObject({
			scope: { kind: 'model', model: 'customers' },
			query: 'Acme & Sons'
		});
		expect(scopeQuery(scopes, '/customers/Acme West')).toMatchObject({ query: 'Acme West' });
		expect(scopeQuery(scopes, '/unknown Acme').scope).toBeUndefined();
		expect(scopeSuggestions(scopes, 'customer').map((scope) => scope.command)).toEqual([
			'customers'
		]);
		const app = scopeQuery(scopes, '/app:sales quotes').scope;
		expect(app?.kind).toBe('app');
		if (app?.kind === 'app')
			expect(scopedPages(app, 'quotes').map((hit) => hit.label)).toEqual(['Quotes']);
		expect(scopeQuery(scopes, '/ops/jobs').scope).toBeUndefined();
		expect(scopeQuery(scopes, '/ops/jobs ').scope?.kind).toBe('app');
	});

	it.effect(
		'slash search and @ shorthand share reads; apps and unavailable scopes do not query records',
		() =>
			Effect.gen(function* () {
				const catalog = {
					customers: { record_label: 'record.name', label: ['name'], search: ['name'], fields: {} },
					notes: { record_label: 'record.title', label: ['title'], fields: {} }
				};
				const requests: Parameters<FinderRead>[0][] = [];
				const read: FinderRead = (request) =>
					Effect.sync(() => {
						requests.push(request);
						return { customers: { rows: [{ id: 'c1', name: 'Acme [West]' }] } };
					});
				const at = yield* recordMentions(catalog, read, '/customers Acme West', (key) => key);
				const slash = yield* recordMentions(catalog, read, 'customers Acme West', (key) => key, {
					prefix: '/'
				});
				expect(slash).toEqual(at);
				expect(at[1]?.insert).toBe('[@Acme \\[West\\]](customers/c1) ');
				expect(requests).toHaveLength(2);
				expect(requests[0]).toEqual(requests[1]);
				expect(
					(yield* recordMentions(catalog, read, 'cust', (key) => key, { prefix: '/' }))[0]?.drill
						?.insert
				).toBe('/customers ');
				expect(
					(yield* recordMentions(catalog, read, 'sales', (key) => key, { nav }))[0]?.insert
				).toBe('[@Sales](/app/sales/deals) ');
				yield* recordMentions(catalog, read, 'notes whatever', (key) => key, { nav });
				yield* recordMentions(catalog, read, 'missing whatever', (key) => key, { nav });
				expect(requests).toHaveLength(2);
			})
	);

	it.effect('searches only the selected model, labels rows and drops a stale answer', () =>
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
					customers: {
						record_label:
							"[record.name != null ? string(record.name) : '', record.code != null ? string(record.code) : ''].filter(part, part != '').join(' · ')",
						label: ['name', 'code'],
						search: ['name'],
						fields: {}
					},
					notes: { record_label: 'record.name', label: ['name'], fields: {} }
				},
				read,
				(key) => key
			);
			const first = yield* finder.search('customers', 'ac').pipe(Effect.forkScoped);
			yield* Effect.yieldNow;
			const second = yield* finder.search('customers', 'acme').pipe(Effect.forkScoped);
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
			expect(yield* finder.search('customers', '  ')).toEqual([]);
		})
	);
	it.effect('shares declared scopes and record search with mentions, without label fallback', () =>
		Effect.gen(function* () {
			const catalog = {
				customers: {
					record_label: 'record.name',
					label: ['name'],
					search: ['name', 'code'],
					output: 'directory',
					fields: {
						name: { kind: 'text' as const, label: 'Customer name' },
						code: { kind: 'text' as const }
					}
				},
				notes: { record_label: 'record.name', label: ['name'], fields: {} },
				articles: {
					record_label: 'record.name',
					label: ['name'],
					semantic: true as const,
					fields: {}
				}
			};
			const requests: Parameters<FinderRead>[0][] = [];
			const read: FinderRead = (request) =>
				Effect.sync(() => {
					requests.push(request);
					return { customers: { rows: [{ id: 'c1', name: 'Acme' }] } };
				});
			const scopes = recordScopes(catalog, (key) => key);
			expect(scopes.find((scope) => scope.model === 'customers')?.description).toBe(
				'Search by Customer name, code.'
			);
			expect(scopes.find((scope) => scope.model === 'notes')).toMatchObject({
				searchable: false,
				description: 'Search is not enabled for this model. No search index is declared.'
			});
			for (const model of [null, 'notes', 'missing'])
				expect(yield* searchRecords(catalog, read, model, 'Acme', (key) => key)).toEqual([]);
			const models = yield* recordMentions(catalog, read, '', (key) => key);
			expect(models.find((item) => item.id === 'notes')).toMatchObject({
				insert: '[@notes](/?find=notes) '
			});
			expect(models.find((item) => item.id === 'notes')?.drill).toBeUndefined();
			expect(yield* recordMentions(catalog, read, 'notes/Acme', (key) => key)).toHaveLength(1);
			expect(requests).toEqual([]);
			const direct = yield* searchRecords(catalog, read, 'customers', 'Acme', (key) => key);
			const mentions = yield* recordMentions(catalog, read, 'customers/Acme', (key) => key);
			expect(mentions[1]).toMatchObject({
				label: direct[0]?.label,
				insert: '[@Acme](customers/c1) '
			});
			expect(requests).toEqual(
				Array.from({ length: 2 }, () => ({
					customers: { search: 'Acme', limit: 8, output: 'directory', fields: ['name'] }
				}))
			);
			yield* searchRecords(catalog, read, 'articles', 'meaning', (key) => key);
			expect(requests.at(-1)).toEqual({
				articles: { search: '/semantic meaning', limit: 8, output: 'default', fields: ['name'] }
			});
		})
	);
	it.effect(
		'plain manifest names match the same entries and pages in Find and Norbius without reading records',
		() =>
			Effect.gen(function* () {
				const entries = [
					{
						kind: 'automation' as const,
						name: 'manufacturing_pipeline',
						description: 'Prepare production',
						href: '/command-center/automations?automation=manufacturing_pipeline'
					}
				];
				const catalog = {
					customers: { record_label: 'record.name', label: ['name'], search: ['name'], fields: {} }
				};
				const scopes = searchScopes(nav, catalog, (key) => key, entries);
				const described = nav.map((node) =>
					node.kind === 'app' ? { ...node, description: 'Customers and quotes' } : node
				);
				const describedScopes = searchScopes(described, catalog, (key) => key, entries);
				expect(
					manifestMatches(described, describedScopes, 'customers', (key) => key)[0]
				).toMatchObject({ kind: 'scope', scope: { kind: 'model', model: 'customers' } });
				expect(
					manifestMatches(described, describedScopes, 'Quotes', (key) => key)[0]
				).toMatchObject({ kind: 'page', label: 'Quotes' });
				expect(
					scopeSuggestions(scopes, 'manufacturing pipeline').map((scope) => scope.kind)
				).toEqual(['automation']);
				expect(scopeSuggestions(scopes, 'customers')[0]?.kind).toBe('model');
				const read: FinderRead = () => Effect.die('Manifest discovery cannot read records');
				const matches = yield* recordMentions(
					catalog,
					read,
					'manufacturing pipeline',
					(key) => key,
					{ nav, entries }
				);
				expect(matches[0]?.insert).toBe(
					'[@manufacturing pipeline](/command-center/automations?automation=manufacturing_pipeline) '
				);
				const pages = yield* recordMentions(catalog, read, 'quotes', (key) => key, {
					nav,
					entries
				});
				expect(pages[0]?.insert).toBe('[@Quotes](/app/sales/quotes) ');
			})
	);
});
