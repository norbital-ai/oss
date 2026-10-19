// Rule 35 through `act` on PGlite (its pre- and post-image judges): each arm's scope over the stored and the written row,
// `previous` on the stored row alone, every supplied field admitted by a scoped arm, and a direct grant committing past a
// configured source approval route.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Result } from 'effect';
import type { Json } from '../src/decl/values.ts';
import { compileAuthority } from '../src/engine/access/authority.ts';
import type { Authority } from '../src/engine/contracts.ts';
import { PgliteDb } from '../src/engine/db/pglite.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { applyPlan, plan } from '../src/engine/schema/plan.ts';
import { act } from '../src/engine/write/act.ts';
import { admin, member, NOW, TODAY } from './write-fixture.ts';

const m = Result.getOrThrow(
	decodeManifest({
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
		collections: {
			orders: {
				read: { fields: 'all' },
				create: { input: { columns: ['region', 'amount', 'note'] } },
				update: { input: { columns: ['region', 'amount', 'note'] } },
				delete: {}
			},
			employees: {
				read: { fields: 'all' },
				create: { input: { columns: ['face'] } },
				update: { input: { columns: ['face', 'checked_at'] } }
			}
		},
		policies: {
			rep: {
				description: '',
				grants: {
					orders: {
						read: { where: { region: { eq: 'north' } } },
						update: { where: 'read', fields: ['note'] }
					}
				}
			},
			routed: {
				description: '',
				grants: {
					orders: {
						read: { where: { region: { eq: 'north' } } },
						update: { where: 'read', fields: ['note'] },
						approval: { update: { steps: [['Finance']] } }
					}
				}
			},
			mover: {
				description: '',
				grants: { orders: { read: true, update: { where: { region: { eq: 'north' } } } } }
			},
			kiosk: {
				description: '',
				grants: {
					employees: {
						read: true,
						update: {
							previous: { face: { in: ['NONE', 'APPROVED'] } },
							where: { face: { eq: 'APPROVED' } },
							fields: ['face']
						}
					}
				}
			},
			stamp: {
				description: '',
				grants: {
					employees: {
						read: true,
						update: {
							previous: { checked_at: { isNull: true } },
							where: { checked_at: { isNull: false } }
						}
					}
				}
			}
		},
		teams: { Finance: [] },
		integrations: {},
		pipelines: {},
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
const fixture = Effect.gen(function* () {
	const db = yield* TenantDb;
	yield* applyPlan(db, plan(null, m), { accept: true });
	let n = 0;
	const run = (
		collection: string,
		verb: 'create' | 'update' | 'delete',
		input: Json,
		authority: Authority = admin
	) =>
		act(
			{ manifest: m, db },
			{
				collection,
				verb,
				input,
				mode: { _tag: 'Direct' },
				key: `key-${n}`,
				issuedAt: NOW,
				authority,
				bindings: { now: NOW, today: TODAY, tz: 'UTC', params: {} },
				invocationId: `inv-${n++}`
			}
		).pipe(Effect.map((answer) => answer.outcome));
	const create = Effect.fnUntraced(function* (collection: string, values: Json) {
		const o = yield* run(collection, 'create', values);
		if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
		const record = o.records.find((r) => r.collection === collection);
		if (record === undefined) throw new Error(`No created ${collection} record`);
		return record.id;
	});
	const update = (collection: string, target: string, set: Json, authority: Authority) =>
		run(collection, 'update', { target, set }, authority);
	return { run, create, update };
});
class JudgeFixture extends Context.Service<JudgeFixture, Effect.Success<typeof fixture>>()(
	'test/JudgeFixture'
) {}
const JudgeFixtureLive = Layer.effect(JudgeFixture, fixture).pipe(Layer.provide(PgliteDb.layer()));

describe('engine/write: the caller judged on the stored and the written row (rule 35)', () => {
	it.effect(
		'an update is scoped on both images, and each supplied field needs an admitting arm',
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
				// a direct grant commits: the configured Finance route is never consulted (no approval flow is wired here)
				expect(yield* update('orders', north, { note: 'z' }, as(['routed']))).toMatchObject({
					kind: 'committed'
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
				// the stored row outside the arm, and the written row leaving it
				expect(yield* update('orders', south, { note: 'y' }, mover)).toMatchObject({
					kind: 'refused',
					code: 'forbidden'
				});
				expect(yield* update('orders', north, { region: 'south' }, mover)).toMatchObject({
					kind: 'refused',
					code: 'forbidden'
				});
				expect(yield* run('orders', 'delete', { target: south })).toMatchObject({
					kind: 'committed'
				}); // an administrator: every scope
			}).pipe(Effect.provide(JudgeFixtureLive))
	);

	it.effect(
		'`previous` scopes the stored row and `where` the written row only (kiosk enrolment, review stamp)',
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
				expect(yield* face('APPROVED', 'NONE')).toMatchObject({
					kind: 'refused',
					code: 'forbidden'
				});
				expect(yield* face('PENDING', 'APPROVED')).toMatchObject({
					kind: 'refused',
					code: 'forbidden'
				});
				const stamped = yield* create('employees', { face: 'NONE' });
				expect(
					yield* update('employees', stamped, { checked_at: '2026-09-25T01:00:00.000Z' }, stamp)
				).toMatchObject({ kind: 'committed' });
				expect(
					yield* update('employees', stamped, { checked_at: '2026-09-25T02:00:00.000Z' }, stamp)
				).toMatchObject({ kind: 'refused', code: 'forbidden' });
			}).pipe(Effect.provide(JudgeFixtureLive))
	);
});
