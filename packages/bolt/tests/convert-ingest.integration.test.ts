// An authored ingest reads the stored file, decodes the host's answer and stores the images of an owned result.
import { uuidv7 } from '../src/protocol/wire.ts';
import { Effect, Exit, Layer, Result, Schema, Scope } from 'effect';
import { afterAll } from 'vitest';
import { Convert } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import { actReply, routeFixture, type FixtureRoute } from './support/route-fixture.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import type { Ingested } from '../src/engine/contracts.ts';
import { expect } from '@effect/vitest';
import type { Json } from '../src/decl/values.ts';
import { layer, TestWorkspace, type WorkspaceServices } from '../../bolt-cli/src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			calls: {
				description: 'A call',
				record_label: 'record.title',
				fields: { title: { kind: 'text' }, audio: { kind: 'file', accept: ['*/*'], max: '1MiB' } }
			}
		},
		relationships: {},
		exposures: {
			calls: {
				outputs: { default: { calls: { fields: 'all' } } },
				create: { columns: { calls: ['title', 'audio'] } }
			}
		},
		integrations: {},
		teams: {},
		connections: {},

		mcp: {},
		apps: {},
		customFields: {},
		agent: { skills: {} },
		policies: {
			ops: {
				description: 'Ops',
				grants: { calls: { outputs: { default: true } } },
				capabilities: { automations: ['listen'] }
			}
		},
		automations: {
			listen: {
				description: 'Reads a call',
				policies: ['ops'],
				input: { file: { kind: 'json' }, options: { kind: 'json' } }
			}
		}
	})
);

const guest = program(`import { Effect } from 'effect';
const caught = (effect) => effect.pipe(Effect.catch((error) => Effect.succeed(error._tag === 'Unavailable'
	? { kind: 'unavailable', facility: error.facility, reason: error.reason }
	: { kind: error.kind, message: error.message, ...(error.status === undefined ? {} : { status: error.status }) })));
export default { automation: {
	listen: { body: function* ({ file, options }, ctx) { return yield* caught(ctx.convert.ingest(file, options)); } }
} };`);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const ingested: Ingested = {
	kind: 'document',
	html: [
		'<section data-speaker="S1" data-start="0" data-end="1.5"><time>00:00:00</time> Hello.</section>',
		'<section data-speaker="S2" data-start="1.6" data-end="3"><time>00:00:01</time> Hi.</section>',
		'<p><img src="image-1.png"></p>'
	].join('\n'),
	images: [{ name: 'image-1.png', mime: 'image/png', bytes: PNG }],
	meta: {
		usage: { calls: ['gen-1'], model: 'gemini-x', input: 9, output: 4, cost: 0.001 },
		stats: { pages: null, bytes: 5, cpuMs: 0, wallMs: 10 }
	}
};
const audio = new Uint8Array([0xff, 0xf3, 1, 2, 3]);

type Ingest = NonNullable<Convert['Service']['ingest']>;
const noIngest: Ingest = () => Port.unavailable('convert.ingest');
// One workspace; each run swaps the ports the host answers with.
let ingest = noIngest;
const ports = Layer.succeed(Convert, {
	targets: [],
	convert: () => Port.unavailable('convert'),
	ingest: (...args) => Effect.suspend(() => ingest(...args))
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
const run = (input: (file: Json) => Json, port: { ingest?: Ingest } = {}) =>
	Effect.gen(function* () {
		ingest = port.ingest ?? noIngest;
		const t = yield* TestWorkspace,
			{ route, file } = yield* prepared;
		const id = uuidv7(Date.parse(t.clock.now()));
		yield* actReply(route, t.as(t.member(['ops'])).authority, {
			callable: 'start',
			input: { automation: 'listen', input: input(file), id },
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
)('ctx.convert.ingest', (it) => {
	it.effect(
		'ingest hands the port the stored bytes and options, stores images only for an owner; unsupported, a bad shape, a missing file and an absent port are refused',
		() =>
			Effect.gen(function* () {
				const seen: Parameters<Ingest>[] = [];
				const port: Ingest = (...args) => Effect.sync(() => (seen.push(args), ingested));
				const { row, output } = yield* run(
					(file) => ({ file, options: { diarize: true, speakers: 2, language: 'en' } }),
					{ ingest: port }
				);
				expect(row).toMatchObject({ state: 'succeeded', error: null });
				expect(output).toEqual({
					kind: 'document',
					html: ingested.html,
					index: {
						lines: 3,
						pages: 0,
						slides: 0,
						outline: [
							{ title: 'S1 00:00:00', level: 7, from: 1, to: 1 },
							{ title: 'S2 00:00:01', level: 7, from: 2, to: 2 }
						],
						tables: 0,
						images: ['image-1.png']
					},
					transcript: {
						durationMs: 3000,
						speakers: ['S1', 'S2'],
						segments: [
							{ speaker: 'S1', start: 0, end: 1.5, text: 'Hello.' },
							{ speaker: 'S2', start: 1.6, end: 3, text: 'Hi.' }
						]
					}
				});
				const [file, options] = seen[0] ?? [];
				expect(file).toMatchObject({ name: 'call.mp3', mime: 'audio/mpeg' });
				expect([...(file?.bytes ?? [])]).toEqual([...audio]);
				expect(options).toEqual({ diarize: true, speakers: 2, language: 'en' });
				seen.length = 0;
				const owned = yield* run((file) => ({ file, options: { for: 'listen' } }), {
					ingest: port
				});
				expect(seen[0]?.[1]).toEqual({});
				expect(owned.output['images']).toEqual([
					expect.objectContaining({ name: 'image-1.png', mime: 'image/png', bytes: PNG.byteLength })
				]);
				expect(
					(yield* run((file) => ({ file, options: {} }), {
						ingest: () => Effect.succeed({ unsupported: 'no parser for CAD drawings' })
					})).output
				).toEqual({ kind: 'unsupported', message: 'no parser for CAD drawings' });
				const json = { sheets: [{ name: 'Rates', columns: ['Item'], rows: [['Labour']] }] };
				expect(
					(yield* run((file) => ({ file, options: {} }), {
						ingest: () =>
							Effect.succeed({
								kind: 'data',
								json,
								images: [],
								meta: { stats: { pages: null, bytes: 5, cpuMs: 0, wallMs: 1 } }
							})
					})).output
				).toEqual({ kind: 'data', json });
				seen.length = 0;
				expect(
					(yield* run((file) => ({ file, options: { speakers: 'two' } }), {
						ingest: port
					})).output
				).toMatchObject({ kind: 'invalid' });
				expect(seen).toEqual([]);
				expect(
					(yield* run(() => ({ file: { id: crypto.randomUUID() }, options: {} }), {
						ingest: port
					})).output
				).toMatchObject({ kind: 'invalid', message: expect.stringContaining('cannot read file') });
				expect((yield* run((file) => ({ file, options: {} }))).output).toMatchObject({
					kind: 'unavailable',
					facility: 'convert.ingest'
				});
			})
	);
});
