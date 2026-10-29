// In-app Norbius attachments (§5.9, rule 58): a panel upload to `sys_conversation.inputs` rides `sys_message.post` as a
// stored FileRef on the row; the agent reads it with `read_file`; triage's state carries it (P37); only the
// member's own uploads attach, 8 files / 20 MiB, the envoy's media types.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { afterAll } from 'vitest';
import { Context, Effect, Exit, Layer, Option, Result, Schema, Scope, Stream } from 'effect';
import { Ai } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import { ActReply, WireError } from '../src/protocol/schema.ts';
import { ActRefused, actFailure } from '../src/decl/errors.ts';
import type { Json } from '../src/decl/values.ts';
import type {
	AiRequest,
	AiResponse,
	Authority,
	ActOutcome as Outcome
} from '../src/engine/contracts.ts';
import type { System1Request } from '../src/engine/decisions/index.ts';
import { upload } from '../src/engine/callables/upload.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { KitInvalid, TestWorkspace, type Kit } from '../../bolt-cli/src/test/index.ts';
import { actReply, routeFixture } from './support/route-fixture.ts';
import { filesOf } from '../src/engine/conversations/store.ts';

// One workspace: triage on (the in-app default), a model whose records carry a file.
const manifest = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			photos: {
				description: 'A photo',
				label: 'title',
				fields: {
					title: { kind: 'text' },
					file: { kind: 'file', accept: ['image/*'], max: '1MiB' }
				}
			}
		},
		relationships: {},
		exposures: {
			photos: {
				read: { photos: { fields: 'all' } },
				create: { columns: { photos: ['title', 'file'] } }
			}
		},
		policies: { inspector: { description: 'Inspectors', grants: { photos: { read: true } } } },
		teams: { Inspectors: ['inspector'] },
		agent: { internal: 'Staff brief.', skills: {} },
		integrations: {},
		automations: {},
		connections: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {}
	})
);
const fileOf = (value: unknown) =>
	Schema.decodeUnknownSync(
		Schema.Struct({ kind: Schema.Literal('committed'), output: Schema.Json })
	)(value).output;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

const act = (t: Kit, as: string, callable: string, input: Json) =>
	Effect.gen(function* () {
		const response = yield* t.handle(
			new Request('http://cell/__bolt/act', {
				method: 'POST',
				headers: {
					cookie: yield* t.session(as),
					'content-type': 'application/json',
					'Idempotency-Key': randomUUID()
				},
				body: JSON.stringify({ callable, input, issuedAt: t.clock.now() })
			})
		);
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
const conversation = (effect: Effect.Effect<Outcome, unknown>) =>
	effect.pipe(
		Effect.flatMap((outcome) =>
			outcome.kind === 'committed'
				? Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(outcome.output).pipe(
						Effect.map((r) => r.id)
					)
				: Effect.die(new Error('conversation did not start'))
		)
	);
/** The record file `read_file` is asked for when a message carries no attachment of its own. */
let recordFile = '';
const setup = Effect.gen(function* () {
	const requests: AiRequest[] = [],
		states: System1Request['state'][] = [];
	const ports = Layer.succeed(Ai, {
		maxChoices: undefined,
		models: ['default'],
		catalog: Port.unavailable('ai.catalog'),
		embed: () => Port.unavailable('ai.embed'),
		ask: (r) =>
			Effect.sync(() => {
				states.push(r.state);
				return {
					answers: {
						action: {
							type: 'choice' as const,
							choice: 'respond',
							confidence: 1,
							probabilities: { respond: 1 }
						},
						wait: {
							type: 'score' as const,
							score: 0,
							level: 0,
							confidence: 1,
							probabilities: {},
							legend: {}
						}
					},
					costUsd: 0,
					provider: 'scripted'
				};
			}),
		infer: (r) =>
			Stream.fromEffect(
				Effect.sync(() => {
					requests.push(r);
					const last = r.messages.findLast(
						(m) => !(typeof m.content === 'string' && m.content.startsWith('[conversation state'))
					);
					// a posted attachment is read by its id; else the record's file
					const id =
						/\[attachment: [^\]]*\] file reference \{\\"id\\":\\"([^\\]+)\\"/.exec(
							JSON.stringify(r.messages)
						)?.[1] ?? recordFile;
					const response: AiResponse =
						last?.role !== 'tool' && id !== ''
							? {
									content: '',
									toolCalls: [
										{
											id: 'r1',
											name: 'read_file',
											input: { id, as: 'image' }
										}
									],
									finish: 'tool',
									usage: { input: 1, output: 1 }
								}
							: {
									content: 'A pump.',
									toolCalls: [],
									finish: 'stop',
									usage: { input: 1, output: 1 }
								};
					return { _tag: 'Response' as const, response };
				})
			)
	});
	const context = yield* Layer.build(TestWorkspace.layer({ manifest, ports }));
	const t = Context.get(context, TestWorkspace);
	yield* t.db.write({
		text: `INSERT INTO sys_user (id, email, name, team) VALUES ('ann', 'ann@x.test', 'Ann', 'Inspectors'), ('bob', 'bob@x.test', 'Bob', NULL)`,
		params: []
	});
	const authorities = new Authorities(t.manifest, 'test');
	const who = (id: string) =>
		authorities
			.member(t.db, id)
			.pipe(
				Effect.flatMap((a) => (a === null ? Effect.die(new Error('no member')) : Effect.succeed(a)))
			);
	const put = (authority: Authority, name: string, mime: string, bytes: Uint8Array) =>
		upload({
			id: randomUUID(),
			model: 'sys_conversation',
			field: 'inputs',
			name,
			mime,
			bytes,
			authority,
			now: t.clock.now()
		}).pipe(Effect.provide(context));
	/** A post is held for the sender's pause (P40), then decided and answered. */
	const post = (as: string, input: Json) =>
		Effect.gen(function* () {
			const outcome = yield* act(t, as, 'sys_message.post', input);
			t.clock.advance('2s');
			yield* t.runDue();
			yield* t.settled();
			return outcome;
		});
	return {
		t,
		context,
		act: (as: string, name: string, input: Json) => act(t, as, name, input),
		post,
		put,
		who,
		requests,
		states,
		conversation: (as = 'ann') => conversation(act(t, as, 'sys_conversation.start', {}))
	};
});

const fileScope = Effect.runSync(Scope.make());
afterAll(() => Effect.runPromise(Scope.close(fileScope, Exit.void)));
const plain = Effect.runSync(Effect.cached(setup.pipe(Scope.provide(fileScope))));

describe('in-app attachments', () => {
	it.live(
		'an image posted from the panel is stored on the row, reaches sys_1 as metadata only (P37 (3)) and is read by read_file',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, post, put, who, requests, states, conversation } = yield* plain;
					const ann = yield* who('ann'),
						c = yield* conversation();
					const ref = yield* put(ann, 'pump.png', 'image/png', PNG);
					expect(ref).toMatchObject({
						kind: 'committed',
						output: { name: 'pump.png', mime: 'image/png', bytes: PNG.length }
					});
					const file = fileOf(ref),
						asked = requests.length;
					expect(
						yield* post('ann', { conversation: c, text: 'what is this?', attachments: [file] })
					).toMatchObject({ kind: 'committed' });
					const state = yield* Schema.decodeUnknownEffect(
						Schema.Struct({
							pending: Schema.Array(
								Schema.Struct({ attachments: Schema.optionalKey(Schema.Array(Schema.Json)) })
							)
						})
					)(states.at(-1));
					expect(state.pending[0]?.attachments?.[0]).toEqual({
						name: 'pump.png',
						mime: 'image/png',
						size: PNG.length
					});
					const [row] = (yield* t.db.read([
						{
							text: `SELECT ${filesOf('m')} AS files FROM sys_message m WHERE conversation = $1 AND role = 'user'`,
							params: [c]
						}
					]))[0]!.rows;
					const id = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(file).id;
					expect(row!['files']).toEqual([
						{ id, name: 'pump.png', mime: 'image/png', bytes: PNG.length }
					]);
					// the message names it by the id read_file takes
					const [first, second] = requests.slice(asked);
					expect(String(first!.messages[0]!.content)).toContain(
						`file reference ${JSON.stringify({ id, name: 'pump.png', mime: 'image/png' })}`
					);
					expect([...second!.files![0]!.bytes]).toEqual([...PNG]);
					expect(second!.files![0]!.mime).toBe('image/png');
					// the posted file is one of the conversation's inputs
					const [held] = (yield* t.db.read([
						{ text: `SELECT inputs, outputs FROM sys_conversation WHERE id = $1`, params: [c] }
					]))[0]!.rows;
					expect(held).toMatchObject({ inputs: row!['files'], outputs: [] });
					expect(held!['inputs']).toEqual([
						expect.objectContaining({ name: 'pump.png', message: expect.any(String) })
					]);
				})
			)
	);

	it.live("only the member's own uploads attach, at most 8, of the envoy media types", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { act, put, who, conversation } = yield* plain;
				const ann = yield* who('ann'),
					bob = yield* who('bob'),
					c = yield* conversation();
				expect(yield* put(ann, 'a.zip', 'application/zip', PNG)).toMatchObject({
					kind: 'refused',
					code: 'invalidInput'
				});
				const bobs = fileOf(yield* put(bob, 'b.png', 'image/png', PNG));
				expect(
					yield* Effect.flip(
						act('ann', 'sys_message.post', { conversation: c, text: 'x', attachments: [bobs] })
					)
				).toMatchObject({ _tag: 'ActRefused', code: 'invalidInput' });
				const own = fileOf(yield* put(ann, 'a.png', 'image/png', PNG));
				expect(
					yield* Effect.flip(
						act('ann', 'sys_message.post', {
							conversation: c,
							text: 'x',
							attachments: Array(9).fill(own)
						})
					)
				).toMatchObject({ _tag: 'ActRefused', message: 'Attach at most 8 files.' });
			})
		)
	);
});

// A file already filed on a record (a site photo on a job) is read with `read_file`, only by someone who reads that record.
describe('read_file', () => {
	it.live(
		"reads a record's file into the next step for a reader, and refuses anyone who cannot read the record",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, context, post, requests, conversation } = yield* plain;
					const admin = t.as(t.admin);
					const up = yield* admin.upload('photos.file', {
						name: 'sheet.png',
						mime: 'image/png',
						bytes: PNG
					});
					if (up.kind !== 'committed') throw new Error(up.kind);
					recordFile = up.output.id;
					yield* actReply(yield* routeFixture(context), admin.authority, {
						callable: 'photos.create',
						input: [
							{
								title: 'Site sheet',
								file: { id: up.output.id, name: up.output.name, mime: up.output.mime }
							}
						],
						issuedAt: t.clock.now()
					});
					const ask = (who: string) =>
						Effect.gen(function* () {
							yield* post(who, {
								conversation: yield* conversation(who),
								text: 'what does the sheet show?'
							});
							const request = requests.at(-1);
							if (request === undefined) throw new Error('no model request');
							return request;
						});
					const read = yield* ask('ann');
					expect([...read.files![0]!.bytes]).toEqual([...PNG]);
					const refused = yield* ask('bob');
					expect(refused.files ?? []).toHaveLength(0);
					expect(JSON.stringify(refused.messages)).toContain('No file you can read has this id.');
				})
			)
	);
});
