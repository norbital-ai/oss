// P4 gaps over the host half on PGlite: the in-app agent's `/__bolt` callables (`sys_conversation.start`,
// `sys_message.post`, `sys_message.confirm`) with the transcript; web push of inbox notices through `bolt.push`.
import { describe, expect, layer } from '@effect/vitest';
import { Context, Effect, Layer, Option, Result, Schema } from 'effect';
import { actFailure } from '../src/decl/errors.ts';
import type { Json } from '../src/decl/values.ts';
import type { AiResponse, ActOutcome as Outcome } from '../src/engine/contracts.ts';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { AgentRow } from '../src/protocol/schema.ts';
import { actReply, json, routeFixture } from './support/route-fixture.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { TestWorkspace, type Kit, type WorkspaceServices } from '../../bolt-cli/src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } }, // hook:decisions — not a triage test (rule 60a opt-out)
		models: {
			quotes: { description: 'A quote', label: 'title', fields: { title: { kind: 'text' } } },
			logs: { description: 'A log line', label: 'line', fields: { line: { kind: 'text' } } }
		},
		relationships: {},
		exposures: {
			quotes: {
				read: { quotes: { fields: 'all' } },
				create: { columns: { quotes: ['title'] } },
				effect: { created: true }
			},
			logs: { read: { logs: { fields: 'all' } }, create: { columns: { logs: ['line'] } } }
		},
		policies: {
			rep: {
				description: 'Rep',
				grants: {
					quotes: { read: true, create: true },
					logs: { read: true, create: true }
				},
				automations: ['quotes_mark']
			}
		},
		automations: {
			quotes_mark: {
				description: 'Mark a quote',
				input: { title: { kind: 'text' } },
				output: { kind: 'text' },
				policies: ['rep'],
				agent: 'confirm'
			}
		},
		envoys: {},
		agent: { internal: 'Staff brief.', skills: {} },
		integrations: {},
		teams: { rep: ['rep'] },
		connections: {},
		mcp: {},
		apps: {},
		customFields: {}
	})
);
const guest = {
	source: `export default {
	model: { quotes: { bodies: { effect: { created: function* (rows, ctx) {
		for (const { id } of rows) yield* ctx.act('logs.create', [{ line: 'quote ' + id }]);
		yield* ctx.notify({ to: [{ policy: 'rep' }], title: 'Logged' });
	} } } } },
	automation: {
	quotes_mark: { body: function* (input, ctx) { return (yield* ctx.act('quotes.create', [{ title: input.title }])).records[0].id; } } },
};`
};

type Step = () => AiResponse;
const say =
	(text: string): Step =>
	() => ({ content: text, toolCalls: [], finish: 'stop', usage: { input: 10, output: 5 } });
const use =
	(name: string, input: Json, id: string): Step =>
	() => ({
		content: '',
		toolCalls: [{ id, name, input }],
		finish: 'tool',
		usage: { input: 10, output: 5 }
	});
// one workspace per file; only the first test's agent turn reads the cassette, and each test has its own members
const workspace = Layer.unwrap(
	Effect.map(program(guest.source), (guest) =>
		TestWorkspace.layer({
			manifest,
			guest,
			fakes: {
				ai: {
					cassette: {
						default: [
							use('act', { callable: 'automation.quotes_mark', input: { title: 'Chair' } }, 'k1'),
							say('Marked.')
						].map((step) => step())
					}
				}
			}
		})
	)
);
const setup = () =>
	Effect.gen(function* () {
		const context = yield* Effect.context<TestWorkspace | WorkspaceServices>();
		const t = Context.get(context, TestWorkspace),
			route = yield* routeFixture(context),
			authorities = new Authorities(manifest, 'test');
		const user = (id: string, options: { external?: boolean } = {}) =>
			t.db
				.write({
					text: `INSERT INTO sys_user (id, email, name, kind, team) VALUES ($1, $2, $3, $4, 'rep') ON CONFLICT (id) DO NOTHING`,
					params: [id, `${id}@x.test`, id, options.external ? 'external' : 'staff']
				})
				.pipe(Effect.map(() => id));
		const authority = (id: string) =>
			authorities.member(t.db, id).pipe(
				Effect.map((value) => {
					if (value === null) throw new Error('member authority missing');
					return value;
				})
			);
		const call = (as: string, method: string, path: string, body?: Json) =>
			Effect.gen(function* () {
				return yield* route.handle(
					yield* authority(as),
					new Request(`http://cell${path}`, {
						method,
						headers: { 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
						...(body === undefined ? {} : { body: JSON.stringify(body) })
					})
				);
			});
		const act = (as: string, callable: string, input: Json) =>
			Effect.gen(function* () {
				const reply = yield* actReply(route, yield* authority(as), {
					callable,
					input,
					issuedAt: t.clock.now()
				});
				const failure = actFailure(reply.outcome);
				if (Option.isSome(failure)) return yield* Effect.fail(failure.value);
				return reply.outcome;
			});
		const transcript = (as: string, conversation: string) =>
			Effect.gen(function* () {
				const response = yield* call(as, 'GET', `/__bolt/agent?conversation=${conversation}`);
				const rows = response.ok
					? (yield* Schema.decodeUnknownEffect(
							Schema.Struct({ value: Schema.Struct({ rows: Schema.Array(AgentRow) }) })
						)(yield* json(response))).value.rows
					: undefined;
				return { status: response.status, rows };
			});
		return { t, bolt: route, user, call, act, transcript, authorities };
	});
const output = (o: Outcome) => {
	if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
	return Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(o.output);
};
const required = <T>(value: T | undefined): T => {
	if (value === undefined) throw new Error('fixture value missing');
	return value;
};
const NoticeEvent = Schema.fromJsonString(
	Schema.Struct({
		id: Schema.String,
		title: Schema.String,
		body: Schema.NullOr(Schema.String),
		path: Schema.String
	})
);
/** The next `data:` event of an SSE body (its `id:` too), within 10 s. */
const sseEvents = (body: ReadableStream<Uint8Array>) => {
	const reader = body.getReader(),
		decoder = new TextDecoder();
	let buffer = '';
	return Effect.gen(function* () {
		for (;;) {
			const end = buffer.indexOf('\n\n');
			if (end >= 0) {
				const block = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				const data = /^data: ?(.*)$/m.exec(block)?.[1];
				if (data === undefined) continue;
				return {
					id: /^id: ?(.*)$/m.exec(block)?.[1],
					data: yield* Schema.decodeUnknownEffect(NoticeEvent)(data)
				};
			}
			const chunk = yield* Effect.promise(() => reader.read());
			if (chunk.done) return yield* Effect.die('the notice stream ended');
			buffer += decoder.decode(chunk.value, { stream: true });
		}
	}).pipe(Effect.timeout('10 seconds'));
};
const quotes = (t: Kit) =>
	t.db.rows(Schema.Struct({ title: Schema.String }), {
		text: 'SELECT title FROM quotes ORDER BY title',
		params: []
	});

layer(workspace, { excludeTestServices: true })('p4 gaps', (it) => {
	describe('the in-app agent over /__bolt (§5.9)', () => {
		it.effect('starts a conversation and queues a confirmed automation only for its person', () =>
			Effect.gen(function* () {
				const { t, bolt, user, act, transcript } = yield* setup();
				const ann = yield* user('ann'),
					bob = yield* user('bob');
				const c = output(yield* act(ann, 'sys_conversation.start', { title: 'Help' })).id;
				const posted = yield* act(ann, 'sys_message.post', {
					conversation: c,
					text: 'mark a chair'
				});
				expect(posted.kind).toBe('committed');
				yield* bolt.settled;
				const held = required(
					required((yield* transcript(ann, c)).rows).find((r) => r.state === 'confirm')
				);
				expect(held).toMatchObject({
					tag: 'confirm',
					call: { name: 'act', input: { callable: 'automation.quotes_mark' } }
				});
				expect(yield* quotes(t)).toEqual([]);
				// another member sees neither the transcript nor the card
				expect((yield* transcript(bob, c)).status).toBe(404);
				expect(
					yield* act(bob, 'sys_message.confirm', { message: held.id, approve: true }).pipe(
						Effect.flip
					)
				).toMatchObject({ _tag: 'ActRefused', code: 'notFound' });
				expect(
					(yield* act(ann, 'sys_message.confirm', { message: held.id, approve: true })).kind
				).toBe('committed');
				yield* bolt.settled;
				expect(yield* quotes(t)).toEqual([]);
				expect(
					yield* t.db.rows(Schema.Struct({ state: Schema.String }), {
						text: "SELECT state FROM sys_run WHERE automation = 'quotes_mark'",
						params: []
					})
				).toEqual([{ state: 'queued' }]);
				const reply = required(required((yield* transcript(ann, c)).rows).at(-1));
				expect(reply).toMatchObject({
					role: 'assistant',
					text: 'Marked.',
					receipts: [{ outcome: 'committed', callable: 'automation.quotes_mark' }]
				});
				yield* t.runDue();
				expect(yield* quotes(t)).toEqual([{ title: 'Chair' }]);
				const quoteId = yield* t.db.value(Schema.String, {
					text: 'SELECT id FROM quotes',
					params: []
				});
				expect(
					yield* t.db.rows(Schema.Struct({ state: Schema.String, output: Schema.Json }), {
						text: "SELECT state, output FROM sys_run WHERE automation = 'quotes_mark'",
						params: []
					})
				).toEqual([{ state: 'succeeded', output: quoteId }]);
			})
		);

		it.effect(
			"refuses members the workspace gives no assistant, and a body that is not the callable's",
			() =>
				Effect.gen(function* () {
					const { user, act, call } = yield* setup();
					const ext = yield* user('ext', { external: true });
					expect(yield* act(ext, 'sys_conversation.start', {}).pipe(Effect.flip)).toMatchObject({
						_tag: 'ActRefused',
						code: 'forbidden'
					});
					const dan = yield* user('dan');
					const res = yield* call(dan, 'POST', '/__bolt/act', {
						callable: 'sys_message.post',
						input: { conversation: 1 },
						issuedAt: '2026-09-25T10:00:00.000Z'
					});
					expect(res.status).toBe(400);
				})
		);
	});

	describe('push and the notice stream (§5.7)', () => {
		it.effect(
			'stores web and apns subscriptions and pushes each notice to the devices of the members it addresses, from a run',
			() =>
				Effect.gen(function* () {
					const { t, user, call, act } = yield* setup();
					const eve = yield* user('eve');
					const token = 'ab'.repeat(32),
						keys = { topic: 'ai.norbital.app', environment: 'production', teamId: 'TEAM123456' };
					expect(
						(yield* call(eve, 'POST', '/__bolt/push', { endpoint: 'http://insecure' })).status
					).toBe(400);
					expect(
						(yield* call(eve, 'POST', '/__bolt/push', { kind: 'apns', endpoint: 'not-hex', keys }))
							.status
					).toBe(400);
					// with no device subscribed, a notice queues no push run
					yield* t.db.write({
						text: `INSERT INTO sys_notification (id, recipient, title, at) VALUES ('n0', '{"user":"eve"}', 'Early', now())`,
						params: []
					});
					const pushRuns = t.db.value(Schema.Number, {
						text: `SELECT count(*)::int AS n FROM sys_run WHERE automation = 'bolt.push'`,
						params: []
					});
					expect(yield* pushRuns).toBe(0);
					const web = {
						kind: 'web',
						endpoint: 'https://push.example/eve',
						keys: { p256dh: 'k', auth: 'a' }
					};
					expect((yield* call(eve, 'POST', '/__bolt/push', web)).status).toBe(204);
					expect(
						(yield* call(eve, 'POST', '/__bolt/push', { kind: 'apns', endpoint: token, keys }))
							.status
					).toBe(204);
					// an automation's notice (a guest `ctx.notify` inside its run's statement) is pushed by the next wake
					yield* act(eve, 'quotes.create', [{ title: 'Desk' }]);
					yield* t.runDue();
					const pushed = () => t.fakes.sent.filter((message) => message._tag === 'Push');
					expect(pushed()).toHaveLength(2);
					expect(pushed()).toEqual(
						expect.arrayContaining([
							expect.objectContaining({ subscription: web, title: 'Logged', path: '/inbox' }),
							expect.objectContaining({
								subscription: { kind: 'apns', endpoint: token, keys },
								title: 'Logged',
								path: '/inbox'
							})
						])
					);
					expect(
						(yield* call(eve, 'POST', '/__bolt/push', { endpoint: web.endpoint, remove: true }))
							.status
					).toBe(204);
					expect(
						yield* t.db.value(Schema.Number, {
							text: `SELECT count(*)::int AS n FROM bolt_push_subscriptions WHERE kind = 'web'`,
							params: []
						})
					).toBe(0);
				})
		);

		it.effect(
			'refuses a signed-out caller, replays unread notices after Last-Event-ID, then streams each new one',
			() =>
				Effect.gen(function* () {
					const { t, bolt, user, act, authorities } = yield* setup();
					const cat = yield* user('cat');
					expect((yield* bolt.handle(null, new Request('http://cell/__bolt/notices'))).status).toBe(
						401
					);
					yield* t.db.write({
						text: `INSERT INTO sys_notification (id, recipient, member, title, at) VALUES
						('old', '{"user":"cat"}', 'cat', 'Old', '2020-01-01T00:00:00Z'),
						('mid', '{"user":"cat"}', 'cat', 'Missed', '2020-01-02T00:00:00Z')`,
						params: []
					});
					const authority = required((yield* authorities.member(t.db, cat)) ?? undefined);
					const response = yield* bolt.handle(
						authority,
						new Request('http://cell/__bolt/notices', {
							headers: { 'Last-Event-ID': '2020-01-01T00:00:00.000Z' }
						})
					);
					expect(response.status).toBe(200);
					expect(response.headers.get('content-type')).toContain('text/event-stream');
					const next = sseEvents(required(response.body ?? undefined));
					// the notice missed since the last event replays; the one before it does not
					const missed = yield* next;
					expect(missed.data).toEqual({ id: 'mid', title: 'Missed', body: null, path: '/inbox' });
					expect(Date.parse(missed.id ?? '')).toBe(Date.parse('2020-01-02T00:00:00Z'));
					// an automation's notice reaches the open stream as it commits
					yield* act(cat, 'quotes.create', [{ title: 'Desk' }]);
					yield* t.runDue();
					expect((yield* next).data).toMatchObject({ title: 'Logged', body: null, path: '/inbox' });
				})
		);
	});
});
