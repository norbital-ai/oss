// In-app Norbius attachments (§5.9, rule 58): a panel upload to `sys_message.files` rides `sys_message.post` as a
// stored FileRef on the row; the agent reads it with `read_attachment`; triage's state carries it (P37); only the
// member's own uploads attach, 8 files / 20 MiB, the envoy's media types.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Option, Result, Schema, Stream } from 'effect';
import { Ai } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { ActReply, WireError } from '../src/protocol/schema.ts';
import { ActRefused, actFailure } from '../src/decl/errors.ts';
import type { Json } from '../src/decl/values.ts';
import type { AiRequest, AiResponse, Authority, Outcome } from '../src/engine/contracts.ts';
import type { System1Request } from '../src/engine/decisions/index.ts';
import { upload } from '../src/engine/callables/upload.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { KitInvalid, TestWorkspace, type Kit } from '../src/test/index.ts';
import { actReply, routeFixture } from './support/route-fixture.ts';

const manifest = (triage: boolean) =>
	Result.getOrThrow(
		decodeManifest({
			workspace: { tz: 'UTC', locale: 'en', agent: triage ? {} : { triage: false } },
			models: {},
			relationships: {},
			collections: {},
			policies: {},
			agent: { internal: 'Staff brief.', skills: {} },
			integrations: {},
			pipelines: {},
			teams: {},
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
const setup = (triage: boolean) =>
	Effect.gen(function* () {
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
						const seq = /\[attachment seq (\d+) file 0: /.exec(JSON.stringify(r.messages))?.[1];
						const response: AiResponse =
							requests.length === 1 && seq !== undefined
								? {
										content: '',
										toolCalls: [
											{
												id: 'r1',
												name: 'read_attachment',
												input: { seq: Number(seq), as: 'image' }
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
		const context = yield* Layer.build(TestWorkspace.layer({ manifest: manifest(triage), ports }));
		const t = Context.get(context, TestWorkspace);
		for (const id of ['ann', 'bob'])
			yield* t.db.write({
				text: `INSERT INTO sys_user (id, email, name) VALUES ($1, $2, $1)`,
				params: [id, `${id}@x.test`]
			});
		const authorities = new Authorities(t.manifest, 'test');
		const who = (id: string) =>
			authorities
				.member(t.db, id)
				.pipe(
					Effect.flatMap((a) =>
						a === null ? Effect.die(new Error('no member')) : Effect.succeed(a)
					)
				);
		const put = (authority: Authority, name: string, mime: string, bytes: Uint8Array) =>
			upload({
				id: randomUUID(),
				collection: 'sys_message',
				field: 'files',
				name,
				mime,
				bytes,
				authority,
				now: t.clock.now()
			}).pipe(Effect.provide(context));
		return {
			t,
			act: (as: string, name: string, input: Json) => act(t, as, name, input),
			put,
			who,
			requests,
			states,
			conversation: () => conversation(act(t, 'ann', 'sys_conversation.start', {}))
		};
	});

describe('in-app attachments', () => {
	it.live('an image posted from the panel is stored on the row and read by read_attachment', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, act, put, who, requests, conversation } = yield* setup(false);
				const ann = yield* who('ann'),
					c = yield* conversation();
				const ref = yield* put(ann, 'pump.png', 'image/png', PNG);
				expect(ref).toMatchObject({
					kind: 'committed',
					output: { name: 'pump.png', mime: 'image/png', bytes: PNG.length }
				});
				const file = fileOf(ref);
				expect(
					yield* act('ann', 'sys_message.post', {
						conversation: c,
						text: 'what is this?',
						attachments: [file]
					})
				).toMatchObject({ kind: 'committed' });
				yield* t.settled();
				const [row] = (yield* t.db.read([
					{
						text: `SELECT files FROM sys_message WHERE conversation = $1 AND role = 'user'`,
						params: [c]
					}
				]))[0]!.rows;
				expect(row!['files']).toEqual([
					{
						id: Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(file).id,
						name: 'pump.png',
						mime: 'image/png',
						bytes: PNG.length
					}
				]);
				expect([...requests[1]!.files![0]!.bytes]).toEqual([...PNG]);
				expect(requests[1]!.files![0]!.mime).toBe('image/png');
				// the posted file is one of the conversation's inputs
				const [held] = (yield* t.db.read([
					{ text: `SELECT inputs, outputs FROM sys_conversation WHERE id = $1`, params: [c] }
				]))[0]!.rows;
				expect(held).toEqual({ inputs: row!['files'], outputs: [] });
			})
		)
	);

	it.live("only the member's own uploads attach, at most 8, of the envoy media types", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { act, put, who, conversation } = yield* setup(false);
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

	it.live('a triaged post puts its attachment in the sys_1 state as metadata only (P37 (3))', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, act, put, who, states, conversation } = yield* setup(true);
				const c = yield* conversation(),
					file = fileOf(yield* put(yield* who('ann'), 'pump.png', 'image/png', PNG));
				yield* act('ann', 'sys_message.post', {
					conversation: c,
					text: 'see photo',
					attachments: [file]
				});
				t.clock.advance('2s'); // the trailing debounce (P40)
				yield* t.runDue();
				const state = yield* Schema.decodeUnknownEffect(
					Schema.Struct({
						pending: Schema.Array(
							Schema.Struct({ attachments: Schema.optionalKey(Schema.Array(Schema.Json)) })
						)
					})
				)(states[0]);
				const got = state.pending[0]?.attachments?.[0];
				expect(got).toEqual({ name: 'pump.png', mime: 'image/png', size: PNG.length });
			})
		)
	);
});

// A file already filed on a record (a site photo on a job) is read with `read_file`, only by someone who reads that record.
describe('read_file', () => {
	const filed = Result.getOrThrow(
		decodeManifest({
			workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
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
			collections: {
				photos: { read: { fields: 'all' }, create: { input: { columns: ['title', 'file'] } } }
			},
			policies: { inspector: { description: 'Inspectors', grants: { photos: { read: true } } } },
			teams: { Inspectors: ['inspector'] },
			agent: { internal: 'Staff brief.', skills: {} },
			integrations: {},
			pipelines: {},
			automations: {},
			connections: {},
			envoys: {},
			mcp: {},
			apps: {},
			customFields: {}
		})
	);

	it.live(
		"reads a record's file into the next step for a reader, and refuses anyone who cannot read the record",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const requests: AiRequest[] = [];
					let fileId = '';
					const ports = Layer.succeed(Ai, {
						ask: () => Effect.die(new Error('no triage')),
						maxChoices: undefined,
						models: ['default'],
						catalog: Port.unavailable('ai.catalog'),
						embed: () => Port.unavailable('ai.embed'),
						infer: (r) =>
							Stream.fromEffect(
								Effect.sync(() => {
									requests.push(r);
									const response: AiResponse =
										requests.length % 2 === 1
											? {
													content: '',
													toolCalls: [
														{ id: 'f1', name: 'read_file', input: { id: fileId, as: 'image' } }
													],
													finish: 'tool',
													usage: { input: 1, output: 1 }
												}
											: {
													content: 'Read.',
													toolCalls: [],
													finish: 'stop',
													usage: { input: 1, output: 1 }
												};
									return { _tag: 'Response' as const, response };
								})
							)
					});
					const context = yield* Layer.build(TestWorkspace.layer({ manifest: filed, ports }));
					const t = Context.get(context, TestWorkspace);
					const admin = t.as(t.admin);
					const up = yield* admin.upload('photos.file', {
						name: 'sheet.png',
						mime: 'image/png',
						bytes: PNG
					});
					if (up.kind !== 'committed') throw new Error(up.kind);
					fileId = up.output.id;
					const route = yield* routeFixture(context);
					yield* actReply(route, admin.authority, {
						callable: 'photos.create',
						input: {
							title: 'Site sheet',
							file: { id: up.output.id, name: up.output.name, mime: up.output.mime }
						},
						issuedAt: t.clock.now()
					});
					yield* t.db.write({
						text: `INSERT INTO sys_user (id, email, name, team) VALUES ('ann', 'ann@x.test', 'Ann', 'Inspectors'), ('bob', 'bob@x.test', 'Bob', NULL)`,
						params: []
					});
					const ask = (who: string) =>
						Effect.gen(function* () {
							const c = yield* conversation(act(t, who, 'sys_conversation.start', {}));
							yield* act(t, who, 'sys_message.post', {
								conversation: c,
								text: 'what does the sheet show?'
							});
							yield* t.settled();
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
