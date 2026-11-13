// A member's Slack and Discord ids (`sys_user.slack`, `.discord`): a notice `via` those connections reaches them by direct
// message (`@<id>`, which the driver opens), `ctx.notify` answers those messages, and an envoy knows them as senders.
import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import { Outbound, Runs } from '../src/engine/services.ts';
import { memberByHandle } from '../src/engine/envoys/senders.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { with_accounts } from './support/accounts.ts';
import { manifest as base } from './write-fixture.ts';

const manifest = {
	...base,
	teams: { desk: { policies: ['reporter'] } },
	policies: { reporter: { description: 'Gets the daily report', grants: {} } },
	automations: {
		announce: {
			description: 'Announces the daily report',
			policies: ['reporter'] as const,
			on: [{ cron: '0 8 * * *' }],
			output: { kind: 'json' as const }
		}
	}
};
const guest = program(`export default { automation: { announce: { body: function* (_input, ctx) {
	return yield* ctx.notify({ title: 'Daily report', description: 'It is ready.', to: [{ team: 'desk' }], via: ['team_slack', 'team_discord'] });
} } } };`);

it.live('a member with Slack and Discord ids gets the notice by direct message there, and is known as a sender', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(
				with_accounts(TestWorkspace.layer({ manifest, guest: yield* guest, now: '2026-11-13T08:00:00.000Z' }), [
					{ id: 'team_slack', integration: 'slack', status: { state: 'connected' } },
					{ id: 'team_discord', integration: 'discord', status: { state: 'connected' } }
				])
			);
			const t = Context.get(context, TestWorkspace),
				runs = Context.get(context, Runs),
				outbound = Context.get(context, Outbound);
			const ann = t.member(['reporter'], { teams: ['desk'] }),
				bob = t.member(['reporter'], { teams: ['desk'] });
			yield* t.as(ann);
			yield* t.as(bob);
			yield* t.db.write({
				text: `UPDATE sys_user SET slack = 'U07ABC123', discord = '123456789012345678' WHERE id = $1`,
				params: [ann.id]
			});
			expect(yield* runs.fire('announce', '2026-11-13T08:00:00.000Z').pipe(Effect.provide(context))).toEqual({
				ran: true
			});
			yield* t.run_due();
			yield* outbound.deliver;
			// Ann on both platforms; Bob, with no id there, is skipped
			expect(
				t.fakes.links.sent.map((sent) => [sent.instance, sent.message]).sort(([a], [b]) => String(a).localeCompare(String(b)))
			).toEqual([
				['team_discord', expect.objectContaining({ to: '@123456789012345678', text: 'Daily report\nIt is ready.' })],
				['team_slack', expect.objectContaining({ to: '@U07ABC123', text: 'Daily report\nIt is ready.' })]
			]);
			const [run] = yield* t.db.rows(Schema.Struct({ output: Schema.Json }), {
				text: "SELECT output FROM sys_run WHERE automation = 'announce'",
				params: []
			});
			const { messages } = yield* Schema.decodeUnknownEffect(
				Schema.Struct({ messages: Schema.Array(Schema.String) })
			)(run?.output);
			const queued = yield* t.db.rows(Schema.Struct({ id: Schema.String }), {
				text: "SELECT id FROM sys_message WHERE direction = 'outbound'",
				params: []
			});
			expect([...messages].sort()).toEqual(queued.map((row) => row.id).sort());
			// inbound: the platform's own sender id names the member
			expect(yield* memberByHandle(t.db, 'slack', 'U07ABC123')).toBe(ann.id);
			expect(yield* memberByHandle(t.db, 'discord', '123456789012345678')).toBe(ann.id);
			expect(yield* memberByHandle(t.db, 'slack', 'U0NOBODY')).toBeNull();
		})
	)
);
