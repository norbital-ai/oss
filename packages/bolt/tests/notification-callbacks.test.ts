import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer } from 'effect';
import { LIMITS, type CrossAnswer, type Invocation } from '../src/engine/contracts.ts';
import { Guest, type Bridge, type CrossCall } from '../src/engine/services.ts';
import { noticeRows, type NotifyWire } from '../src/engine/notifications/notify.ts';
import { program } from '../src/test/guest.ts';
import { guestLayer } from './support/guest-fixture.ts';
import { manifest, NOW, TODAY, admin } from './write-fixture.ts';

const input: NotifyWire = {
	kind: 'write',
	action: 'create',
	records: [{ id: 'order', title: 'Desk' }],
	previous: [null],
	actor: { kind: 'member', id: 'member' }
};
const invocation = (event: NotifyWire = input): Invocation => ({
	id: 'notice',
	kind: 'notify',
	target: 'orders',
	input: event,
	ctx: { actor: admin.actor, now: NOW, today: TODAY, tz: 'UTC', seed: 'notice' },
	budget: { crossings: LIMITS.crossings.sync, readBytes: LIMITS.readBytes }
});
const noCrossing: Bridge = { cross: () => Effect.die('unexpected host call') };

describe('model notification callbacks', () => {
	it.live(
		'executes a conditional notification body in a fresh isolate with its invocation clock',
		() =>
			Effect.gen(function* () {
				const source = yield* program(`
let calls = 0;
export default { model: { orders: { bodies: {
 notify: function* (event, ctx) {
  if (++calls !== 1) throw new Error('notification isolate was reused');
  if (ctx.now !== '${NOW}') throw new Error('notification clock was lost');
  return event.kind === 'write' && event.records[0]?.title === 'Desk' && event.actor.kind === 'member'
   ? [{ title: 'Changed', to: [{ user: event.actor.id }] }] : [];
 }
} } } };`);
				const context = yield* Layer.build(
					guestLayer(source, {
						lowerRead: () => {
							throw new Error('pure callback');
						},
						console: () => {}
					})
				);
				const guest = Context.get(context, Guest);
				for (let repeat = 0; repeat < 2; repeat++) {
					const outcome = yield* guest.invoke(invocation(), noCrossing);
					expect(outcome).toEqual({
						kind: 'ok',
						output: [{ title: 'Changed', to: [{ user: 'member' }] }]
					});
				}
				expect(
					yield* guest.invoke(
						invocation({ ...input, records: [{ id: 'order', title: 'Chair' }] }),
						noCrossing
					)
				).toEqual({ kind: 'ok', output: [] });
			})
	);

	it.live('permits workspace queries through db and exposes no caller reads, writes or I/O', () =>
		Effect.gen(function* () {
			const calls: (readonly CrossCall[])[] = [];
			const bridge: Bridge = {
				cross: (batch) =>
					Effect.sync(() => {
						calls.push(batch);
						return batch.map((): CrossAnswer => ({
							ok: true,
							value: { orders: { rows: [{ id: 'order', title: 'Workspace desk' }], next: null } }
						}));
					})
			};
			const context = yield* Layer.build(
				guestLayer(
					yield* program(`export default { model: { orders: { bodies: {
 notify: function* (_, ctx) {
  if ('query' in ctx || 'act' in ctx || 'request' in ctx || 'after' in ctx.db)
   throw new Error('unexpected notification capability');
  const row = (yield* ctx.db.query({ orders: { where: { id: { eq: 'order' } } } })).orders.rows[0];
  return [{ title: row.title, to: [{ user: 'member' }] }];
 }
} } } };`),
					{
						lowerRead: (member, args) => {
							expect(member).toBe('db.query');
							expect(args).toEqual([{ orders: { where: { id: { eq: 'order' } } } }]);
							return {
								kind: 'get',
								model: 'orders',
								id: 'order',
								select: { fields: null, relations: {} }
							};
						},
						console: () => {}
					}
				)
			);
			expect(yield* Context.get(context, Guest).invoke(invocation(), bridge)).toEqual({
				kind: 'ok',
				output: [{ title: 'Workspace desk', to: [{ user: 'member' }] }]
			});
			expect(calls).toEqual([
				[
					{
						_tag: 'read',
						read: {
							kind: 'get',
							model: 'orders',
							id: 'order',
							select: { fields: null, relations: {} }
						}
					}
				]
			]);
		})
	);

	it.live('refuses callback errors, unavailable I/O and oversized guest output', () =>
		Effect.gen(function* () {
			for (const [body, code] of [
				["throw new Error('notice failed');", 'guestError'],
				["yield* ctx.request('mail', {});", 'guestError'],
				[
					`return [{ title: 'x'.repeat(${LIMITS.argsBytes + 1}), to: [{ user: 'member' }] }];`,
					'tooLarge'
				]
			]) {
				const context = yield* Layer.build(
					guestLayer(
						yield* program(
							`export default { model: { orders: { bodies: { notify: function* (_, ctx) { ${body} } } } } };`
						),
						{ console: () => {} }
					)
				);
				expect(yield* Context.get(context, Guest).invoke(invocation(), noCrossing)).toMatchObject({
					kind: 'failed',
					error: { code }
				});
			}
		})
	);

	it.effect('normalizes notices, dedupes recipients and refuses invalid or oversized batches', () =>
		Effect.gen(function* () {
			const ctx = { manifest, id: 'notice', link: { model: 'orders', id: 'order' } };
			const notice = {
				title: 'Changed',
				description: 'Desk',
				to: [{ user: 'member' }, { user: 'member' }]
			};
			expect(yield* noticeRows(notice, ctx)).toEqual([
				{
					id: 'notice:0',
					to: [{ user: 'member' }],
					via: [],
					title: 'Changed',
					body: 'Desk',
					link: ctx.link,
					once: 'notice:0',
					attachments: []
				}
			]);
			expect(yield* noticeRows([], ctx)).toEqual([]);
			expect(
				yield* Effect.flip(
					noticeRows(
						Array.from({ length: LIMITS.changesPerAct + 1 }, () => notice),
						ctx
					)
				)
			).toMatchObject({ code: 'tooLarge' });
			for (const invalid of [
				null,
				{ title: 'Invalid', to: [] },
				{ title: 'Invalid', to: [{ user: 'member', team: 'unknown' }] },
				{ title: 'Invalid', to: [{ team: 'unknown' }] }
			])
				expect(yield* Effect.flip(noticeRows(invalid, ctx))).toMatchObject({
					code: 'invalidInput'
				});
		})
	);
});
