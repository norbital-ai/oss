import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Schema } from 'effect';
import { read } from '@norbital-ai/store';
import { catalog } from '../src/protocol/catalog.ts';
import { fromStore } from '../src/protocol/errors.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { GuestShape } from '../src/engine/services.ts';
import { act } from '../src/engine/write/act.ts';
import { admin, manifest as base, NOW, TODAY } from './write-fixture.ts';
import { bridgeOn, open } from './write-p2.fixture.ts';

const manifest: EngineManifest = {
	...base,
	models: {
		...base.models,
		sources: {
			description: 'A source',
			label: 'reference',
			fields: { reference: { kind: 'text' } }
		},
		accounts: {
			description: 'A ledger account',
			label: 'code',
			search: { text: ['code'] },
			fields: {
				code: { kind: 'text' },
				state: {
					kind: 'state',
					initial: 'DRAFT',
					states: { DRAFT: { to: ['PAID'] }, PAID: { to: [], edit: 'all' } }
				},
				number: { kind: 'seq', pattern: 'A-{0000}' },
				amount: { kind: 'sum', of: 'entries.amount' },
				movements: { kind: 'count', of: 'entries' }
			},
			computed: { upper_code: { kind: 'text', expr: { upper: { field: 'code' } } } }
		},
		entries: {
			description: 'An immutable movement',
			label: 'memo',
			fields: { memo: { kind: 'text' }, amount: { kind: 'decimal', scale: 2 } },
			computed: { upper_memo: { kind: 'text', expr: { upper: { field: 'memo' } } } }
		}
	},
	relationships: {
		...base.relationships,
		'accounts.source_id': { to: 'sources', inverse: 'accounts', owned: true },
		'entries.account_id': { to: 'accounts', inverse: 'entries', owned: true },
		'entries.resolved_account_id': { to: 'accounts', optional: true }
	},
	exposures: {
		...base.exposures,
		sources: {
			read: { sources: { fields: 'all' } },
			create: {
				columns: {
					sources: ['reference'],
					'sources.accounts': ['code'],
					'sources.accounts.entries': ['memo', 'amount']
				}
			}
		},
		accounts: {
			read: { accounts: { fields: 'all' }, 'accounts.entries': { fields: 'all' } },
			create: {
				columns: { accounts: ['code', 'source_id'], 'accounts.entries': ['memo', 'amount'] }
			},
			update: { columns: { accounts: ['state'], 'accounts.entries': ['memo', 'amount'] } }
		},
		entries: {
			read: { entries: { fields: 'all' } },
			create: { columns: { entries: ['memo', 'amount', 'account_id'] }, transform: true }
		}
	}
};
const Row = Schema.Record(Schema.String, Schema.Json);
const Rows = Schema.Array(Row);
const Identity = Schema.Struct({ id: Schema.String, code: Schema.String });
const Page = Schema.Struct({ rows: Schema.Array(Identity), next: Schema.NullOr(Schema.String) });
type Mode =
	| 'identity'
	| 'unread'
	| 'sum'
	| 'count'
	| 'sequence'
	| 'computed'
	| 'filter'
	| 'operand'
	| 'order'
	| 'nested'
	| 'nested_filter'
	| 'search'
	| 'label'
	| 'nested_identity'
	| 'related_filter';

const fixture = Effect.gen(function* () {
	const { db } = yield* open(manifest),
		cat = catalog(manifest),
		observed: string[] = [],
		failures: string[] = [];
	let serial = 0;
	const run = (mode: Mode, code: string, gate?: () => Effect.Effect<void>, existing?: string) => {
		const guest: GuestShape = {
			invokeProgram: () => Effect.die('The fixture invokes native callbacks only.'),
			invoke: (inv, bridge) =>
				Effect.gen(function* () {
					const rows = yield* Schema.decodeUnknownEffect(Rows)(inv.input).pipe(Effect.orDie);
					const query = yield* read(
						cat,
						mode === 'unread'
							? 'sources'
							: mode === 'label'
								? 'approval_request'
								: mode === 'related_filter'
									? 'entries'
									: 'accounts',
						{
							all: true,
							select:
								mode === 'related_filter'
									? { memo: true, account_id: true }
									: mode === 'label'
										? { record_id: true }
										: mode === 'nested_identity'
											? { code: true, entries: { all: true, select: { memo: true } } }
											: mode === 'unread'
												? { reference: true }
												: mode === 'sum'
													? { amount: true }
													: mode === 'count'
														? { movements: true }
														: mode === 'sequence'
															? { number: true }
															: mode === 'computed'
																? { upper_code: true }
																: mode === 'nested'
																	? {
																			code: true,
																			entries: { all: true, select: { upper_memo: true } }
																		}
																	: { code: true },
							...(mode === 'related_filter'
								? {
										where: {
											memo: { eq: 'new-entry' },
											account_id: { is: { code: { eq: code }, state: { eq: 'PAID' } } }
										}
									}
								: mode === 'filter'
									? { where: { amount: { gt: 0 } } }
									: mode === 'operand'
										? { where: { movements: { eq: { field: 'amount' } } } }
										: mode === 'nested_filter'
											? { where: { entries: { some: { upper_memo: { eq: 'ENTRY' } } } } }
											: {
													where:
														mode === 'unread' || mode === 'label'
															? {}
															: {
																	code: {
																		in: code.startsWith('quota-') ? ['quota-a', 'quota-b'] : [code]
																	}
																}
												}),
							...(mode === 'order' ? { orderBy: { amount: 'desc' } } : {}),
							...(mode === 'search' ? { search: code } : {})
						}
					).pipe(Effect.mapError(fromStore), Effect.orDie);
					const [answer] = yield* bridge.cross([
						{
							_tag: 'read',
							read: {
								kind: 'after',
								model: query.model,
								where: query.where ?? { t: 'const', value: true },
								query
							}
						}
					]);
					if (answer?.ok !== true) {
						if (answer?.ok === false && answer.error.kind === 'bolt') {
							failures.push(answer.error.code);
							return { kind: 'refused', code: answer.error.code, message: answer.error.message };
						}
						return { kind: 'refused', message: 'The native prospective read failed.' };
					}
					if (mode === 'unread') return { kind: 'ok', output: inv.input };
					if (mode === 'related_filter') {
						const related = yield* Schema.decodeUnknownEffect(
							Schema.Struct({
								rows: Schema.Array(
									Schema.Struct({
										id: Schema.String,
										memo: Schema.String,
										account_id: Schema.String
									})
								)
							})
						)(answer.value).pipe(Effect.orDie);
						expect(related.rows).toHaveLength(1);
						expect(related.rows[0]?.account_id).toBe(rows[0]?.account_id);
						expect(related.rows[0]?.memo).toBe('new-entry');
						return { kind: 'ok', output: inv.input };
					}
					const page = yield* Schema.decodeUnknownEffect(Page)(answer.value).pipe(Effect.orDie);
					if (mode === 'nested_identity') {
						const nested = yield* Schema.decodeUnknownEffect(
							Schema.Struct({
								rows: Schema.Array(
									Schema.Struct({ entries: Schema.Array(Schema.Struct({ memo: Schema.String })) })
								)
							})
						)(answer.value).pipe(Effect.orDie);
						expect(nested.rows[0]?.entries).toMatchObject([{ memo: 'entry' }]);
					}
					expect(page.next).toBeNull();
					if (gate !== undefined) yield* gate();
					if (page.rows.length !== 1) return { kind: 'refused', message: 'quota' };
					const account = page.rows[0];
					if (account === undefined)
						return { kind: 'refused', message: 'Missing native identity.' };
					observed.push(account.id);
					return {
						kind: 'ok',
						output: rows.map((row) => ({ ...row, resolved_account_id: account.id }))
					};
				})
		};
		return act(
			{ manifest, db, guest, bridge: bridgeOn(db, manifest) },
			{
				model: existing === undefined ? 'sources' : 'accounts',
				verb: existing === undefined ? 'create' : 'update',
				mode: { _tag: 'Direct' },
				input:
					existing === undefined
						? [
								{
									reference: code,
									accounts: [{ code, entries: [{ memo: 'entry', amount: '12.50' }] }]
								}
							]
						: [
								{
									target: existing,
									set: {
										state: 'PAID',
										entries: { create: [{ memo: 'new-entry', amount: '12.50' }] }
									}
								}
							],
				key: `prospective-${serial}`,
				invocationId: `prospective-${serial++}`,
				issuedAt: NOW,
				authority: admin,
				bindings: { now: NOW, today: TODAY, tz: 'UTC' }
			}
		);
	};
	return { db, run, observed, failures };
});

describe('native prospective identities', () => {
	it.effect(
		'resolves writer-minted account IDs with unmaterialized sum/count/sequence/computed fields and commits all source links atomically',
		() =>
			Effect.gen(function* () {
				const { db, run, observed } = yield* fixture;
				const result = yield* run('identity', 'account');
				expect(result.outcome.kind).toBe('committed');
				if (result.outcome.kind !== 'committed') throw new Error(JSON.stringify(result.outcome));
				const records = result.outcome.records;
				expect(new Set(records.map((row) => row.id)).size).toBe(3);
				const actual = yield* db.rows(
					Schema.Struct({
						source: Schema.String,
						account: Schema.String,
						resolved: Schema.String,
						amount: Schema.String,
						movements: Schema.Number
					}),
					{
						text: 'SELECT s.id AS source, a.id AS account, e.resolved_account_id AS resolved, a.amount::text AS amount, a.movements::int AS movements FROM sources s JOIN accounts a ON a.source_id=s.id JOIN entries e ON e.account_id=a.id',
						params: []
					}
				);
				expect(actual).toHaveLength(1);
				expect(actual[0]).toMatchObject({
					account: observed[0],
					resolved: observed[0],
					amount: '12.50',
					movements: 1
				});
				expect(records.find((r) => r.model === 'accounts')?.id).toBe(observed[0]);
			})
	);

	it.effect(
		'ignores unread staged generated groups while returning the real staged ordinary parent',
		() =>
			Effect.gen(function* () {
				const { run } = yield* fixture;
				expect((yield* run('unread', 'ordinary')).outcome.kind).toBe('committed');
			})
	);
	it.effect(
		'reads ordinary nested identities while their staged models also declare unused generated fields',
		() =>
			Effect.gen(function* () {
				const { run } = yield* fixture;
				expect((yield* run('nested_identity', 'nested-ordinary')).outcome.kind).toBe('committed');
			})
	);
	it.effect(
		'filters a staged component through its real staged parent using ordinary fields only',
		() =>
			Effect.gen(function* () {
				const { run } = yield* fixture;
				const created = yield* run('identity', 'paid-parent');
				if (created.outcome.kind !== 'committed') throw new Error(JSON.stringify(created.outcome));
				const account = created.outcome.records.find((r) => r.model === 'accounts');
				if (account === undefined) throw new Error('The native writer did not create its account.');
				const related = yield* run('related_filter', 'paid-parent', undefined, account.id);
				if (related.outcome.kind !== 'committed') throw new Error(JSON.stringify(related.outcome));
			})
	);

	for (const mode of [
		'sum',
		'count',
		'sequence',
		'computed',
		'filter',
		'operand',
		'order',
		'nested',
		'nested_filter',
		'search',
		'label'
	] as const)
		it.effect(`refuses generated ${mode} dependencies and rolls back the entire native tree`, () =>
			Effect.gen(function* () {
				const { db, run, failures } = yield* fixture;
				expect((yield* run(mode, mode)).outcome).toMatchObject({
					kind: 'refused',
					message:
						'prospective reads require native generated fields to be materialized before they can be read'
				});
				expect(failures).toEqual(['preparedComputed']);
				for (const table of ['sources', 'accounts', 'entries'])
					expect(
						yield* db.value(Schema.Number, {
							text: `SELECT count(*)::int FROM ${table}`,
							params: []
						})
					).toBe(0);
			})
		);

	it.effect(
		'serializes competing empty native account predicates without a mutable projection guard or partial source',
		() =>
			Effect.gen(function* () {
				const { db, run } = yield* fixture,
					both = yield* Deferred.make<void>();
				let arrivals = 0;
				const gate = () =>
					Effect.gen(function* () {
						if (++arrivals === 2) yield* Deferred.succeed(both, undefined);
						yield* Deferred.await(both);
					});
				const answers = yield* Effect.all(
					[run('identity', 'quota-a', gate), run('identity', 'quota-b', gate)],
					{ concurrency: 'unbounded' }
				);
				expect(answers.map((r) => r.outcome.kind).sort()).toEqual(['committed', 'refused']);
				expect(answers.find((r) => r.outcome.kind === 'refused')?.outcome).toMatchObject({
					message: 'quota'
				});
				expect(arrivals).toBe(3);
				for (const table of ['sources', 'accounts', 'entries'])
					expect(
						yield* db.value(Schema.Number, {
							text: `SELECT count(*)::int FROM ${table}`,
							params: []
						})
					).toBe(1);
			})
	);
});
