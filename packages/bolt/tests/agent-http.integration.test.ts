// The agent's conversation controls over `/__bolt/act` (§5.9's generated actions; parity 2.17, 3.2–3.6, 3.13): the
// author alone revises, reorders and removes queued input; stop, resume, the model class, plan execution and discard;
// an envoy conversation is read-only here (rule 61) and visible only to its own DM sender, a group's participants, or
// any internal member on a `public` envoy — never to an admin as such.
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Option, Result, Schema, Stream } from 'effect';
import { decodeManifest } from '../src/engine/manifest.ts';
import { Agents } from '../src/engine/services.ts';
import { Ai, type AiEvent } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { ActReply, AgentRow, WireError } from '../src/protocol/schema.ts';
import { ActRefused, actFailure } from '../src/decl/errors.ts';
import type { Json } from '../src/decl/values.ts';
import type { AiResponse } from '../src/engine/contracts.ts';
import { conversationId } from '../src/engine/conversations/store.ts';
import { KitInvalid, respondSystem1, TestWorkspace } from '../src/test/index.ts'; // hook:decisions

const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
		models: {
			quotes: { description: 'A quote', label: 'title', fields: { title: { kind: 'text' } } }
		},
		relationships: {},
		exposures: {
			quotes: { read: { quotes: { fields: 'all' } }, create: { columns: { quotes: ['title'] } } }
		},
		policies: { rep: { description: 'Rep', grants: { quotes: { read: true } } } },
		envoys: {
			field: {
				audience: 'private',
				name: 'Norbius',
				policies: ['rep'],
				triage: false,
				groupMessages: 'mention_or_reply',
				delegation: 'disabled',
				task: 'Help.'
			},
			desk: {
				audience: 'public',
				name: 'Norbius',
				policies: ['rep'],
				triage: false,
				groupMessages: 'disabled',
				delegation: 'disabled',
				task: 'Help.'
			}
		},
		connections: {
			field: { integration: 'whatsapp', envoy: 'field' },
			desk: { integration: 'whatsapp', envoy: 'desk' }
		},
		agent: { internal: 'Staff brief.', external: 'Customer brief.', skills: {} },
		integrations: {},
		teams: {},
		automations: {},
		mcp: {},
		apps: {},
		customFields: {}
	})
);

const reply = (text: string): AiResponse => ({
	content: text,
	toolCalls: [],
	finish: 'stop',
	usage: { input: 1, output: 1 }
});

const setup = () =>
	Effect.gen(function* () {
		const answers: string[] = [];
		const ports = Layer.succeed(Ai, {
			ask: respondSystem1,
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
		const context = yield* Layer.build(TestWorkspace.layer({ manifest, ports }));
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
		const call = (as: string, method: string, path: string, body?: unknown) =>
			Effect.gen(function* () {
				return yield* t.handle(
					new Request(`http://cell${path}`, {
						method,
						headers: {
							cookie: yield* t.session(as),
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
					issuedAt: t.clock.now()
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
				const failure = actFailure(outcome);
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

describe('conversation controls over /__bolt/act', () => {
	it.live(
		'only the author revises, reorders and removes queued input; stop, resume, the model class, and a plan executed or discarded',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, agent, act, rows, answers } = yield* setup();
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
					).toMatchObject({ _tag: 'ActRefused', code: 'notFound' });
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
							act('ann', 'sys_conversation.setModel', { conversation: c, model: 'vision' })
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
						yield* Effect.flip(act('bob', 'sys_message.executePlan', { conversation: c }))
					).toMatchObject({ _tag: 'ActRefused', code: 'notFound' });
					yield* act('ann', 'sys_message.executePlan', { conversation: c });
					yield* t.settled();
					expect((yield* agent.conversation(c)).plan).toMatchObject({ status: 'verified' });
					expect(answers.at(-1)).toBe('verdict');
					yield* act('ann', 'sys_message.discardPlan', { conversation: c });
					expect((yield* agent.conversation(c)).plan).toBeNull();
				})
			)
	);

	it.live(
		"the owner stops a sub-agent of their conversation, no one else; a transcript's act step names the runs it started",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, agent, call, act } = yield* setup();
					const c = yield* agent.start({ owner: 'ann' });
					const child = yield* agent.start({ owner: 'ann', parent: c });
					expect(
						yield* Effect.flip(act('bob', 'sys_conversation.stop', { conversation: child }))
					).toMatchObject({ _tag: 'ActRefused', code: 'notFound' });
					expect(yield* act('ann', 'sys_conversation.stop', { conversation: child })).toMatchObject(
						{ kind: 'committed' }
					);
					expect((yield* agent.conversation(child)).status).toBe('stopped');
					// one write's queued run, a started run, and a batch's results: each run once
					for (const [i, result] of [
						{ kind: 'committed', runs: [{ run: 'r1', automation: 'tidy' }] },
						{ run: 'r2', outcome: { kind: 'committed' } },
						{ results: [{ run: 'r2', alreadyActive: true }, { kind: 'committed' }, { run: 'r3' }] }
					].entries())
						yield* t.db.write({
							text: `INSERT INTO sys_message (id, conversation, role, content) VALUES ($1, $2, 'tool', $3::jsonb)`,
							params: [
								crypto.randomUUID(),
								c,
								JSON.stringify({ id: `call-${i}`, name: 'act', args: '{}', result })
							]
						});
					const response = yield* call('ann', 'GET', `/__bolt/agent?conversation=${c}`);
					const body = yield* Effect.tryPromise({
						try: () => response.json(),
						catch: (error) => new KitInvalid({ message: String(error) })
					});
					const { value } = yield* Schema.decodeUnknownEffect(
						Schema.Struct({ value: Schema.Struct({ rows: Schema.Array(AgentRow) }) })
					)(body);
					expect(value.rows.map((r) => r.tool?.runs)).toEqual([['r1'], ['r2'], ['r2', 'r3']]);
				})
			)
	);

	it.live(
		'an envoy conversation is read-only: no reply, stop or resume; seen by its DM sender, group participants, or anyone internal on a public envoy',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, call, act } = yield* setup();
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
							sentAt: t.clock.now(),
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
					for (const who of ['ann', 'adm', 'cus', 'bob']) expect(yield* sees(who, dm)).toBe(404);
					// nobody speaks into it or drives its agent from the chat UI
					expect(
						(yield* call('kim', 'POST', '/__bolt/act', {
							callable: 'sys_message.reply',
							input: { conversation: dm, text: 'x' },
							issuedAt: t.clock.now()
						}))!.status
					).toBe(404);
					expect(
						yield* Effect.flip(act('kim', 'sys_conversation.stop', { conversation: dm }))
					).toMatchObject({ _tag: 'ActRefused', code: 'notFound' });
					expect(
						yield* Effect.flip(act('kim', 'sys_conversation.resume', { conversation: dm }))
					).toMatchObject({ _tag: 'ActRefused', code: 'notFound' });
					expect(
						yield* Effect.flip(act('kim', 'sys_message.post', { conversation: dm, text: 'x' }))
					).toMatchObject({ _tag: 'ActRefused', code: 'notFound' });
					// a group: whoever posted in it
					yield* say('field', 'g1', '1203@g.us', '6590000002@s.whatsapp.net', {
						group: true,
						invocation: 'mention'
					});
					const group = conversationId('field', '1203@g.us');
					expect(yield* sees('bob', group)).toBe(200);
					for (const who of ['kim', 'ann', 'adm', 'cus']) expect(yield* sees(who, group)).toBe(404);
					// a public envoy: any internal member, never an external one
					yield* say('desk', 'p1', '6599999999@s.whatsapp.net', '6599999999@s.whatsapp.net');
					const pub = conversationId('desk', '6599999999@s.whatsapp.net');
					for (const who of ['ann', 'adm', 'kim']) expect(yield* sees(who, pub)).toBe(200);
					expect(yield* sees('cus', pub)).toBe(404);
				})
			)
	);
});
