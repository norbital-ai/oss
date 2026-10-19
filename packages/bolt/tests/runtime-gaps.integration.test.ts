// @vitest-environment happy-dom
// Runtime gaps the template migration found (§5.8, §5.8.1, §3.3.5, rules 55, 56): `ctx.progress` in automations, stopping
// a queued or running run (the engine, the shell route and `$bolt.runs.stop`), the files facility over the host's files
// port (put, get, meta and url, seeded files included), and a pipeline import's bodies carried by `bolt check`.
import './setup-happy-dom.js';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from '@effect/vitest';
import { Context, Deferred, Effect, Fiber, FiberSet, Layer, Option, Result, Schema } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import type { Json } from '../src/decl/values.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { Callables, Runs } from '../src/engine/services.ts';
import { Files, WebRead } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { TestWorkspace, type Kit } from '../src/test/index.ts';
import { program } from './support/guest-fixture.ts';
import { actReply, routeFixture } from './support/route-fixture.ts';
import { loadPackWithAssets } from '../src/engine/artifact/read.ts';
import { sha256Hex } from '../src/engine/write/sql.ts';
import { check } from '../src/compiler/check/index.ts';
import { shellApi } from '../src/shell/runtime.ts';

const node = NodeServices.layer;
const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			notes: { description: 'A note', label: 'title', fields: { title: { kind: 'text' } } },
			docs: {
				description: 'A document',
				label: 'title',
				fields: {
					title: { kind: 'text' },
					file: { kind: 'file', accept: ['text/*'], max: '1MiB', optional: true }
				}
			},
			secrets: {
				description: 'Hidden',
				label: 'title',
				fields: {
					title: { kind: 'text' },
					file: { kind: 'file', accept: ['text/*'], max: '1MiB', optional: true }
				}
			}
		},
		relationships: {},
		collections: {
			notes: { read: { fields: 'all' }, create: { input: { columns: ['title'] } } },
			docs: { read: { fields: 'all' }, create: { input: { columns: ['title', 'file'] } } },
			secrets: { read: { fields: 'all' }, create: { input: { columns: ['title', 'file'] } } }
		},
		integrations: {},
		pipelines: {},
		teams: { ops: ['ops'] },
		connections: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { skills: {} },
		policies: {
			ops: {
				description: 'Ops',
				grants: { notes: { read: true, create: true }, docs: { read: true } },
				automations: ['report', 'long', 'bundle', 'read_doc']
			}
		},
		automations: {
			report: { description: 'Reports progress', runAs: ['ops'] },
			long: {
				description: 'Runs until stopped',
				runAs: ['ops'],
				input: { title: { kind: 'text' } }
			},
			bundle: { description: 'Stores a file and reads it back', runAs: ['ops'] },
			read_doc: {
				description: 'Reads a stored file',
				runAs: ['ops'],
				input: { ref: { kind: 'json' } }
			}
		}
	})
);

const source = `import { Effect } from 'effect'; export default { automation: {
	report: { body: function* (_, ctx) { yield* ctx.progress({ ratio: 0.5, text: 'half' }); return 'done'; } },
	long: { body: function* (input, ctx) {
		yield* ctx.progress({ ratio: 0.1, text: 'start' });
		yield* ctx.web.read('https://hq.example/pause');
		if (input.title === 'progress') yield* ctx.progress({ ratio: 0.5, text: 'half' });
		yield* ctx.act('notes.create', { title: input.title });
		return 'finished';
	} },
	bundle: { body: function* (_, ctx) {
		const ref = yield* ctx.files.put(new TextEncoder().encode('hello'), { name: 'a.txt', mime: 'text/plain', for: 'bundle' });
		const bytes = yield* ctx.files.get(ref);
		return { ref, text: new TextDecoder().decode(bytes), meta: yield* ctx.files.meta(ref), url: yield* ctx.files.url(ref),
			big: { ...(yield* ctx.files.get(ref, { max: '0KiB' }).pipe(Effect.flip)) } };
	} },
	read_doc: { body: function* ({ ref }, ctx) { return { text: new TextDecoder().decode(yield* ctx.files.get(ref)), meta: yield* ctx.files.meta(ref) }; } },
} };`;

const guest = program(source);
const required = <T>(value: T | undefined): T => {
	if (value === undefined) throw new Error('fixture value missing');
	return value;
};
const sql = (t: Kit, text: string, params: Json[] = []) =>
	t.db.rows(Schema.Record(Schema.String, Schema.Json), { text, params });
const setup = (web?: WebRead['Service']['read'], shell = false) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest,
				guest: yield* guest,
				...(web === undefined ? {} : { ports: Layer.succeed(WebRead, { read: web }) }),
				...(shell
					? {
							host: {
								publicUrl: 'https://acme.example',
								secure: false,
								workspace: { name: 'Acme', handle: 'acme' }
							}
						}
					: {})
			})
		);
		const t = Context.get(context, TestWorkspace),
			route = yield* routeFixture(context),
			calls = Context.get(context, Callables),
			runs = Context.get(context, Runs);
		let ops: ReturnType<Kit['as']>['authority'] | undefined;
		const authority = () => (ops ??= t.as(t.member(['ops'])).authority);
		const start = (automation: string, input: Json, id = randomUUID()) =>
			calls.start({
				automation,
				runs: [{ id, input }],
				authority: authority(),
				bindings: { now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }
			});
		const act = (callable: string, input: Json) =>
			actReply(route, t.as(t.admin).authority, { callable, input, issuedAt: t.clock.now() }).pipe(
				Effect.map((reply) => reply.outcome)
			);
		return {
			context,
			t,
			route,
			runs,
			get ops() {
				return authority();
			},
			start,
			act
		};
	});

describe('ctx.progress (L-BOLT-336)', () => {
	it.live('an automation reports progress onto its run', () =>
		Effect.gen(function* () {
			const { t, runs, start } = yield* setup();
			const started = yield* start('report', {});
			expect(started.kind).toBe('committed');
			yield* t.runDue();
			const [run] = yield* sql(
				t,
				`SELECT id, state, progress, error FROM sys_run WHERE automation = 'report'`
			);
			expect(run).toMatchObject({
				state: 'succeeded',
				progress: { ratio: 0.5, text: 'half' },
				error: null
			});
			expect(
				Option.getOrNull(yield* runs.view(t.as(t.admin).authority, String(required(run)['id'])))
			).toMatchObject({ progress: { ratio: 0.5, text: 'half' } });
		})
	);
});

describe('stopping a run', () => {
	it.live(
		'a queued run stops before it starts; only a holder of its automation or an admin may stop it',
		() =>
			Effect.gen(function* () {
				const { t, runs, ops, start } = yield* setup();
				const id = randomUUID();
				yield* start('report', {}, id);
				expect(Option.getOrNull(yield* runs.stop(t.as(t.member([])).authority, id))).toBeNull();
				expect(Option.getOrNull(yield* runs.stop(ops, id))).toMatchObject({ status: 'stopped' });
				yield* t.runDue();
				expect(
					yield* sql(t, `SELECT state, progress, output FROM sys_run WHERE id = $1`, [id])
				).toEqual([{ state: 'stopped', progress: null, output: null }]);
			})
	);

	it.live(
		'a running run stops at its next crossing and stays stopped; a stop recorded elsewhere is seen at its next progress',
		() =>
			Effect.gen(function* () {
				let stop: ReturnType<Kit['runDue']> = Effect.void;
				const web: WebRead['Service']['read'] = () =>
					stop.pipe(
						Effect.mapError(Port.failure('web')),
						Effect.map(() => ({ url: 'https://hq.example/pause', title: 'Paused', text: '' }))
					);
				const { t, runs, start } = yield* setup(web);
				const id = randomUUID();
				stop = runs.stop(t.as(t.admin).authority, id).pipe(Effect.asVoid);
				yield* start('long', { title: 'never' }, id);
				yield* t.runDue();
				expect(
					yield* sql(t, `SELECT state, error->>'code' AS code FROM sys_run WHERE id = $1`, [id])
				).toEqual([{ state: 'stopped', code: 'stopped' }]);
				expect(yield* sql(t, `SELECT title FROM notes`)).toEqual([]);

				// another process stopped it: this one sees it when the run next reports progress
				const other = randomUUID();
				stop = t.db
					.write({ text: `UPDATE sys_run SET state = 'stopped' WHERE id = $1`, params: [other] })
					.pipe(Effect.asVoid);
				yield* start('long', { title: 'progress' }, other);
				yield* t.runDue();
				expect(yield* sql(t, `SELECT state FROM sys_run WHERE id = $1`, [other])).toEqual([
					{ state: 'stopped' }
				]);
				expect(yield* sql(t, `SELECT title FROM notes`)).toEqual([]);
			})
	);

	it.live(
		'a stop ends the crossing in flight: the tick does not wait for a facility that never answers',
		() =>
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				const web: WebRead['Service']['read'] = () =>
					Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
				const { t, runs, start } = yield* setup(web);
				const id = randomUUID();
				yield* start('long', { title: 'never' }, id);
				const tick = yield* Effect.forkChild(t.runDue());
				yield* Deferred.await(entered);
				yield* runs.stop(t.as(t.admin).authority, id);
				// the stop used to wait for the crossing to end (the workspace's frozen clock never fires its wall: a hang)
				yield* Fiber.join(tick);
				expect(
					yield* sql(t, `SELECT state, error->>'code' AS code FROM sys_run WHERE id = $1`, [id])
				).toEqual([{ state: 'stopped', code: 'stopped' }]);
				expect(yield* sql(t, `SELECT title FROM notes`)).toEqual([]);
			})
	);

	it.live('the shell route stops a run for its holder, and `$bolt.runs.stop` calls it', () =>
		Effect.gen(function* () {
			const { t, start } = yield* setup(undefined, true);
			const user = randomUUID();
			yield* t.db.write({
				text: `INSERT INTO sys_user (id, email, name, kind, admin, team) VALUES ($1, 'ops@acme.example', 'Ops', 'staff', false, 'ops')`,
				params: [user]
			});
			const cookie = yield* t.session(user),
				run = yield* FiberSet.makeRuntimePromise();
			const fetch: typeof globalThis.fetch = (input, init = {}) =>
				run(
					Effect.gen(function* () {
						const url = new URL(
							typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
							'https://acme.example'
						);
						const request = new Request(url, input instanceof Request ? input : init);
						request.headers.set('cookie', cookie);
						return yield* t.handle(request);
					})
				);
			const id = randomUUID();
			yield* start('report', {}, id);
			const api = shellApi(fetch);
			expect(yield* api.stopRun(id)).toMatchObject({ id, status: 'stopped' });
			expect(yield* api.stopRun(randomUUID()).pipe(Effect.flip)).toMatchObject({ status: 404 });
		})
	);
});

describe('the files facility in automations (§5.8.1)', () => {
	it.live(
		'puts bytes as a FileRef on the run and reads them back, with meta, a URL and the max bound',
		() =>
			Effect.gen(function* () {
				const { t, start } = yield* setup();
				yield* start('bundle', {});
				yield* t.runDue();
				const [run] = yield* sql(
					t,
					`SELECT state, output, error FROM sys_run WHERE automation = 'bundle'`
				);
				expect(run).toMatchObject({ state: 'succeeded', error: null });
				const out = yield* Schema.decodeUnknownEffect(
					Schema.Struct({
						ref: Schema.Struct({
							id: Schema.String,
							name: Schema.String,
							mime: Schema.String,
							bytes: Schema.Number,
							sha256: Schema.String
						}),
						text: Schema.String,
						meta: Schema.Json,
						url: Schema.String,
						big: Schema.Json
					})
				)(required(run)['output']);
				expect(out.text).toBe('hello');
				expect(out.ref).toMatchObject({
					name: 'a.txt',
					mime: 'text/plain',
					bytes: 5,
					sha256: expect.stringMatching(/^[0-9a-f]{64}$/)
				});
				expect(out.meta).toEqual(out.ref);
				expect(out.url).toBe(
					`memory://${required((yield* sql(t, `SELECT key FROM sys_file WHERE id = $1`, [out.ref.id]))[0])['key']}`
				);
				expect(out.big).toMatchObject({ kind: 'tooLarge' });
				expect(
					yield* sql(t, `SELECT field, size FROM sys_file WHERE id = $1`, [out.ref.id])
				).toEqual([{ field: 'bundle', size: 5 }]);
			})
	);

	it.live('reads an uploaded file the runAs may read, and refuses one it may not', () =>
		Effect.gen(function* () {
			const { t, start, act } = yield* setup();
			const admin = t.as(t.admin);
			const doc = yield* admin.upload('docs.file', {
				name: 'n.txt',
				mime: 'text/plain',
				bytes: new TextEncoder().encode('note')
			});
			const hidden = yield* admin.upload('secrets.file', {
				name: 's.txt',
				mime: 'text/plain',
				bytes: new TextEncoder().encode('shh')
			});
			if (doc.kind !== 'committed' || hidden.kind !== 'committed') throw new Error('upload failed');
			const File = Schema.Struct({
				id: Schema.String,
				name: Schema.String,
				mime: Schema.String,
				bytes: Schema.Number,
				sha256: Schema.String
			});
			const docFile = yield* Schema.decodeUnknownEffect(File)(doc.output),
				hiddenFile = yield* Schema.decodeUnknownEffect(File)(hidden.output);
			yield* act('docs.create', { title: 'd', file: docFile });
			yield* act('secrets.create', { title: 's', file: hiddenFile });
			yield* start('read_doc', { ref: docFile });
			yield* start('read_doc', { ref: hiddenFile });
			yield* t.runDue();
			const rows = yield* sql(
				t,
				`SELECT input->'ref'->>'name' AS name, state, output, error->>'message' AS message FROM sys_run WHERE automation = 'read_doc' ORDER BY name`
			);
			expect(rows[0]).toMatchObject({
				name: 'n.txt',
				state: 'succeeded',
				output: { text: 'note', meta: { bytes: 4 } }
			});
			expect(rows[1]).toMatchObject({
				name: 's.txt',
				state: 'failed',
				message: expect.stringContaining('cannot read')
			});
		})
	);

	it.live('a seeded file carries its size and digest, and an automation reads its bytes', () =>
		Effect.gen(function* () {
			const { context, t, start } = yield* setup();
			const dir = join(scratch, `pack-${randomUUID()}`);
			mkdirSync(join(dir, 'assets', 'docs'), { recursive: true });
			const bytes = new TextEncoder().encode('seeded'),
				digest = sha256Hex(bytes);
			writeFileSync(join(dir, 'assets', 'docs', 'seed.txt'), bytes);
			yield* t.db.write({ text: 'DELETE FROM sys_run', params: [] });
			const loaded = yield* loadPackWithAssets(
				t.db,
				manifest,
				{
					dir,
					rows: { docs: [{ id: randomUUID(), title: 'S', file: { asset: 'docs/seed.txt' } }] },
					meta: {
						format: 1,
						name: 'base',
						hash: 'h',
						start: [],
						rows: { docs: 1 },
						assets: [{ path: 'docs/seed.txt', bytes: 6, sha256: digest, contentType: 'text/plain' }]
					}
				},
				Context.get(context, Files),
				t.clock.now()
			).pipe(Effect.provide(node));
			expect(loaded).toBe(true);
			const [row] = yield* sql(t, `SELECT file FROM docs`);
			expect(required(row)['file']).toMatchObject({
				name: 'seed.txt',
				mime: 'text/plain',
				bytes: 6,
				sha256: digest
			});
			yield* start('read_doc', { ref: required(required(row)['file']) });
			yield* t.runDue();
			expect(
				(yield* sql(t, `SELECT state, output FROM sys_run WHERE automation = 'read_doc'`))[0]
			).toMatchObject({ state: 'succeeded', output: { text: 'seeded', meta: { bytes: 6 } } });
		})
	);
});

describe('pipelines from source', () => {
	it.live(
		'`bolt check` keeps the bodies a pipeline import declares, so the feed calls them',
		() =>
			Effect.gen(function* () {
				const root = copy('pipeline');
				writeFileSync(
					join(root, 'src/data/collection/customers/+pipeline.ts'),
					`import { pipeline } from '@norbital-ai/bolt';
export default pipeline('customers', { import: { description: 'Buyers from a sheet.',
	input: { rows: { kind: 'list', of: { kind: 'object', fields: { name: { kind: 'text' } } } } },
	records: (input) => input.rows, known: function* () { return {}; }, map: (r) => ({ name: r.name }),
	related: { customers: () => [] }, check: function* () { return []; }, template: function* () { return []; } } });`
				);
				const c = yield* check(root).pipe(Effect.provide(node));
				expect(c.errors).toEqual([]);
				if (c.manifest === undefined) throw new Error('compiled manifest missing');
				expect(c.manifest.pipelines['customers']).toMatchObject({
					import: { known: true, check: true, template: true, related: { customers: true } }
				});
			}),
		120_000
	);
});

const FIXTURE = join(import.meta.dirname, 'fixtures/good');
const scratch = join(tmpdir(), 'norbital-scratch', `runtime-${randomUUID()}`);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
function copy(name: string): string {
	const root = join(scratch, name);
	cpSync(FIXTURE, root, { recursive: true, filter: (p) => !p.includes('.norbital') });
	for (const f of readdirSync(join(root, 'src'), { recursive: true })
		.map(String)
		.filter((f) => f.endsWith('.ts'))) {
		const p = join(root, 'src', f);
		writeFileSync(
			p,
			readFileSync(p, 'utf8').replace(/'(\.\.\/)+src\/index\.ts'/g, "'@norbital-ai/bolt'")
		);
	}
	writeFileSync(join(root, 'tsconfig.json'), '{}');
	return root;
}
