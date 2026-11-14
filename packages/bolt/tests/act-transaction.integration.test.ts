// One act map is one transaction: a created row carrying the id its writer minted (`new_id`) may be named by a later
// entry's ref (a member's own new row reads as visible to it), the map planned in order; every entry commits together, or none does.
import { Context, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { manifest, NOW } from './write-fixture.ts';
import { new_id } from '../src/decl/id.ts';
import type { Json } from '../src/decl/values.ts';

const Count = Schema.Number;
/** An act map over the write fixture's models, which the type registry does not name. */
const untyped = (acts: { readonly [callable: string]: Json }) => acts;

describe('an act map of dependent writes', () => {
	it.live('names a row an earlier entry creates, and commits nothing when a later entry is refused', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const context = yield* Layer.build(TestWorkspace.layer({ manifest, now: NOW }));
				const t = Context.get(context, TestWorkspace);
				const admin = yield* t.as(t.admin);
				const orders = (title: string) =>
					t.db.value(Count, { text: 'SELECT count(*)::int FROM orders WHERE title = $1', params: [title] });

				const order = new_id('orders');
				const committed = yield* admin.act(
					untyped({
						'orders.create': [{ id: order, title: 'A' }],
						'lines.create': [{ label: 'one', amount: '5.00', order }]
					})
				);
				expect(committed.kind).toBe('committed');
				expect(committed.records.map((record) => record.id)).toContain(order);
				expect(
					yield* t.db.value(Count, { text: 'SELECT count(*)::int FROM lines WHERE "order" = $1', params: [order] })
				).toBe(1);

				// the line lacks its amount: the whole map is refused, the order with it
				const b = new_id('orders');
				const refused = yield* admin
					.act(untyped({ 'orders.create': [{ id: b, title: 'B' }], 'lines.create': [{ label: 'two', order: b }] }))
					.pipe(Effect.flip);
				expect(refused._tag).toBe('ActRefused');
				expect(yield* orders('B')).toBe(0);
			})
		)
	);
	it.live('a member links to a row an earlier entry of the map created, which is its own to read', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const grant = { outputs: { default: {} }, create: {} };
				const context = yield* Layer.build(
					TestWorkspace.layer({
						manifest: {
							...manifest,
							policies: { p: { description: 'Writes orders', grants: { orders: grant, lines: grant } } }
						},
						now: NOW
					})
				);
				const t = Context.get(context, TestWorkspace);
				const writer = yield* t.as(t.member(['p']));
				const order = new_id('orders');
				const committed = yield* writer.act(
					untyped({
						'orders.create': [{ id: order, title: 'Mine' }],
						'lines.create': [{ label: 'one', amount: '5.00', order }]
					})
				);
				expect(committed.kind).toBe('committed');
				expect(
					yield* t.db.value(Count, { text: 'SELECT count(*)::int FROM lines WHERE "order" = $1', params: [order] })
				).toBe(1);
			})
		)
	);
});
