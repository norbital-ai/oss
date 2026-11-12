import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer } from 'effect';
import { LIMITS, type CrossAnswer, type Invocation } from '../src/engine/contracts.ts';
import { Guest, type Bridge, type CrossCall } from '../src/engine/services.ts';
import { noticeRows } from '../src/engine/notifications/notify.ts';
import type { Json } from '../src/decl/values.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { guest_layer } from './support/guest-fixture.ts';
import { manifest, NOW, TODAY, admin } from './write-fixture.ts';

if (admin.actor.kind !== 'member') throw new Error('The fixture writer must be a member');
const writer = admin.actor.id;
const invocation = (title = 'Desk'): Invocation => ({
	id: 'notice', kind: 'effect', target: 'orders.effect.create',
	input: [{ before: null, set: { title }, after: { id: 'order', title } }],
	ctx: { actor: admin.actor, now: NOW, today: TODAY, tz: 'UTC', seed: 'notice',
		cause: 'effect', attempt: 1 },
	budget: { crossings: LIMITS.crossings.automation, readBytes: LIMITS.readBytes }
});
const no_crossing: Bridge = { cross: () => Effect.die('unexpected host call') };
const source_of = (body: string, imports = '') => `${imports}
export default { model: { orders: { bodies: { effect: { create: function* (changes, ctx) {
${body}
} } } } } };`;

describe('notifications from model effects', () => {
	it.live('runs a conditional effect in a fresh isolate with its writer and clock', () =>
		Effect.gen(function* () {
			const notices: Json[] = [];
			const bridge: Bridge = {
				cross: (batch) => Effect.sync(() => batch.map((call): CrossAnswer => {
					if (call._tag !== 'notify') throw new Error('Expected a notification');
					notices.push(call.notices);
					return { ok: true, value: null };
				}))
			};
			const source = yield* program(`let calls = 0;\n${source_of(`
if (++calls !== 1) throw new Error('effect isolate was reused');
if (ctx.now !== '${NOW}') throw new Error('effect clock was lost');
if (ctx.actor.id !== '${writer}') throw new Error('writer was lost');
if (changes[0]?.after.title === 'Desk' && changes[0].changed('title'))
 yield* ctx.notify({ title: 'Changed', to: [{ user: ctx.actor.id }] });`)}`);
			const context = yield* Layer.build(guest_layer(source, {
				lower_read: () => { throw new Error('This effect does not read'); }, console: () => {}
			}));
			const guest = Context.get(context, Guest);
			for (let repeat = 0; repeat < 2; repeat++)
				expect(yield* guest.invoke(invocation(), bridge)).toEqual({ kind: 'ok', output: null });
			expect(yield* guest.invoke(invocation('Chair'), bridge)).toEqual({ kind: 'ok', output: null });
			expect(notices).toEqual(Array.from({ length: 2 }, () => ({ title: 'Changed', to: [{ user: writer }] })));
		})
	);

	it.live('uses caller reads and normal effect facilities without a workspace read bypass', () =>
		Effect.gen(function* () {
			const calls: (readonly CrossCall[])[] = [];
			const bridge: Bridge = {
				cross: (batch) => Effect.sync(() => {
					calls.push(batch);
					return batch.map((call): CrossAnswer => {
						if (call._tag === 'read') return { ok: true,
							value: { orders: { rows: [{ id: 'order', title: 'Visible desk' }], next: null } } };
						if (call._tag === 'notify') return { ok: true, value: null };
						throw new Error('Unexpected effect call');
					});
				})
			};
			const context = yield* Layer.build(guest_layer(yield* program(source_of(`
if (typeof ctx.act !== 'function' || typeof ctx.request !== 'function' || 'after' in ctx.query || 'db' in ctx)
 throw new Error('wrong effect capabilities');
const row = (yield* ctx.query({ orders: { where: { id: { eq: 'order' } } } })).orders.rows[0];
yield* ctx.notify({ title: row.title, to: [{ user: '${writer}' }] });`)), {
				lower_read: (member, args) => {
					expect(member).toBe('query');
					expect(args).toEqual([{ orders: { where: { id: { eq: 'order' } } } }]);
					return Effect.succeed({ kind: 'get', model: 'orders', id: 'order', select: { fields: null, relations: {} } });
				}, console: () => {}
			}));
			expect(yield* Context.get(context, Guest).invoke(invocation(), bridge)).toEqual({ kind: 'ok', output: null });
			expect(calls).toEqual([
				[{ _tag: 'read', read: { kind: 'get', model: 'orders', id: 'order', select: { fields: null, relations: {} } } }],
				[{ _tag: 'notify', notices: { title: 'Visible desk', to: [{ user: writer }] } }]
			]);
		})
	);

	it.live('exposes typed unavailable I/O so an effect can notify a fallback', () =>
		Effect.gen(function* () {
			const calls: CrossCall[] = [];
			const bridge: Bridge = {
				cross: (batch) => Effect.sync(() => batch.map((call): CrossAnswer => {
					calls.push(call);
					if (call._tag === 'request') return { ok: false,
						error: { kind: 'unavailable', facility: 'mail', reason: 'No mail account' } };
					if (call._tag === 'notify') return { ok: true, value: null };
					throw new Error('Unexpected effect call');
				}))
			};
			const context = yield* Layer.build(guest_layer(yield* program(source_of(`
yield* ctx.request('mail', {}).pipe(Effect.catchTag('Unavailable', () =>
 ctx.notify({ title: 'Mail unavailable', to: [{ user: 'member' }] })));`, "import { Effect } from 'effect';"))));
			expect(yield* Context.get(context, Guest).invoke(invocation(), bridge)).toEqual({ kind: 'ok', output: null });
			expect(calls.map((call) => call._tag)).toEqual(['request', 'notify']);
		})
	);

	it.live('reports effect defects and oversized results without committing a notification', () =>
		Effect.gen(function* () {
			for (const [body, code] of [
				["throw new Error('notice failed');", 'guest_error'],
				["yield* ctx.query.after('orders', {});", 'guest_error'],
				[`return [{ title: 'x'.repeat(${LIMITS.argsBytes + 1}), to: [{ user: 'member' }] }];`, 'too_large']
			] as const) {
				const context = yield* Layer.build(guest_layer(yield* program(source_of(body)), { console: () => {} }));
				expect(yield* Context.get(context, Guest).invoke(invocation(), no_crossing)).toMatchObject({
					kind: 'failed', error: { code }
				});
			}
		})
	);

	it.effect('normalizes notices, dedupes recipients and refuses invalid or oversized batches', () =>
		Effect.gen(function* () {
			const ctx = { manifest, id: 'notice', link: { model: 'orders', id: 'order' } };
			const notice = { title: 'Changed', description: 'Desk', to: [{ user: 'member' }, { user: 'member' }] };
			expect(yield* noticeRows(notice, ctx)).toEqual([{
				id: 'notice:0', to: [{ user: 'member' }], via: [], title: 'Changed', body: 'Desk',
				link: ctx.link, once: 'notice:0', attachments: []
			}]);
			expect(yield* noticeRows([], ctx)).toEqual([]);
			expect(yield* noticeRows({ title: 'Unaddressed', to: ['requester', 'approvers'] }, ctx)).toEqual([]);
			expect(yield* Effect.flip(noticeRows(
				Array.from({ length: LIMITS.changesPerAct + 1 }, () => notice), ctx
			))).toMatchObject({ code: 'too_large' });
			for (const invalid of [null, { title: 'Invalid', to: [] },
				{ title: 'Invalid', to: [{ user: 'member', team: 'unknown' }] },
				{ title: 'Invalid', to: [{ team: 'unknown' }] }
			]) expect(yield* Effect.flip(noticeRows(invalid, ctx))).toMatchObject({ code: 'invalid_input' });
		}).pipe(Effect.provide(TestWorkspace.layer({ manifest, now: NOW })))
	);
});
