// `ctx.convert.record`: a record printed by the host's browser (`RenderPort`) under the run's own identity, through a
// render grant that reads and only reads while the print runs; its bytes attach to `ctx.send` and `ctx.notify` and no
// record holds them.
import { expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import { Render } from '../src/engine/ports.ts';
import { RenderGrants } from '../src/engine/render.ts';
import type { Authority } from '../src/engine/contracts.ts';
import { Outbound } from '../src/engine/services.ts';
import { uuidv7 } from '@norbital-ai/host-api';
import { SHELL } from '../src/shell/nav.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { act_reply, route_fixture } from './support/route-fixture.ts';
import { with_accounts } from './support/accounts.ts';
import { manifest as base } from './write-fixture.ts';

const PDF = new TextEncoder().encode('%PDF-1.7 printed');
const manifest = {
	...base,
	workspace: { ...base.workspace, convert: { to: ['pdf' as const] } },
	policies: {
		reporter: {
			description: 'Writes and reads reports',
			grants: { orders: { outputs: { default: {} }, create: {} } },
			capabilities: { automations: ['print', 'blind'] }
		},
		nothing: { description: 'Reads nothing', grants: {} }
	},
	automations: {
		print: {
			description: 'Creates a report and sends it printed',
			policies: ['reporter'] as const,
			input: { to: { kind: 'text' as const } },
			output: { kind: 'json' as const }
		},
		blind: {
			description: 'Prints a report it may not read',
			policies: ['nothing'] as const,
			input: { id: { kind: 'text' as const } },
			output: { kind: 'json' as const }
		}
	}
};
const guest = program(`import { Effect } from 'effect';
const failed = (error) => Effect.succeed(error._tag === 'Unavailable'
	? { kind: 'unavailable', reason: error.reason } : { kind: error.kind, message: error.message });
export default { automation: {
	print: { body: function* ({ to }, ctx) {
		const id = (yield* ctx.act({ 'orders.create': [{ title: 'Daily report' }] })).records[0].id;
		const pdf = yield* ctx.convert.record('orders', id, { to: 'pdf' });
		const sent = yield* ctx.send('desk', { to: '6591234567@s.whatsapp.net', text: 'Your report', attachments: [pdf] });
		const { messages } = yield* ctx.notify({ title: 'Daily report', to: [{ user: to }], via: ['desk'], attachments: [pdf] });
		return { id, name: pdf.name, mime: pdf.mime, size: pdf.bytes.byteLength, sent, messages };
	} },
	blind: { body: function* ({ id }, ctx) {
		return yield* ctx.convert.record('orders', id, { to: 'pdf' }).pipe(Effect.map(() => ({ kind: 'printed' })), Effect.catch(failed));
	} }
} };`);

type Printed = { path: string; authorization: string; seen: Authority | undefined; boot: number; write: number };

const workspace = Effect.gen(function* () {
	const printed: Printed[] = [];
	// the fake browser: what it was asked to print, what the grant reads as and what the shell lets it do meanwhile
	let probe: (page: { path: string; authorization: string }) => Effect.Effect<void> = () => Effect.void;
	const render = Layer.succeed(Render, {
		pdf: (page) => Effect.as(Effect.suspend(() => probe(page)), PDF)
	});
	const context = yield* Layer.build(
		with_accounts(
			TestWorkspace.layer({ manifest, guest: yield* guest, ports: render, now: '2026-11-13T08:00:00.000Z' }),
			[{ id: 'desk', integration: 'whatsapp', status: { state: 'connected' } }]
		)
	);
	const t = Context.get(context, TestWorkspace),
		grants = Context.get(context, RenderGrants),
		route = yield* route_fixture(context);
	probe = (page) =>
		Effect.gen(function* () {
			const token = page.authorization.replace(/^Bearer /, '');
			const headers = { authorization: page.authorization };
			const boot = yield* t.handle(new Request(`http://localhost${SHELL}`, { headers }));
			const write = yield* t.handle(
				new Request('http://localhost/__bolt/act', {
					method: 'POST',
					headers: { ...headers, 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
					body: JSON.stringify({ acts: { 'orders.create': [{ title: 'Forged' }] } })
				})
			);
			printed.push({ ...page, seen: grants.of(token), boot: boot.status, write: write.status });
		});
	const start = (automation: string, input: Readonly<Record<string, string>>) =>
		Effect.gen(function* () {
			const id = uuidv7(Date.parse(t.clock.now()));
			yield* act_reply(route, (yield* t.as(t.member(['reporter']))).authority, {
				callable: 'run',
				input: { automation, input, id },
				issued_at: t.clock.now()
			});
			yield* t.run_due();
			const [run] = (yield* t.db.rows(Schema.Struct({ state: Schema.String, output: Schema.Json }), {
				text: 'SELECT state, output FROM sys_run WHERE id = $1',
				params: [id]
			}));
			return run;
		});
	return { t, grants, printed, start, outbound: Context.get(context, Outbound) };
});

it.live('prints a record the run just wrote, as its policies, and attaches the bytes to send and notify unstored', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const { t, grants, printed, start, outbound } = yield* workspace;
			const reader = t.member(['reporter'], { phone: '6591234567' });
			yield* t.as(reader);
			const run = yield* start('print', { to: reader.id });
			expect(run).toMatchObject({ state: 'succeeded' });
			const output = yield* Schema.decodeUnknownEffect(
				Schema.Struct({
					id: Schema.String,
					name: Schema.String,
					mime: Schema.String,
					size: Schema.Number,
					sent: Schema.String,
					messages: Schema.Array(Schema.String)
				})
			)(run?.output);
			expect(output).toMatchObject({ name: `orders-${output.id}.pdf`, mime: 'application/pdf', size: PDF.byteLength });
			// the port printed the record's print route under a grant that read as the automation's policies, read only
			expect(printed).toHaveLength(1);
			const [call] = printed;
			expect(call?.path).toBe(`/?record=orders/${output.id}&print`);
			expect(call?.authorization).toMatch(/^Bearer nbr_[0-9a-f]{64}$/);
			expect(call?.seen).toMatchObject({ render: true, policies: ['reporter'] });
			expect(call?.boot).toBe(200);
			expect(call?.write).not.toBe(200);
			expect(grants.of(String(call?.authorization).replace(/^Bearer /, ''))).toBeUndefined();
			expect(
				yield* t.db.rows(Schema.Struct({ title: Schema.String }), { text: 'SELECT title FROM orders', params: [] })
			).toEqual([{ title: 'Daily report' }]);
			// the send and the notice's WhatsApp delivery each carry the printed bytes; notify answered the latter's id
			yield* t.run_due();
			yield* outbound.deliver;
			expect(output.messages).toHaveLength(1);
			const sent = t.fakes.links.sent;
			expect(sent).toHaveLength(2);
			for (const message of sent) {
				expect(message.attachments?.map((file) => [file.name, file.mime, [...file.bytes]])).toEqual([
					[output.name, 'application/pdf', [...PDF]]
				]);
			}
			const outbound_ids = yield* t.db.rows(Schema.Struct({ id: Schema.String }), {
				text: "SELECT id FROM sys_message WHERE direction = 'outbound' ORDER BY id",
				params: []
			});
			expect(outbound_ids.map((row) => row.id).sort()).toEqual([output.sent, ...output.messages].sort());
			// no record and no run owns the bytes: only the deliveries' own files hold them
			const owners = yield* t.db.rows(Schema.Struct({ field: Schema.String }), {
				text: "SELECT coalesce(field, '') AS field FROM sys_file ORDER BY field",
				params: []
			});
			expect(owners.map((row) => row.field)).toEqual(['integrations.deliver', 'notifications.deliver']);
		})
	)
);

it.live("refuses a record the run's identity cannot read and never asks the host to print it", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const { t, printed, start } = yield* workspace;
			const made = yield* start('print', { to: t.member(['reporter']).id });
			const { id } = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(made?.output);
			printed.length = 0;
			const run = yield* start('blind', { id });
			expect(run?.output).toMatchObject({ kind: 'invalid', message: expect.stringContaining('may read') });
			expect(printed).toEqual([]);
		})
	)
);
