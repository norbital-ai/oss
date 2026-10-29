// Rule 35 through `act` on PGlite: every supplied column admitted by an arm's `columns` before any guest code, then one
// policy `check` per admitting arm over the batch of `{ before, set }` (what `previous` and the write `where` judged), a
// denying check refusing the write, and a direct arm committing past a policy whose check would hold it.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Result, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import { compileAuthority } from '../src/engine/access/authority.ts';
import type { Authority, GuestOutcome, Invocation } from '../src/engine/contracts.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import { act, type WriteEngine } from '../src/engine/write/act.ts';
import { admin, member, NOW, TODAY } from './write-fixture.ts';

const m = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			orders: {
				description: '',
				label: 'region',
				fields: {
					region: { kind: 'text' },
					amount: { kind: 'decimal', scale: 2 },
					note: { kind: 'text', optional: true }
				}
			},
			employees: {
				description: '',
				label: 'face',
				fields: {
					face: { kind: 'enum', values: ['NONE', 'PENDING', 'APPROVED'] },
					checked_at: { kind: 'instant', optional: true }
				}
			}
		},
		relationships: {},
		exposures: {
			orders: {
				read: { orders: { fields: 'all' } },
				create: { columns: { orders: ['region', 'amount', 'note'] } },
				update: { columns: { orders: ['region', 'amount', 'note'] } },
				delete: {}
			},
			employees: {
				read: { employees: { fields: 'all' } },
				create: { columns: { employees: ['face'] } },
				update: { columns: { employees: ['face', 'checked_at'] } }
			}
		},
		policies: {
			rep: {
				description: '',
				grants: {
					orders: {
						read: { orders: { where: { region: { eq: 'north' } } } },
						update: { columns: { orders: ['note'] } }
					}
				}
			},
			routed: {
				description: '',
				grants: {
					orders: {
						read: { orders: { where: { region: { eq: 'north' } } } },
						update: { columns: { orders: ['note'] }, check: true }
					}
				}
			},
			mover: {
				description: '',
				grants: { orders: { read: true, update: { check: true } } }
			},
			kiosk: {
				description: '',
				grants: {
					employees: { read: true, update: { columns: { employees: ['face'] }, check: true } }
				}
			},
			stamp: {
				description: '',
				grants: {
					employees: { read: true, update: { check: true } }
				}
			}
		},
		teams: { Finance: [] },
		integrations: {},
		automations: {},
		connections: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { skills: {} }
	})
);

const as = (policies: string[]): Authority =>
	compileAuthority(m, { actor: member, admin: false, policies }, policies.join());
const Changes = Schema.Array(
	Schema.Struct({
		before: Schema.Record(Schema.String, Schema.Json),
		set: Schema.Record(Schema.String, Schema.Json)
	})
);
/** Each policy's update `check`, as its authored `function*` would answer: the stored row, then the written one. */
const verdicts: { readonly [target: string]: (c: { before: Json; after: Json }[]) => Json } = {
	'routed.orders.update': () => ({
		kind: 'approve',
		flow: {
			kind: 'steps',
			steps: [{ name: 'Finance', teams: ['Finance'], users: [] }],
			superseded_by: []
		}
	}),
	'mover.orders.update': (changes) =>
		changes.every(
			({ before, after }) =>
				field(before, 'region') === 'north' && field(after, 'region') === 'north'
		)
			? { kind: 'allow' }
			: { kind: 'deny', message: 'Northern orders stay northern.', at: { field: 'region' } },
	'kiosk.employees.update': (changes) =>
		changes.every(
			({ before, after }) =>
				(field(before, 'face') === 'NONE' || field(before, 'face') === 'APPROVED') &&
				field(after, 'face') === 'APPROVED'
		)
			? { kind: 'allow' }
			: { kind: 'deny', message: 'A kiosk approves a face once.', at: { field: 'face' } },
	'stamp.employees.update': (changes) =>
		changes.every(
			({ before, after }) =>
				field(before, 'checked_at') === null && field(after, 'checked_at') !== null
		)
			? { kind: 'allow' }
			: { kind: 'deny', message: 'A review stamps once.', at: { field: 'checked_at' } }
};
const Row = Schema.Record(Schema.String, Schema.Json);
const field = (row: Json, name: string): Json => (Schema.is(Row)(row) ? (row[name] ?? null) : null);
const checks: WriteEngine['guest'] = {
	invokeProgram: () =>
		Effect.die(new Error('This fixture does not execute supplied guest programs.')),
	invoke: (inv: Invocation) =>
		Effect.sync((): GuestOutcome => {
			const verdict = verdicts[inv.target];
			if (inv.kind !== 'policy' || verdict === undefined)
				throw new Error(`Unexpected guest call ${inv.kind} ${inv.target}`);
			const changes = Schema.decodeUnknownSync(Changes)(inv.input).map(({ before, set }) => ({
				before,
				after: { ...before, ...set }
			}));
			return { kind: 'ok', output: verdict(changes) };
		})
};
/** The approval engine's seam: a routed write is held under one request (persistence is the approval suite's). */
const approval: WriteEngine['approval'] = {
	route: (held) =>
		Effect.succeed({
			requestId: '0199a000-0000-7000-8000-0000000000aa',
			route: held.snapshot,
			pieces: () => {}
		}),
	resubmit: () => Effect.die(new Error('This fixture does not resubmit requests.'))
};
const fixture = Effect.gen(function* () {
	const db = yield* TenantDb;
	let n = 0;
	const run = (
		model: string,
		verb: 'create' | 'update' | 'delete',
		input: Json,
		authority: Authority = admin
	) =>
		act(
			{ manifest: m, db, guest: checks, approval },
			{
				model,
				verb,
				input,
				mode: { _tag: 'Direct' },
				key: `key-${n}`,
				issuedAt: NOW,
				authority,
				bindings: { now: NOW, today: TODAY, tz: 'UTC' },
				invocationId: `inv-${n++}`
			}
		).pipe(Effect.map((answer) => answer.outcome));
	const create = Effect.fnUntraced(function* (model: string, values: Json) {
		const o = yield* run(model, 'create', [values]);
		if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
		const record = o.records.find((r) => r.model === model);
		if (record === undefined) throw new Error(`No created ${model} record`);
		return record.id;
	});
	const update = (model: string, target: string, set: Json, authority: Authority) =>
		run(model, 'update', [{ target, set }], authority);
	return { run, create, update };
});
class JudgeFixture extends Context.Service<JudgeFixture, Effect.Success<typeof fixture>>()(
	'test/JudgeFixture'
) {}
const JudgeFixtureLive = Layer.effect(JudgeFixture, fixture).pipe(Layer.provide(TestDb.layer(m)));

describe('engine/write: columns, then one check over the stored and the written row (rule 35)', () => {
	it.effect(
		"each supplied column needs an admitting arm; an update's check judges both images",
		() =>
			Effect.gen(function* () {
				const { run, create, update } = yield* JudgeFixture;
				const north = yield* create('orders', { region: 'north', amount: '10' });
				const south = yield* create('orders', { region: 'south', amount: '10' });
				const rep = as(['rep']),
					mover = as(['mover']);
				expect(yield* update('orders', north, { note: 'x' }, rep)).toMatchObject({
					kind: 'committed'
				});
				// the direct arm (no check: it allows) wins even when the approving policy comes first
				expect(yield* update('orders', north, { note: 'z' }, as(['routed', 'rep']))).toMatchObject({
					kind: 'committed'
				});
				expect(yield* update('orders', north, { note: 'w' }, as(['routed']))).toMatchObject({
					kind: 'pendingApproval'
				});
				expect(yield* update('orders', north, { amount: '5' }, rep)).toMatchObject({
					kind: 'refused',
					code: 'forbidden',
					field: 'amount'
				});
				expect(yield* update('orders', south, { note: 'x' }, rep)).toMatchObject({
					kind: 'refused',
					code: 'notFound'
				});
				// the check sees the stored row outside the north, and the written row leaving it
				const denied = {
					kind: 'refused',
					code: 'refused',
					rule: 'mover.orders.update',
					field: 'region'
				};
				expect(yield* update('orders', south, { note: 'y' }, mover)).toMatchObject(denied);
				expect(yield* update('orders', north, { region: 'south' }, mover)).toMatchObject(denied);
				expect(yield* run('orders', 'delete', [{ target: south }])).toMatchObject({
					kind: 'committed'
				}); // an administrator: every scope
			}).pipe(Effect.provide(JudgeFixtureLive))
	);

	it.effect(
		'a check judges the stored row and the written row in one call (kiosk enrolment, review stamp)',
		() =>
			Effect.gen(function* () {
				const { create, update } = yield* JudgeFixture;
				const kiosk = as(['kiosk']),
					stamp = as(['stamp']);
				const face = Effect.fnUntraced(function* (from: string, to: string) {
					return yield* update(
						'employees',
						yield* create('employees', { face: from }),
						{ face: to },
						kiosk
					);
				});
				expect(yield* face('NONE', 'APPROVED')).toMatchObject({ kind: 'committed' });
				const once = { kind: 'refused', code: 'refused', rule: 'kiosk.employees.update' };
				expect(yield* face('APPROVED', 'NONE')).toMatchObject(once);
				expect(yield* face('PENDING', 'APPROVED')).toMatchObject(once);
				const stamped = yield* create('employees', { face: 'NONE' });
				expect(
					yield* update('employees', stamped, { checked_at: '2026-09-25T01:00:00.000Z' }, stamp)
				).toMatchObject({ kind: 'committed' });
				expect(
					yield* update('employees', stamped, { checked_at: '2026-09-25T02:00:00.000Z' }, stamp)
				).toMatchObject({ kind: 'refused', code: 'refused', rule: 'stamp.employees.update' });
			}).pipe(Effect.provide(JudgeFixtureLive))
	);
});
