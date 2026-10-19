import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer } from 'effect';
import { program } from './support/guest-fixture.ts';
import { actReply, qReply, routeFixture } from './support/route-fixture.ts';
import { TestWorkspace } from '../src/test/index.ts';
import { ACME, manifest, seed } from './engine-fixture.ts';

it.effect(
	'explicit workspace reads retain native sequence labels without changing default stored rows or allocating another sequence',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const guest = {
					source: `export default { collection: { orders: { bodies: { transform: function* (rows, ctx) {
		const ids = ctx.existing.flatMap((row) => row ? [row.id] : []);
		if (!ids.length) return rows;
		const labels = yield* ctx.db.read('orders', { where: { id: { in: ids } }, select: { number: true }, all: true });
		const ordinary = yield* ctx.db.read('orders', { where: { id: { in: ids } }, all: true });
		if (ordinary.rows.some((row) => Object.hasOwn(row, 'number') || Object.hasOwn(row, 'total'))) yield* ctx.refuse('ordinary rows exposed derived fields');
		if (labels.rows.some((row) => Object.keys(row).sort().join(',') !== 'id,number')) yield* ctx.refuse('sequence projection read other fields');
		return rows.map((row, i) => row.status === 'submitted' ? { ...row, note: labels.rows.find((label) => label.id === ctx.existing[i].id).number } : row);
	} } } } };`
				};
				const context = yield* Layer.build(
					TestWorkspace.layer({
						manifest,
						guest: yield* program(guest.source),
						transforms: ['orders'],
						seed
					})
				);
				const t = Context.get(context, TestWorkspace),
					route = yield* routeFixture(context);
				const as = t.as(t.admin);
				for (const number of ['SO-0001', 'SO-0002']) {
					const created = (yield* actReply(route, as.authority, {
						callable: 'orders.create',
						input: {
							title: number,
							region: 'north',
							customer: ACME
						},
						issuedAt: t.clock.now()
					})).outcome;
					expect(created.kind).toBe('committed');
					if (created.kind !== 'committed') throw new Error('create refused');
					const id = created.records[0]?.id;
					if (id === undefined) throw new Error('create returned no record');
					expect(
						(yield* actReply(route, as.authority, {
							callable: 'orders.update',
							input: { target: id, set: { status: 'submitted' } },
							issuedAt: t.clock.now()
						})).outcome.kind
					).toBe('committed');
					expect(
						(yield* qReply(route, as.authority, { reads: [{ m: 'get', a: ['orders', id, {}] }] }))
							.answers[0]
					).toMatchObject({ number, note: number });
					expect(
						(yield* actReply(route, as.authority, {
							callable: 'orders.update',
							input: { target: id, set: { number: 'FORGED' } },
							issuedAt: t.clock.now()
						})).outcome.kind
					).toBe('refused');
				}
			})
		)
);
