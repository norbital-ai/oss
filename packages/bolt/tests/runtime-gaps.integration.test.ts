// Runtime gaps the template migration found (§5.8, §5.8.1, §3.3.5, rules 55, 56): `ctx.progress` in automations, stopping
// a queued or running run (the engine and the shell route), and the files facility over the host's files port.
import { randomUUID } from 'node:crypto';
import { describe, expect, layer } from '@effect/vitest';
import { Context, Deferred, Effect, Fiber, Layer, Option, Result, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import { Callables, Runs } from '../src/engine/services.ts';
import { WebRead } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { TestWorkspace, type Kit, type WorkspaceServices } from '../src/test/index.ts';
import { program } from '../src/test/guest.ts';
import { actReply, routeFixture } from './support/route-fixture.ts';
const manifest = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			notes: { description: 'A note', label: 'title', fields: { title: { kind: 'text' } } },
			docs: {
				description: 'A document',
				label: 'title',
				fields: {
					title: { kind: 'text' },
					file: { kind: 'file', accept: ['text/*'], max: '8MiB', optional: true }
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
		exposures: {
			notes: { read: { notes: { fields: 'all' } }, create: { columns: { notes: ['title'] } } },
			docs: { read: { docs: { fields: 'all' } }, create: { columns: { docs: ['title', 'file'] } } },
			secrets: {
				read: { secrets: { fields: 'all' } },
				create: { columns: { secrets: ['title', 'file'] } }
			}
		},
		integrations: {},
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
		yield* ctx.act('notes.create', [{ title: input.title }]);
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
// one workspace per file: each test sets the web port's answer and filters runs by its own ids
const unused: WebRead['Service']['read'] = (url) =>
	Effect.succeed({ url, title: 'Unused', text: '' });
let answer: WebRead['Service']['read'] = unused;
const workspace = Layer.unwrap(
	Effect.map(guest, (guest) =>
		TestWorkspace.layer({
			manifest,
			guest,
			ports: Layer.succeed(WebRead, { read: (...args) => answer(...args) }),
			host: {
				publicUrl: 'https://acme.example',
				secure: false,
				workspace: () => ({ name: 'Acme', handle: 'acme' })
			}
		})
	)
);
const setup = (web: WebRead['Service']['read'] = unused) =>
	Effect.gen(function* () {
		answer = web;
		const context = yield* Effect.context<TestWorkspace | WorkspaceServices>();
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
				bindings: { now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC' }
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

layer(workspace, { excludeTestServices: true })('runtime gaps', (it) => {
describe('ctx.progress (L-BOLT-336)', () => {
	it.effect('an automation reports progress onto its run', () =>
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
	it.effect(
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

	it.effect(
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

	it.effect(
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

	it.effect('the shell route stops a run for its holder', () =>
		Effect.gen(function* () {
			const { t, start } = yield* setup();
			const user = randomUUID();
			yield* t.db.write({
				text: `INSERT INTO sys_user (id, email, name, kind, admin, team) VALUES ($1, 'ops@acme.example', 'Ops', 'staff', false, 'ops')`,
				params: [user]
			});
			const cookie = yield* t.session(user);
			const stop = (id: string) =>
				t.handle(
					new Request('https://acme.example/__bolt/shell/runs/stop', {
						method: 'POST',
						headers: { cookie, 'content-type': 'application/json' },
						body: JSON.stringify({ id })
					})
				);
			const id = randomUUID();
			yield* start('report', {}, id);
			const stopped = yield* stop(id);
			expect(stopped.status).toBe(200);
			expect(yield* Effect.promise(() => stopped.json())).toMatchObject({
				value: { id, status: 'stopped' }
			});
			expect((yield* stop(randomUUID())).status).toBe(404);
		})
	);
});

describe('the files facility in automations (§5.8.1)', () => {
	it.effect(
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

	it.effect('reads an uploaded file the runAs may read, and refuses one it may not', () =>
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
			yield* act('docs.create', [{ title: 'd', file: docFile }]);
			yield* act('secrets.create', [{ title: 's', file: hiddenFile }]);
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
});
});
