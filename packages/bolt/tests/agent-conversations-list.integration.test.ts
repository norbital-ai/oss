// The panel's `conversations` read (§5.9, §5.10), answered by the engine's reader as the live hub asks it: a member lists
// their own root in-app conversations, newest first, titled by the engine or the first message, plus the envoy threads
// they may read and (as an administrator) automation transcripts; only Web UI conversations take a post (real handler).
import { expect, layer } from '@effect/vitest';
import { Context, Effect, FiberSet, Layer, Result, Schema } from 'effect';
import { Authorities } from '../src/engine/identity/actor.ts';
import { Agents, Reads } from '../src/engine/services.ts';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import { AgentConversation } from '../src/protocol/schema.ts';
import { conversationId } from '../src/engine/conversations/store.ts';
import { shellApi } from '../src/shell/runtime.ts';
import { TestWorkspace } from '../src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
		models: {},
		relationships: {},
		exposures: {},
		policies: { rep: { description: 'Rep', grants: {} } },
		agent: { internal: 'Staff brief.', skills: {} },
		integrations: {},
		teams: {},
		automations: {},
		connections: { whatsapp: { integration: 'whatsapp', envoy: 'field_ops' } },
		envoys: {
			field_ops: {
				audience: 'public',
				name: 'Norbius',
				policies: ['rep'],
				triage: false,
				groupMessages: 'disabled',
				delegation: 'disabled',
				task: 'Help.'
			}
		},
		mcp: {},
		apps: {},
		customFields: {}
	})
);
const ORIGIN = 'http://cell';

/** One workspace for the file: a public whatsapp envoy beside the in-app agent; no model runs (posts only queue). */
const fixture = Effect.gen(function* () {
	const context = yield* Layer.build(TestWorkspace.layer({ manifest, host: { publicUrl: ORIGIN } }));
	const t = Context.get(context, TestWorkspace),
		agent = Context.get(context, Agents);
	for (const id of ['ann', 'bob'])
		yield* t.db.write({
			text: `INSERT INTO sys_user (id, email, name) VALUES ($1, $2, $1)`,
			params: [id, `${id}@x.test`]
		});
	const cookies = new Map<string, string>();
	for (const id of ['ann', 'bob']) cookies.set(id, yield* t.session(id));
	let as = 'ann';
	const run = yield* FiberSet.makeRuntimePromise();
	const fetch: typeof globalThis.fetch = (input, init) => {
		const incoming = new Request(
			new URL(input instanceof Request ? input.url : String(input), ORIGIN),
			input instanceof Request ? input : init
		);
		const cookie = cookies.get(as);
		if (cookie !== undefined) incoming.headers.set('cookie', cookie);
		return run(t.handle(incoming));
	};
	const reads = Context.get(context, Reads),
		authorities = new Authorities(manifest, 'test');
	/** The member's conversation list: the `conversations` read the panel observes, as the hub answers it. */
	const list = Effect.gen(function* () {
		const authority = yield* authorities.member(t.db, as);
		if (authority === null) throw new Error(`no member ${as}`);
		const now = t.clock.now();
		const [answer] = yield* reads.run(
			[{ kind: 'conversations', model: 'sys_conversation', member: as }],
			{ as: 'caller', authority },
			{ now, today: now.slice(0, 10), tz: 'UTC' }
		);
		return (yield* Schema.decodeUnknownEffect(
			Schema.Struct({ rows: Schema.Array(AgentConversation) })
		)(answer)).rows;
	});
	return {
		t,
		agent,
		list,
		api: shellApi(fetch, { base: ORIGIN }),
		as: (who: string) => {
			as = who;
		}
	};
});

class Fixture extends Context.Service<Fixture, Effect.Success<typeof fixture>>()('test/ConversationsList') {}

layer(Layer.effect(Fixture, fixture))('the conversations read', (it) => {
	it.effect(
		"lists only the member's own root conversations, newest first, titled by the engine or the first message",
		() =>
			Effect.gen(function* () {
				const s = yield* Fixture;
				const first = yield* s.agent.start({ owner: 'ann' });
				yield* s.agent.post({
					conversation: first,
					as: { member: 'ann' },
					text: 'Draft the Kismis quote\nwith two lines'
				});
				s.t.clock.advance('1s');
				const second = yield* s.agent.start({ owner: 'ann', title: 'Budget review' });
				yield* s.agent.post({ conversation: second, as: { member: 'ann' }, text: 'numbers please' });
				yield* s.agent.start({ owner: 'ann', parent: first, title: 'a sub-agent' }); // a child is never a root
				const other = yield* s.agent.start({ owner: 'bob', title: 'Bob only' });
				const rows = yield* s.list;
				expect(rows.map((c) => c.id)).toEqual([second, first]);
				expect(rows.map((c) => c.title)).toEqual([
					'Budget review',
					'Draft the Kismis quote\nwith two lines'
				]);
				expect(rows.map((c) => c.id)).not.toContain(other);
			})
	);

	it.effect(
		'lists exactly the envoy threads and automation transcripts a member may open, and refuses a post into either',
		() =>
			Effect.gen(function* () {
				const s = yield* Fixture;
				// the first case's conversations stay in the shared workspace: read only this case's
				s.as('bob');
				const own = (yield* s.list).map((r) => r.id);
				s.as('ann');
				own.push(...(yield* s.list).map((r) => r.id));
				const thread = conversationId('whatsapp', '6590000001@s.whatsapp.net');
				// a public envoy's thread, a private envoy's thread, and an automation's transcript
				yield* s.t.db.write({
					text: `INSERT INTO sys_conversation (id, integration, thread, kind, envoy) VALUES
						($1, 'whatsapp', '6590000001@s.whatsapp.net', 'dm', 'field_ops'),
						('secret1', 'whatsapp', 'x@s.whatsapp.net', 'dm', 'secret')`,
					params: [thread]
				});
				yield* s.t.db.write({
					text: "INSERT INTO sys_conversation (id, title, run, status, model) VALUES ('auto1', 'Nightly sync', 'run1', 'idle', 'default')",
					params: []
				});
				const ids = () =>
					s.list.pipe(Effect.map((rows) => rows.map((r) => r.id).filter((id) => !own.includes(id)).sort()));
				// staff read the public envoy's threads; a private envoy's only once they posted in it; no automations
				expect(yield* ids()).toEqual([thread]);
				yield* s.t.db.write({
					text: "INSERT INTO sys_message (id, conversation, role, content, author) VALUES ('m1', 'secret1', 'user', '{}'::jsonb, 'ann')",
					params: []
				});
				expect(yield* ids()).toEqual(['secret1', thread].sort());
				// automation transcripts are an administrator's
				yield* s.t.db.write({
					text: `UPDATE sys_user SET admin = true, revision = revision + 1 WHERE id = 'ann'`,
					params: []
				});
				expect(yield* ids()).toEqual(['auto1', 'secret1', thread].sort());
				// an external member reads no public envoy's threads (as opening one refuses them)
				yield* s.t.db.write({
					text: `UPDATE sys_user SET kind = 'external', revision = revision + 1 WHERE id = 'bob'`,
					params: []
				});
				s.as('bob');
				expect(yield* ids()).toEqual([]);
				s.as('ann');
				// only Web UI conversations take a post: an envoy thread and an automation transcript refuse even an administrator
				for (const id of [thread, 'auto1']) {
					const posted = yield* Effect.result(s.api.agent.post(id, 'hi'));
					expect(Result.isFailure(posted) || posted.success.kind === 'refused').toBe(true);
				}
			})
	);
});
