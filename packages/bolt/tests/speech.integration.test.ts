// `ctx.ai.transcribe` and `ctx.ai.speak` (optional host capabilities): the engine reads the FileRef and hands the host's
// SpeechPort its bytes; `speak`'s audio is stored like `files.put`. A host without the port answers `unavailable`.
import { uuidv7 } from '../src/protocol/wire.ts';
import { Context, Effect, Layer, Result, Schema } from 'effect';
import { Speech, Files } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { actReply, routeFixture } from './support/route-fixture.ts';
import { program } from './support/guest-fixture.ts';
import type { Transcript } from '../src/decl/runtime/facilities.ts';
import { describe, expect, it } from '@effect/vitest';
import type { Json } from '../src/decl/values.ts';
import { TestWorkspace } from '../src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			calls: {
				description: 'A call',
				label: 'title',
				fields: { title: { kind: 'text' }, audio: { kind: 'file', accept: ['*/*'], max: '1MiB' } }
			}
		},
		relationships: {},
		collections: {
			calls: { read: { fields: 'all' }, create: { input: { columns: ['title', 'audio'] } } }
		},
		integrations: {},
		pipelines: {},
		teams: {},
		connections: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { skills: {} },
		policies: {
			ops: { description: 'Ops', grants: { calls: { read: true } }, automations: ['listen', 'say'] }
		},
		automations: {
			listen: {
				description: 'Transcribes a call',
				runAs: ['ops'],
				input: { file: { kind: 'json' }, options: { kind: 'json' } }
			},
			say: { description: 'Speaks a line', runAs: ['ops'], input: { options: { kind: 'json' } } }
		}
	})
);

const guest = program(`import { Effect } from 'effect';
const caught = (effect) => effect.pipe(Effect.catch((error) => Effect.succeed(error._tag === 'Unavailable'
	? { kind: 'unavailable', facility: error.facility, reason: error.reason }
	: { kind: error.kind, message: error.message, ...(error.status === undefined ? {} : { status: error.status }) })));
export default { automation: {
	listen: { body: function* ({ file, options }, ctx) { return yield* caught(ctx.ai.transcribe(file, options)); } },
	say: { body: function* ({ options }, ctx) { return yield* caught(ctx.ai.speak('Hello there', { for: 'say', ...options })); } }
} };`);

const transcript: Transcript = {
	segments: [
		{ speaker: 'S1', start: 0, end: 1.5, text: 'Hello.' },
		{ speaker: 'S2', start: 1.6, end: 3, text: 'Hi.' }
	],
	language: 'en',
	durationMs: 3000
};
const audio = new Uint8Array([0xff, 0xf3, 1, 2, 3]);

const TranscriptAnswer = Schema.Struct({
	segments: Schema.Array(
		Schema.Struct({
			speaker: Schema.String,
			start: Schema.Number,
			end: Schema.Number,
			text: Schema.String
		})
	),
	language: Schema.NullOr(Schema.String),
	durationMs: Schema.Number
});
const run = (
	automation: 'listen' | 'say',
	input: (file: Json) => Json,
	speech?: Partial<Speech['Service']>
) =>
	Effect.gen(function* () {
		const ports =
			speech === undefined
				? undefined
				: Layer.succeed(Speech, {
						transcribe: speech.transcribe ?? (() => Port.unavailable('ai.transcribe')),
						speak: speech.speak ?? (() => Port.unavailable('ai.speak'))
					});
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest,
				guest: yield* guest,
				...(ports === undefined ? {} : { ports })
			})
		);
		const t = Context.get(context, TestWorkspace),
			files = Context.get(context, Files),
			route = yield* routeFixture(context),
			admin = t.as(t.admin);
		const up = yield* admin.upload('calls.audio', {
			name: 'call.mp3',
			mime: 'audio/mpeg',
			bytes: audio
		});
		if (up.kind !== 'committed') throw new Error('upload failed');
		const file: Json = { id: up.output.id, name: up.output.name, mime: up.output.mime };
		yield* actReply(route, admin.authority, {
			callable: 'calls.create',
			input: { title: 'Call', audio: file },
			issuedAt: t.clock.now()
		});
		yield* actReply(route, t.as(t.member(['ops'])).authority, {
			callable: 'start',
			input: { automation, input: input(file), id: uuidv7(Date.parse(t.clock.now())) },
			issuedAt: t.clock.now()
		});
		yield* t.runDue();
		const [rows] = yield* t.db.read([
			{ text: `SELECT state, output, error FROM sys_run`, params: [] }
		]);
		const row = rows?.rows[0];
		if (row === undefined) throw new Error('run returned no row');
		return {
			t,
			files,
			row,
			output: yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(
				row['output']
			)
		};
	});

describe('ctx.ai.transcribe', () => {
	it.live('hands the port the stored bytes and the options, and answers its transcript', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const seen: Parameters<Speech['Service']['transcribe']>[] = [];
				const { row, output } = yield* run(
					'listen',
					(file) => ({ file, options: { diarize: true, speakers: 2, language: 'en' } }),
					{ transcribe: (...args) => Effect.sync(() => (seen.push(args), transcript)) }
				);
				expect(row).toMatchObject({ state: 'succeeded', error: null });
				expect(output).toEqual(transcript);
				const seenCall = seen[0];
				if (seenCall === undefined) throw new Error('transcribe was not called');
				const [file, options] = seenCall;
				expect(file).toMatchObject({ name: 'call.mp3', mime: 'audio/mpeg' });
				expect([...file.bytes]).toEqual([...audio]);
				expect(options).toEqual({ diarize: true, speakers: 2, language: 'en' });
			})
		)
	);

	it.live(
		'answers unavailable without the port or its transcribe, and refuses a file the run cannot name',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					expect((yield* run('listen', (file) => ({ file, options: {} }))).output).toMatchObject({
						kind: 'unavailable',
						facility: 'ai.transcribe'
					});
					expect(
						(yield* run('listen', (file) => ({ file, options: {} }), {
							speak: () => Effect.succeed({ bytes: audio, mime: 'audio/mpeg' })
						})).output
					).toMatchObject({ kind: 'unavailable', facility: 'ai.transcribe' });
					expect(
						(yield* run('listen', () => ({ file: { id: crypto.randomUUID() }, options: {} }), {
							transcribe: () => Effect.succeed(transcript)
						})).output
					).toMatchObject({
						kind: 'invalid',
						message: expect.stringContaining('cannot read file')
					});
				})
			)
	);

	it.live('turns a port throw into upstream and a malformed answer into upstream', () =>
		Effect.scoped(
			Effect.gen(function* () {
				expect(
					(yield* run('listen', (file) => ({ file, options: {} }), {
						transcribe: () => Effect.fail(Port.failure('ai.transcribe')(new Error('provider down')))
					})).output
				).toMatchObject({ kind: 'upstream', message: expect.stringContaining('provider down') });
				expect(
					(yield* run('listen', (file) => ({ file, options: {} }), {
						transcribe: () =>
							Port.fromPromise(
								() => Promise.resolve({ segments: 'no' }),
								TranscriptAnswer,
								'ai.transcribe'
							)
					})).output
				).toMatchObject({ kind: 'upstream' });
				const limited = Object.assign(new Error('slow down'), { kind: 'rateLimited', status: 429 });
				expect(
					(yield* run('listen', (file) => ({ file, options: {} }), {
						transcribe: () => Effect.fail(Port.failure('ai.transcribe')(limited))
					})).output
				).toMatchObject({ kind: 'rateLimited', message: 'slow down', status: 429 });
			})
		)
	);

	it.live('refuses options of the wrong shape before calling the port', () =>
		Effect.scoped(
			Effect.gen(function* () {
				let called = false;
				const { output } = yield* run(
					'listen',
					(file) => ({ file, options: { speakers: 'two' } }),
					{ transcribe: () => Effect.sync(() => ((called = true), transcript)) }
				);
				expect(output).toMatchObject({ kind: 'invalid' });
				expect(called).toBe(false);
			})
		)
	);
});

describe('ctx.ai.speak', () => {
	it.live("stores the port's audio for its owner and answers the FileRef", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const seen: unknown[] = [];
				const { t, files, row, output } = yield* run(
					'say',
					() => ({ options: { voice: 'Kore', format: 'wav' } }),
					{
						speak: (...args) =>
							Effect.sync(() => (seen.push(args.slice(0, 2)), { bytes: audio, mime: 'audio/wav' }))
					}
				);
				expect(row).toMatchObject({ state: 'succeeded', error: null });
				expect(seen).toEqual([['Hello there', { voice: 'Kore', format: 'wav' }]]);
				expect(output).toMatchObject({
					name: 'speech.wav',
					mime: 'audio/wav',
					bytes: audio.byteLength
				});
				const outputId = output['id'];
				if (typeof outputId !== 'string') throw new Error('speech output has no file id');
				const [file] = yield* t.db.rows(
					Schema.Struct({ key: Schema.String, field: Schema.String }),
					{ text: `SELECT key, field FROM sys_file WHERE id = $1`, params: [outputId] }
				);
				if (file === undefined) throw new Error('stored speech file missing');
				expect(file['field']).toBe('say');
				expect([...(yield* files.get(file.key, 1024))]).toEqual([...audio]);
			})
		)
	);

	it.live('defaults to mp3, refuses another format and answers unavailable without speak', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const seen: unknown[] = [];
				yield* run('say', () => ({ options: { name: 'hi.mp3' } }), {
					speak: (_t, o) => Effect.sync(() => (seen.push(o), { bytes: audio, mime: 'audio/mpeg' }))
				});
				expect(seen).toEqual([{ format: 'mp3' }]);
				expect(
					(yield* run('say', () => ({ options: { format: 'flac' } }), {
						speak: () => Effect.succeed({ bytes: audio, mime: 'audio/flac' })
					})).output
				).toMatchObject({ kind: 'invalid' });
				expect(
					(yield* run('say', () => ({ options: {} }), {
						transcribe: () => Effect.succeed(transcript)
					})).output
				).toMatchObject({ kind: 'unavailable', facility: 'ai.speak' });
			})
		)
	);
});
