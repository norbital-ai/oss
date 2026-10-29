// `ctx.ai.transcribe` and `ctx.ai.speak` (optional host capabilities): the engine reads the FileRef and hands the host's
// SpeechPort its bytes; `speak`'s audio is stored like `files.put`. A host without the port answers `unavailable`.
import { uuidv7 } from '../src/protocol/wire.ts';
import { Effect, Exit, Layer, Result, Schema, Scope } from 'effect';
import { afterAll } from 'vitest';
import { Speech, Files } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import { actReply, routeFixture, type FixtureRoute } from './support/route-fixture.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import type { Transcript } from '../src/decl/runtime/facilities.ts';
import { expect } from '@effect/vitest';
import type { Json } from '../src/decl/values.ts';
import { layer, TestWorkspace, type WorkspaceServices } from '../../bolt-cli/src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			calls: {
				description: 'A call',
				label: 'title',
				fields: { title: { kind: 'text' }, audio: { kind: 'file', accept: ['*/*'], max: '1MiB' } }
			}
		},
		relationships: {},
		exposures: {
			calls: {
				read: { calls: { fields: 'all' } },
				create: { columns: { calls: ['title', 'audio'] } }
			}
		},
		integrations: {},
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
				policies: ['ops'],
				input: { file: { kind: 'json' }, options: { kind: 'json' } }
			},
			say: { description: 'Speaks a line', policies: ['ops'], input: { options: { kind: 'json' } } }
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

const unavailable: Speech['Service'] = {
	transcribe: () => Port.unavailable('ai.transcribe'),
	speak: () => Port.unavailable('ai.speak')
};
// One workspace; each run swaps the port the host answers with.
let speech = unavailable;
const ports = Layer.succeed(Speech, {
	transcribe: (...args) => Effect.suspend(() => speech.transcribe(...args)),
	speak: (...args) => Effect.suspend(() => speech.speak(...args))
});
// one route and one stored call for the file; each run swaps the port and starts the automation
let fixture: { route: FixtureRoute; file: Json } | undefined;
const fileScope = Effect.runSync(Scope.make());
afterAll(() => Effect.runPromise(Scope.close(fileScope, Exit.void)));
const prepared = Effect.gen(function* () {
	if (fixture !== undefined) return fixture;
	const t = yield* TestWorkspace,
		route = yield* routeFixture(yield* Effect.context<TestWorkspace | WorkspaceServices>()).pipe(
			Scope.provide(fileScope)
		),
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
		input: [{ title: 'Call', audio: file }],
		issuedAt: t.clock.now()
	});
	return (fixture = { route, file });
});
const run = (
	automation: 'listen' | 'say',
	input: (file: Json) => Json,
	port: Partial<Speech['Service']> = {}
) =>
	Effect.gen(function* () {
		speech = { ...unavailable, ...port };
		const t = yield* TestWorkspace,
			{ route, file } = yield* prepared;
		const id = uuidv7(Date.parse(t.clock.now()));
		yield* actReply(route, t.as(t.member(['ops'])).authority, {
			callable: 'start',
			input: { automation, input: input(file), id },
			issuedAt: t.clock.now()
		});
		yield* t.runDue();
		const [rows] = yield* t.db.read([
			{ text: `SELECT state, output, error FROM sys_run WHERE id = $1`, params: [id] }
		]);
		const row = rows?.rows[0];
		if (row === undefined) throw new Error('run returned no row');
		return {
			t,
			row,
			output: yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(
				row['output']
			)
		};
	});

/** The suite's workspace runs on the real clock, as `it.live` would. */
const LIVE = { excludeTestServices: true };
layer(
	Layer.unwrap(Effect.map(guest, (g) => TestWorkspace.layer({ manifest, guest: g, ports }))),
	LIVE
)('ctx.ai speech', (it) => {
	it.effect(
		'transcribe hands the port the stored bytes and options; a bad shape, a missing file and an absent port are refused',
		() =>
			Effect.gen(function* () {
				const seen: Parameters<Speech['Service']['transcribe']>[] = [];
				const { row, output } = yield* run(
					'listen',
					(file) => ({ file, options: { diarize: true, speakers: 2, language: 'en' } }),
					{ transcribe: (...args) => Effect.sync(() => (seen.push(args), transcript)) }
				);
				expect(row).toMatchObject({ state: 'succeeded', error: null });
				expect(output).toEqual(transcript);
				const [file, options] = seen[0] ?? [];
				expect(file).toMatchObject({ name: 'call.mp3', mime: 'audio/mpeg' });
				expect([...(file?.bytes ?? [])]).toEqual([...audio]);
				expect(options).toEqual({ diarize: true, speakers: 2, language: 'en' });
				seen.length = 0;
				expect(
					(yield* run('listen', (file) => ({ file, options: { speakers: 'two' } }), {
						transcribe: (...args) => Effect.sync(() => (seen.push(args), transcript))
					})).output
				).toMatchObject({ kind: 'invalid' });
				expect(seen).toEqual([]);
				expect(
					(yield* run('listen', () => ({ file: { id: crypto.randomUUID() }, options: {} }), {
						transcribe: () => Effect.succeed(transcript)
					})).output
				).toMatchObject({ kind: 'invalid', message: expect.stringContaining('cannot read file') });
				expect((yield* run('listen', (file) => ({ file, options: {} }))).output).toMatchObject({
					kind: 'unavailable',
					facility: 'ai.transcribe'
				});
			})
	);

	it.effect(
		"speak stores the port's audio as a FileRef, defaults to mp3 and refuses another format",
		() =>
			Effect.gen(function* () {
				const files = yield* Files;
				const seen: unknown[] = [];
				const speak: Speech['Service']['speak'] = (text, o) =>
					Effect.sync(() => (seen.push([text, o]), { bytes: audio, mime: 'audio/wav' }));
				const { t, row, output } = yield* run(
					'say',
					() => ({ options: { voice: 'Kore', format: 'wav' } }),
					{ speak }
				);
				expect(row).toMatchObject({ state: 'succeeded', error: null });
				expect(seen).toEqual([['Hello there', { voice: 'Kore', format: 'wav' }]]);
				expect(output).toMatchObject({
					name: 'speech.wav',
					mime: 'audio/wav',
					bytes: audio.byteLength
				});
				const [file] = yield* t.db.rows(
					Schema.Struct({ key: Schema.String, field: Schema.String }),
					{
						text: `SELECT key, field FROM sys_file WHERE id = $1`,
						params: [String(output['id'])]
					}
				);
				expect(file?.field).toBe('say');
				expect([...(yield* files.get(file?.key ?? '', 1024))]).toEqual([...audio]);
				seen.length = 0;
				yield* run('say', () => ({ options: { name: 'hi.mp3' } }), { speak });
				expect(seen).toEqual([['Hello there', { format: 'mp3' }]]);
				expect(
					(yield* run('say', () => ({ options: { format: 'flac' } }), { speak })).output
				).toMatchObject({ kind: 'invalid' });
			})
	);
});
