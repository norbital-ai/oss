import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer } from 'effect';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { act_reply, q_reply, route_fixture } from './support/route-fixture.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { ACME, manifest, seed } from './engine-fixture.ts';

it.effect(
	'explicit workspace reads retain native sequence labels without changing default stored rows or allocating another sequence',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const guest = {
					source: `export default { model: { orders: { bodies: { update: function* (changes, ctx) {
		const ids = changes.map(({ before }) => before.id);
		// one model is one root per request: the labelled read and the ordinary one are two requests
		const { orders: labels } = yield* ctx.query({ orders: { where: { id: { in: ids } }, fields: ['number'] } });
		const { orders: ordinary } = yield* ctx.query({ orders: { where: { id: { in: ids } } } });
		if (ordinary.rows.some((row) => Object.hasOwn(row, 'number') || Object.hasOwn(row, 'total'))) yield* ctx.refuse('ordinary rows exposed derived fields');
		if (labels.rows.some((row) => Object.keys(row).sort().join(',') !== 'id,number')) yield* ctx.refuse('sequence projection read other fields');
		return changes.map(({ before, set }) => set.status === 'submitted' ? { ...set, note: labels.rows.find((label) => label.id === before.id).number } : set);
	} } } } };`
				};
				const context = yield* Layer.build(
					TestWorkspace.layer({
						manifest: {
							...manifest,
							exposures: {
								...manifest.exposures,
								orders: {
									...manifest.exposures.orders,
									update: { ...manifest.exposures.orders.update, transform: true }
								}
							}
						},
						guest: yield* program(guest.source),
						transforms: ['orders.update'],
						seed
					})
				);
				const t = Context.get(context, TestWorkspace),
					route = yield* route_fixture(context);
				const as = yield* t.as(t.admin);
				for (const number of ['SO-0001', 'SO-0002']) {
					const created = (yield* act_reply(route, as.authority, {
						acts: { 'orders.create': [
							{
								title: number,
								region: 'north',
								customer: ACME
							}
						] },
						issued_at: t.clock.now()
					})).outcome;
					expect(created.kind).toBe('committed');
					if (created.kind !== 'committed') throw new Error('create refused');
					const record = created.records[0];
					if (record === undefined) throw new Error('create returned no record');
					const id = record.id;
					const submitted = (yield* act_reply(route, as.authority, {
						acts: { 'orders.update': [{ target: { id, revision: record.revision }, set: { status: 'submitted' } }] },
						issued_at: t.clock.now()
					})).outcome;
					expect(submitted.kind).toBe('committed');
					if (submitted.kind !== 'committed') throw new Error('update refused');
					const revision = submitted.records[0]?.revision;
					if (revision === undefined) throw new Error('update returned no record');
					expect(
						(yield* q_reply(route, as.authority, {
							reads: [{ m: 'query', a: [{ orders: { where: { id: { eq: id } } } }] }]
						})).answers[0]
					).toMatchObject({ orders: { rows: [{ number, note: number }] } });
					expect(
						(yield* act_reply(route, as.authority, {
							acts: { 'orders.update': [{ target: { id, revision }, set: { number: 'FORGED' } }] },
							issued_at: t.clock.now()
						})).outcome.kind
					).toBe('refused');
				}
			})
		)
);
