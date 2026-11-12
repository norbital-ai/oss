import { with_accounts } from './support/accounts.ts';
import { with_envoys } from './support/envoys.ts';
// The agent's conversation controls over `/__bolt/act` (§5.9's generated actions; parity 2.17, 3.2–3.6, 3.13): the
// author alone revises, reorders and removes queued input; stop, resume, the model class, plan execution and discard;
// an envoy conversation is read-only here (rule 61) and visible only to its own DM sender, a group's participants, or
// any internal member on a `public` envoy — never to an admin as such.
import { describe, expect, it } from '@effect/vitest';
import { afterAll } from 'vitest';
import { Context, Effect, Exit, Layer, Option, Result, Schema, Scope, Stream } from 'effect';
import { decode_projected_manifest } from '../src/engine/manifest.ts';
import { Agents } from '../src/engine/services.ts';
import { Ai, type AiEvent } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { ActReply, AgentRow, WireError } from '../src/protocol/schema.ts';
import { ActRefused, act_failure } from '../src/decl/errors.ts';
import type { Json } from '../src/decl/values.ts';
import type { AiResponse } from '../src/engine/contracts.ts';
import { transcriptRow } from '../src/engine/agent/schema.ts';
import { conversationId } from '../src/engine/conversations/store.ts';
import { KitInvalid, respond_system_1, TestWorkspace } from '../../bolt-cli/src/test/index.ts'; // hook:decisions

const runtime_accounts = [
	{ id: 'field', integration: 'whatsapp' },
	{ id: 'desk', integration: 'whatsapp' },
] as const;

const manifest = Result.getOrThrow(
	decode_projected_manifest({
		workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
		models: {
			quotes: {
				description: 'A quote',
				record_label: 'record.title',
				fields: { title: { kind: 'text' } }
			}
		},
		relationships: {},
		exposures: {
			quotes: {
				outputs: { default: { quotes: { fields: 'all' } } },
				create: { columns: { quotes: ['title'] } }
			}
		},
		policies: { rep: { description: 'Rep', grants: { quotes: { outputs: { default: true } } } } },

		
		agent: { internal: 'Staff brief.', external: 'Customer brief.', skills: {} },
		integrations: {},
		teams: {},
		automations: {},
		mcp: {},
		apps: {},
		custom_fields: {}
	})
);
const fieldEnvoy = '0199a000-0000-7000-8000-0000000000e1';
const deskEnvoy = '0199a000-0000-7000-8000-0000000000e2';
const runtimeEnvoys = [
	{
		id: fieldEnvoy,
		accounts: ['field'],
		audience: 'private',
		name: 'Norbius',
		policies: ['rep'],
		triage: false,
		group_messages: 'mention_or_reply',
		delegation: 'disabled',
		task: 'Help.'
	},
	{
		id: deskEnvoy,
		accounts: ['desk'],
		audience: 'public',
		name: 'Norbius',
		policies: ['rep'],
		triage: false,
		group_messages: 'disabled',
		delegation: 'disabled',
		task: 'Help.'
	}
] as const;

const reply = (text: string): AiResponse => ({
	content: text,
	toolCalls: [],
	finish: 'stop',
	usage: { input: 1, output: 1 }
});

const build = Effect.gen(function* () {
	const answers: string[] = [];
	const ports = Layer.succeed(Ai, {
		ask: respond_system_1,
		maxChoices: undefined,
		models: ['default'],
		catalog: Port.unavailable('ai.catalog'),
		embed: () => Port.unavailable('ai.embed'),
		infer: (req) =>
			Stream.unwrap(
				Effect.sync(() => {
					answers.push(
						req.system?.includes('independent verification') === true ? 'verdict' : 'turn'
					);
					return Stream.fromIterable<AiEvent>([
						{
							_tag: 'Response',
							response: reply(
								req.system?.includes('independent verification') === true
									? JSON.stringify({ complete: true, gaps: [], summary: 'ok' })
									: 'ok'
							)
						}
					]);
				})
			)
	});
	const context = yield* Layer.build(
		with_envoys(with_accounts(TestWorkspace.layer({ manifest, ports }), runtime_accounts), runtimeEnvoys)
	);
	const t = Context.get(context, TestWorkspace),
		agent = Context.get(context, Agents);
	for (const [id, kind, admin, phone] of [
		['ann', 'staff', false, null],
		['bob', 'staff', false, '6590000002'],
		['cus', 'external', false, null],
		['kim', 'staff', false, '6590000001'],
		['adm', 'staff', true, null]
	] as const)
		yield* t.db.write({
			text: `INSERT INTO sys_user (id, email, name, kind, admin, phone) VALUES ($1, $2, $1, $3, $4, $5)`,
			params: [id, `${id}@x.test`, kind, admin, phone]
		});
	// one session per member for the file
	const cookies = new Map<string, string>();
	const call = (as: string, method: string, path: string, body?: unknown) =>
		Effect.gen(function* () {
			let cookie = cookies.get(as);
			if (cookie === undefined) cookies.set(as, (cookie = yield* t.session(as)));
			return yield* t.handle(
				new Request(`http://cell${path}`, {
					method,
					headers: {
						cookie,
						'content-type': 'application/json',
						'Idempotency-Key': crypto.randomUUID()
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) })
				})
			);
		});
	const act = (as: string, callable: string, input: Json) =>
		Effect.gen(function* () {
			const response = yield* call(as, 'POST', '/__bolt/act', {
				callable,
				input,
				issued_at: t.clock.now()
			});
			const raw = yield* Effect.tryPromise({
				try: () => response.json(),
				catch: (error) => new KitInvalid({ message: String(error) })
			});
			const refused = Schema.decodeUnknownOption(WireError)(raw);
			if (Option.isSome(refused)) {
				const { _tag, ...fields } = ActRefused.fields;
				void _tag;
				const failure = yield* Schema.decodeUnknownEffect(
					Schema.Struct({ error: Schema.Struct(fields) })
				)(raw);
				return yield* Effect.fail(new ActRefused(failure.error));
			}
			const outcome = (yield* Schema.decodeUnknownEffect(ActReply)(raw)).outcome;
			const failure = act_failure(outcome);
			return Option.isSome(failure) ? yield* Effect.fail(failure.value) : outcome;
		});
	const rows = (c: string) =>
		t.db
			.read([
				{
					text: `SELECT id, text, state FROM sys_message WHERE conversation = $1 ORDER BY seq`,
					params: [c]
				}
			])
			.pipe(Effect.map((r) => r[0]?.rows ?? []));
	return { t, agent, call, act, rows, answers };
});
// One workspace and its members for the file; each test starts its own conversations.
const fileScope = Effect.runSync(Scope.make());
afterAll(() => Effect.runPromise(Scope.close(fileScope, Exit.void)));
const setup = Effect.runSync(Effect.cached(build.pipe(Scope.provide(fileScope))));

describe('conversation controls over /__bolt/act', () => {
	it.live(
		'only the author revises, reorders and removes queued input; stop, resume, the model class, and a plan executed or discarded',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, agent, act, rows, answers } = yield* setup;
					const c = yield* agent.start({ owner: 'ann' });
					const [one, two, three] = [
						yield* agent.post({ conversation: c, as: { member: 'ann' }, text: 'one' }),
						yield* agent.post({ conversation: c, as: { member: 'ann' }, text: 'two' }),
						yield* agent.post({ conversation: c, as: { member: 'ann' }, text: 'three' })
					];
					expect(
						yield* Effect.flip(
							act('bob', 'sys_message.revise', { message: one.id, text: 'hijack' })
						)
					).toMatchObject({ _tag: 'ActRefused', code: 'not_found' });
					expect(
						yield* act('ann', 'sys_message.reorder', {
							conversation: c,
							messages: [three.id, one.id, two.id]
						})
					).toMatchObject({ kind: 'committed' });
					expect(yield* act('ann', 'sys_message.dequeue', { message: two.id })).toMatchObject({
						kind: 'committed'
					});
					expect((yield* rows(c)).map((r) => [r['text'], r['state']])).toEqual([
						['three', 'queued'],
						['one', 'queued'],
						['two', 'cancelled']
					]);
					expect(
						yield* Effect.flip(
							act('ann', 'sys_conversation.set_model', { conversation: c, model: 'vision' })
						)
					).toMatchObject({ _tag: 'ActRefused' });
					expect(
						yield* act('ann', 'sys_message.revise', { message: one.id, text: 'one, revised' })
					).toMatchObject({ kind: 'committed' });
					yield* t.settled();
					expect((yield* rows(c)).find((r) => r['id'] === one.id)).toMatchObject({
						text: 'one, revised',
						state: 'consumed'
					});
					expect(yield* act('ann', 'sys_conversation.stop', { conversation: c })).toMatchObject({
						kind: 'committed'
					});
					expect((yield* agent.conversation(c)).status).toBe('stopped');
					yield* act('ann', 'sys_conversation.resume', { conversation: c });
					yield* t.settled();
					expect((yield* agent.conversation(c)).status).toBe('idle');
					yield* t.db.write({
						text: `UPDATE sys_conversation SET plan = '{"revision":1,"body":"1. Say ok","status":"draft","checkpoint":0,"verdicts":0}' WHERE id = $1`,
						params: [c]
					});
					expect(
						yield* Effect.flip(act('bob', 'sys_message.execute_plan', { conversation: c }))
					).toMatchObject({ _tag: 'ActRefused', code: 'not_found' });
					yield* act('ann', 'sys_message.execute_plan', { conversation: c });
					yield* t.settled();
					expect((yield* agent.conversation(c)).plan).toMatchObject({ status: 'verified' });
					expect(answers.at(-1)).toBe('verdict');
					yield* act('ann', 'sys_message.discard_plan', { conversation: c });
					expect((yield* agent.conversation(c)).plan).toBeNull();
				})
			)
	);

	it.live(
		'restarts at an arbitrary earlier input in a new chat, preserving the original and keeping copied controls inactive',
		() => Effect.scoped(Effect.gen(function* () {
			const { t, agent, call, act } = yield* setup;
			const original = yield* agent.start({ owner: 'ann' });
			const ids = Array.from({ length: 8 }, (): string => crypto.randomUUID());
			const [first, assistant, tool, question, report, second, answer, third] = ids;
			if (first === undefined || assistant === undefined || tool === undefined || question === undefined || report === undefined || second === undefined || answer === undefined || third === undefined)
				throw new Error('restart fixture needs eight native messages');
			const stored: readonly { id: string; role: 'user' | 'assistant' | 'tool'; text: string | null; content: Json; state: 'consumed' | null; meta: Json }[] = [
				{ id: first, role: 'user', text: 'First question', content: { text: 'First question' }, state: 'consumed', meta: null },
				{ id: assistant, role: 'assistant', text: '', content: { text: '', toolCalls: [{ id: 'historical-page', name: 'page', input: { path: '/inbox' } }] }, state: null, meta: null },
				{ id: tool, role: 'tool', text: null, content: { id: 'historical-page', assistant, name: 'page', behavior: { page: true }, result: { navigation: '/inbox', page: { click: 'Open' }, requested: true } }, state: null, meta: null },
				{ id: question, role: 'assistant', text: '', content: { text: '' }, state: null, meta: { tag: 'reply', receipts: [], asked: true, question: { question: 'Which account?', options: ['Singapore', 'Malaysia'] } } },
				{ id: report, role: 'assistant', text: 'Research completed.', content: { text: 'Research completed.' }, state: null, meta: { tag: 'report', conversation: 'historical-child', asked: true } },
				{ id: second, role: 'user', text: 'Restart from this earlier question', content: { text: 'Restart from this earlier question' }, state: 'consumed', meta: null },
				{ id: answer, role: 'assistant', text: 'Second answer', content: { text: 'Second answer' }, state: null, meta: { tag: 'reply', receipts: [] } },
				{ id: third, role: 'user', text: 'Latest question', content: { text: 'Latest question' }, state: 'consumed', meta: null }
			];
			for (const row of stored)
				yield* t.db.write({ text: `INSERT INTO sys_message (id,conversation,role,text,content,state,mode,"as",author,meta)
					VALUES ($1,$2,$3,$4,$5::jsonb,$6,'agent',$7::jsonb,$8,$9::jsonb)`, params: [row.id, original, row.role, row.text, row.content, row.state, row.role === 'user' ? { member: 'ann' } : null, row.role === 'user' ? 'ann' : null, row.meta] });
			const before = yield* agent.transcript(original);
			expect(before.flatMap((row) => row.id === question ? [transcriptRow(row, true, false)] : [])).toMatchObject([{ asked: true, question: { question: 'Which account?' } }]);
			expect(before.flatMap((row) => row.id === report ? [transcriptRow(row, true, false)] : [])).toMatchObject([{ report: { conversation: 'historical-child', asked: true } }]);
			expect(yield* Effect.flip(act('bob', 'sys_message.restart', { message: second }))).toMatchObject({ _tag: 'ActRefused', code: 'not_found' });
			const restarted = yield* Schema.decodeUnknownEffect(Schema.Struct({ kind: Schema.Literal('committed'), output: Schema.Struct({ conversation: Schema.String, message: AgentRow }) }))(yield* act('ann', 'sys_message.restart', { message: second }));
			expect(restarted.output.conversation).not.toBe(original);
			expect(restarted.output.message).toMatchObject({ id: second, text: 'Restart from this earlier question' });
			expect(yield* agent.transcript(original)).toEqual(before);
			const copied = yield* agent.transcript(restarted.output.conversation);
			expect(copied.filter((row) => row.copied_from != null).map((row) => row.copied_from)).toEqual([first, assistant, tool, question, report]);
			expect(copied.find((row) => row.copied_from === report)?.text).toBe('Research completed.');
			expect(copied.every((row) => !ids.includes(row.id))).toBe(true);
			expect(copied.some((row) => row.text === 'Latest question')).toBe(false);
			expect(yield* agent.conversation(restarted.output.conversation)).toMatchObject({ status: 'idle', owner: 'ann', parent: null, plan: null });
			const response = yield* call('ann', 'GET', `/__bolt/agent?conversation=${restarted.output.conversation}`);
			const raw = yield* Effect.tryPromise({ try: () => response.json(), catch: (error) => new KitInvalid({ message: String(error) }) });
			const projected = yield* Schema.decodeUnknownEffect(Schema.Struct({ value: Schema.Struct({ rows: Schema.Array(AgentRow) }) }))(raw);
			for (const row of projected.value.rows) {
				expect(row.call).toBeUndefined();
				expect(row.tool?.navigation).toBeUndefined();
				expect(row.tool?.page).toBeUndefined();
				expect(row.tool?.runs).toBeUndefined();
				expect(row.question).toBeUndefined();
				expect(row.asked).toBeUndefined();
				expect(row.report).toBeUndefined();
			}
		}))
	);

	it.live(
		"the owner stops a sub-agent of their conversation, no one else; a transcript's act step names the runs it started",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, agent, call, act } = yield* setup;
					const c = yield* agent.start({ owner: 'ann' });
					const child = yield* agent.start({ owner: 'ann', parent: c });
					expect(
						yield* Effect.flip(act('bob', 'sys_conversation.stop', { conversation: child }))
					).toMatchObject({ _tag: 'ActRefused', code: 'not_found' });
					expect(yield* act('ann', 'sys_conversation.stop', { conversation: child })).toMatchObject(
						{ kind: 'committed' }
					);
					expect((yield* agent.conversation(child)).status).toBe('stopped');
					// one write's queued run, a started run, and a batch's results: each run once
					for (const [i, result] of [
						{ kind: 'committed', runs: [{ run: 'r1', automation: 'tidy' }] },
						{ run: 'r2', outcome: { kind: 'committed' } },
						{ results: [{ run: 'r2', alreadyActive: true }, { kind: 'committed' }, { run: 'r3' }] }
					].entries()) {
						const assistant = crypto.randomUUID();
						yield* t.db.write({
							text: `INSERT INTO sys_message (id,conversation,role,content) VALUES ($1,$2,'assistant',$3::jsonb)`,
							params: [assistant, c, { text: '', toolCalls: [{ id: `call-${i}`, name: 'act', input: {} }] }]
						});
						yield* t.db.write({
							text: `INSERT INTO sys_message (id, conversation, role, content) VALUES ($1, $2, 'tool', $3::jsonb)`,
							params: [
								crypto.randomUUID(),
								c,
								JSON.stringify({ id: `call-${i}`, assistant, name: 'act', behavior: { data: true }, args: '{}', result })
							]
						});
					}
					const response = yield* call('ann', 'GET', `/__bolt/agent?conversation=${c}`);
					const body = yield* Effect.tryPromise({
						try: () => response.json(),
						catch: (error) => new KitInvalid({ message: String(error) })
					});
					const { value } = yield* Schema.decodeUnknownEffect(
						Schema.Struct({ value: Schema.Struct({ rows: Schema.Array(AgentRow) }) })
					)(body);
					expect(value.rows.flatMap((row) => row.tool === undefined ? [] : [row.tool.runs])).toEqual([['r1'], ['r2'], ['r2', 'r3']]);
				})
			)
	);

	it.live(
		'an envoy conversation is read-only: no reply, stop or post; seen by its DM sender, group participants, or anyone internal on a public envoy',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, call, act } = yield* setup;
					expect(yield* t.db.rows(Schema.Struct({ id: Schema.String, status: Schema.Null }), {
						text: `SELECT id, status FROM sys_integration WHERE id IN ('field', 'desk') ORDER BY id`, params: []
					})).toEqual([{ id: 'desk', status: null }, { id: 'field', status: null }]);
					const say = (
						instance: string,
						id: string,
						thread: string,
						handle: string,
						extra: { group?: true; invocation?: 'mention' } = {}
					) =>
						t.receive(instance, {
							id,
							thread,
							sent_at: t.clock.now(),
							from: { handle, name: id },
							text: 'hello?',
							attachments: [],
							...extra
						});
					const sees = (as: string, c: string) =>
						call(as, 'GET', `/__bolt/agent?conversation=${c}`).pipe(Effect.map((r) => r.status));
					// a private envoy's DM: its linked sender alone; not other staff, not an admin, not an external member
					yield* say('field', 'w1', '6590000001@s.whatsapp.net', '6590000001@s.whatsapp.net');
					const dm = conversationId('field', '6590000001@s.whatsapp.net');
					expect(yield* sees('kim', dm)).toBe(200);
					for (const who of ['ann', 'adm']) expect(yield* sees(who, dm)).toBe(404);
					// nobody speaks into it or drives its agent from the chat UI
					expect(
						yield* call('kim', 'POST', '/__bolt/act', {
							callable: 'sys_message.reply',
							input: { conversation: dm, text: 'x' },
							issued_at: t.clock.now()
						})
					).toMatchObject({ status: 404 });
					expect(
						yield* Effect.flip(act('kim', 'sys_conversation.stop', { conversation: dm }))
					).toMatchObject({ _tag: 'ActRefused', code: 'not_found' });
					expect(
						yield* Effect.flip(act('kim', 'sys_message.post', { conversation: dm, text: 'x' }))
					).toMatchObject({ _tag: 'ActRefused', code: 'not_found' });
					// a group: whoever posted in it
					yield* say('field', 'g1', '1203@g.us', '6590000002@s.whatsapp.net', {
						group: true,
						invocation: 'mention'
					});
					const group = conversationId('field', '1203@g.us');
					expect(yield* sees('bob', group)).toBe(200);
					for (const who of ['kim', 'adm']) expect(yield* sees(who, group)).toBe(404);
					// a public envoy: any internal member, never an external one
					yield* say('desk', 'p1', '6599999999@s.whatsapp.net', '6599999999@s.whatsapp.net');
					const pub = conversationId('desk', '6599999999@s.whatsapp.net');
					expect(yield* sees('ann', pub)).toBe(200);
					expect(yield* sees('cus', pub)).toBe(404);
				})
			)
	);
});
