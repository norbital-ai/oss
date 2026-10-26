/// <reference types="node" />
// The bolt CLI (§3.7, §5.1, rules 7, 69, 70) on a copy of the P1 good fixture: `bolt build` writes a deterministic
// artifact and its seed packs (base from `seed/**`, sample from a bank tree through the default reader or `seed/seed.ts`,
// with rule 70's `start`), and `bolt dev`'s host serves it on PGlite: sign-in with the dev sink, seeded reads, the
// first-admission run, the client document, and a hot swap that keeps the database.
import { createHash, randomUUID } from 'node:crypto';
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, layer } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, Layer, Option, Schema } from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { readPack, readPackSource } from '../src/engine/write/pack.ts';
import type { TemplateManifest } from '../src/protocol/schema.ts';
import { readArtifact, skillFiles, treeHash, workspaceFiles } from '../src/engine/artifact/read.ts';
import { AuthorErrors, buildWorkspace } from '../src/cli/build.ts';
import { DevHost, DevHostLive } from '../src/cli/dev.ts';
import { localFiles } from '../src/node/files.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { auditShape } from '../src/engine/audit.ts';
import { memoryAudit } from '../src/test/index.ts';
import { main } from '../src/cli/main.ts';
import { PgliteDb } from '../src/node/db/pglite.ts';

const BOLT = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const SHELL_BUILD = fileURLToPath(new URL('../src/shell/build.d.ts', import.meta.url));
// the client as templates see it: its built declarations (the source's ui augmentation needs ui as an installed package)
const CLIENT = fileURLToPath(new URL('../build/page/index.d.ts', import.meta.url));
const UI = fileURLToPath(new URL('../../ui/build/index.d.ts', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/good', import.meta.url));
const scratch = join(tmpdir(), 'norbital-scratch', `cli-${randomUUID()}`);
const root = join(scratch, 'good'),
	bank = join(scratch, 'bank');
const write = (path: string, text: string) => {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, text);
};
const fixtureBuild = (...args: Parameters<typeof buildWorkspace>) =>
	buildWorkspace(...args).pipe(
		Effect.catchTag('AuthorErrors', (error) =>
			Effect.fail(
				new Error(
					error.errors.map((item) => `${item.path}: ${item.code}: ${item.message}`).join('\n'),
					{ cause: error }
				)
			)
		)
	);

/** The good fixture as a workspace of its own: bolt by package name and a tsconfig for its new location. */
function workspace(): void {
	cpSync(FIXTURE, root, { recursive: true, filter: (p) => !p.includes('.norbital') });
	symlinkSync(
		fileURLToPath(new URL('../node_modules', import.meta.url)),
		join(root, 'node_modules'),
		'dir'
	);
	for (const f of readdirSync(join(root, 'src'), { recursive: true })
		.map(String)
		.filter((f) => f.endsWith('.ts'))) {
		const p = join(root, 'src', f);
		writeFileSync(
			p,
			readFileSync(p, 'utf8').replace(/'(\.\.\/)+src\/index\.ts'/g, "'@norbital-ai/bolt'")
		);
	}
	// the generated type setup (`.norbital/tsconfig.json`, `bolt.d.ts`), with bolt resolved to this checkout's source
	write(
		join(root, 'tsconfig.json'),
		JSON.stringify({
			extends: './.norbital/tsconfig.json',
			compilerOptions: {
				rootDir: '/',
				paths: {
					'@norbital-ai/bolt': [BOLT],
					'@norbital-ai/bolt/page': [CLIENT],
					'@norbital-ai/ui': [UI]
				}
			},
			files: [SHELL_BUILD]
		})
	);
	// a file field, a bank asset for it, and a workspace asset shipped in the artifact
	const model = join(root, 'src/data/model/customers/+model.ts');
	writeFileSync(
		model,
		readFileSync(model, 'utf8').replace(
			"name: { kind: 'text' },",
			"name: { kind: 'text' }, logo: { kind: 'file', accept: ['image/*'], max: '1MiB', optional: true },"
		)
	);
	write(join(root, 'assets/thumbnail.svg'), '<svg/>');
	// a page reading `$bolt`, typed by the generated `.norbital/bolt.d.ts` (the build resolves it to the booted shell client)
	write(
		join(root, 'src/app/sales/+list.page.svelte'),
		`<script lang="ts">import { bolt } from '$bolt';</script>\n<p>{bolt.locale}</p>\n`
	);
	// a page with a ui view: it must share the shell's ui (one `$bolt` context), never bundle a copy of its own
	write(
		join(root, 'src/app/sales/+board.page.svelte'),
		`<script lang="ts">import { Table } from '@norbital-ai/ui';</script>\n<Table of="customers" columns={['name']} />\n`
	);
	write(
		join(root, 'norbital.template.json'),
		JSON.stringify({
			schemaVersion: 1,
			key: 'norbital_good',
			name: 'Good',
			industry: 'Testing',
			description: 'Good workspace fixture',
			visibility: 'unlisted',
			counts: { models: 3, apps: 2, automations: 1 },
			tags: [],
			seed: { bankTree: 'acme' }
		} satisfies TemplateManifest)
	);
	write(
		join(root, 'src/access_control/team/+team.ts'),
		`import { team } from '@norbital-ai/bolt';
export default team({ Sales: ['sales_rep'], t1: { name: 'Bank Sales', policies: ['sales_rep'] }, t2: { name: 'Bank Inside', parent: 't1', policies: [] } });`
	);
	write(
		join(bank, 'acme/team.json'),
		JSON.stringify([
			{ id: 't2', name: 'Inside', parent_id: 't1' },
			{ id: 't1', name: 'Sales' }
		])
	);
	write(
		join(bank, 'acme/user.json'),
		JSON.stringify([
			{ id: 'u1', name: 'Ann', email: 'ann@acme.example', status: 'admin', team_id: 't2' },
			{ id: 'u2', name: 'Bob', email: 'bob@acme.example', status: 'normal', team_id: 't1' }
		])
	);
	write(
		join(bank, 'acme/customers.json'),
		JSON.stringify([
			{
				id: '0199a000-0000-4000-8000-0000000000b1',
				name: 'Bank Co',
				logo: { asset: 'logos/bank.png' }
			}
		])
	);
	write(join(bank, 'acme/logos/bank.png'), 'PNG bytes');
}

beforeAll(workspace);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('bolt build', () => {
	it.live(
		'writes the artifact (check + tsc + svelte-check green) and rebuilds it byte for byte',
		() =>
			Effect.gen(function* () {
				const { artifact, packs } = yield* fixtureBuild(root, { bank });
				const out = join(root, '.norbital/artifact');
				for (const f of [
					'artifact.json',
					'manifest.json',
					'schema.sql',
					'guest.mjs',
					'client/index.html',
					'skills/triage/SKILL.md',
					'skills/triage/scripts/count.js'
				])
					expect(existsSync(join(out, f)), f).toBe(true);
				// a skill's digest is its built folder's tree hash; a file run reads the folder through `skillFiles`
				const built = yield* readArtifact(out);
				expect(built.manifest.agent.skills['triage']?.digest).toBe(
					yield* treeHash(join(out, 'skills', 'triage'))
				);
				const skill = yield* skillFiles(out);
				expect(
					new TextDecoder().decode(yield* Effect.promise(() => skill('triage', 'scripts/count.js')))
				).toContain('notices: ');
				expect(artifact.artifact).toMatchObject({
					format: 1,
					handle: 'norbital_good',
					name: 'Good'
				});
				expect(readFileSync(join(out, 'client/index.html'), 'utf8')).toContain(
					`/${artifact.artifact.client.entry}`
				);
				const pages = readdirSync(join(out, 'client/assets')).filter(
					(f) => f.includes('.page-') && f.endsWith('.js')
				);
				expect(pages).toHaveLength(4); // sales/board, sales/list, hr/kiosk/clock and the kiosk clock/clock
				for (const p of pages)
					expect(readFileSync(join(out, 'client/assets', p), 'utf8'), p).not.toContain(
						'A view needs the shell'
					);
				// the entry carries the messages (base and locales); the record view is the platform layer's
				const shell = readFileSync(join(out, 'client', artifact.artifact.client.entry), 'utf8');
				for (const text of ['Hello', 'Helo']) expect(shell, text).toContain(text);
				const layer = readdirSync(join(out, 'client/assets/platform'))
					.filter((f) => f.endsWith('.js'))
					.map((f) => readFileSync(join(out, 'client/assets/platform', f), 'utf8'))
					.join('\n');
				expect(layer).toContain('record.tab.record');
				// the account menu's versions (L-BOLT-073) are the workspace entry's: the shared layer carries none of them
				expect(shell).toContain(`globalThis.__BOLT_BUILD__=`);
				expect(shell).toContain(process.versions.node);
				expect(layer).not.toContain(process.versions.node);
				expect(artifact.artifact.client.css.length).toBeGreaterThan(0);
				expect(readFileSync(join(out, 'schema.sql'), 'utf8')).toMatch(
					/create table "?customers"?/i
				);
				expect(Object.keys(packs)).toEqual(['base', 'sample']);
				expect(packs['base']!.rows).toEqual({ customers: 1 });
				expect(packs['sample']!.rows).toEqual({ customers: 1, sys_user: 2 });
				expect(packs['sample']!.assets).toEqual([
					{ path: 'logos/bank.png', bytes: 9, sha256: expect.any(String), contentType: 'image/png' }
				]);
				expect((yield* readPack(join(root, '.norbital/seed/sample'))).rows['sys_user']).toEqual([
					{
						id: 'u1',
						name: 'Ann',
						email: 'ann@acme.example',
						kind: 'staff',
						admin: true,
						team: 't2'
					},
					{
						id: 'u2',
						name: 'Bob',
						email: 'bob@acme.example',
						kind: 'staff',
						admin: false,
						team: 't1'
					}
				]);
				// the agent's workspace: the source as released; a build loads no TypeScript program, so it writes no type index
				const ws = yield* workspaceFiles(out);
				if (ws === undefined) throw new Error('Built workspace source is missing.');
				expect(yield* Effect.promise(() => ws.files())).toContain(
					'src/data/model/orders/+model.ts'
				);
				expect(yield* Effect.promise(() => ws.read('src/agent/skill/triage/+skill.md'))).toContain(
					'description: Triage a notice'
				);
				expect(yield* Effect.promise(() => ws.read('../manifest.json'))).toBeNull();
				// the type setup beside the source is the language tool's: the agent's port lists the source only
				expect(
					(yield* Effect.promise(() => ws.files())).some((file) => file.startsWith('.norbital/'))
				).toBe(false);
				const files = () =>
					Object.fromEntries(
						readdirSync(join(out, 'client'), { recursive: true })
							.map(String)
							.sort()
							.filter(
								(f) =>
									!f.endsWith('/') &&
									existsSync(join(out, 'client', f)) &&
									!statSync(join(out, 'client', f)).isDirectory()
							)
							.map((f) => [
								f,
								createHash('sha256')
									.update(readFileSync(join(out, 'client', f)))
									.digest('hex')
							])
					);
				const before = files();
				const again = yield* buildWorkspace(root, { bank });
				// file by file first, so a difference names the file that moved
				expect(files()).toEqual(before);
				expect(again.artifact.artifact.hashes).toEqual(artifact.artifact.hashes);
				expect(again.artifact.artifact.snapshot).toBeUndefined();
				expect(artifact.artifact.snapshot).toBeUndefined();
				expect(again.artifact.artifact.hash).toBe(artifact.artifact.hash);
				expect(again.packs['sample']!.hash).toBe(packs['sample']!.hash);
				// L-BOLT-903: activation verifies every recorded digest
				yield* readArtifact(out);
				for (const f of [
					'guest.mjs',
					'manifest.json',
					'client/index.html',
					'skills/triage/SKILL.md'
				]) {
					const was = readFileSync(join(out, f), 'utf8');
					writeFileSync(join(out, f), f === 'manifest.json' ? `${was} ` : `${was}\n//`);
					expect((yield* readArtifact(out).pipe(Effect.flip)).message, f).toMatch(
						/does not match its recorded digest/
					);
					writeFileSync(join(out, f), was);
				}
				// Builds publish source only; an extra tenant-authored native blob is never loaded.
				expect(existsSync(join(out, 'guest.snapshot'))).toBe(false);
				writeFileSync(join(out, 'guest.snapshot'), new Uint8Array([0, 1, 2, 3]));
				const withoutNativeBytes = yield* readArtifact(out);
				expect(withoutNativeBytes.guest.source).toBe(artifact.guest.source);
				expect('snapshot' in withoutNativeBytes.guest).toBe(false);
			}).pipe(Effect.provide(NodeServices.layer)),
		90_000
	);

	it.live(
		'a build without types skips the type index and reuses an unchanged base pack',
		() =>
			Effect.gen(function* () {
				const pack = join(root, '.norbital/seed/base/pack.json'),
					customers = join(root, 'seed/master/customers.json'),
					original = readFileSync(customers, 'utf8');
				yield* fixtureBuild(root, {});
				const written = statSync(pack).mtimeMs;
				const preview = yield* fixtureBuild(root);
				expect(statSync(pack).mtimeMs).toBe(written);
				expect(preview.packs['base']!.rows).toEqual({ customers: 1 });
				const ws = yield* workspaceFiles(join(root, '.norbital/artifact'));
				if (ws === undefined) throw new Error('Built workspace source is missing.');
				writeFileSync(
					customers,
					JSON.stringify([
						{ id: '0199a000-0000-4000-8000-000000000001', name: 'Acme' },
						{ id: '0199a000-0000-4000-8000-000000000002', name: 'Beta' }
					])
				);
				const changed = yield* fixtureBuild(root).pipe(
					Effect.ensuring(Effect.sync(() => writeFileSync(customers, original)))
				);
				expect(changed.packs['base']!.rows).toEqual({ customers: 2 });
			}).pipe(Effect.provide(NodeServices.layer)),
		90_000
	);

	it.live(
		'reads the bank through seed/seed.ts, and a start entry that is no automation is a build error',
		() =>
			Effect.gen(function* () {
				write(
					join(root, 'seed/seed.ts'),
					`import type { SeedSource } from '@norbital-ai/bolt';
import { Schema } from 'effect';
import { cents } from '../src/lib/money.ts';
const customers = Schema.decodeUnknownSync(Schema.Array(Schema.StructWithRest(
	Schema.Struct({ id: Schema.String, name: Schema.String }),
	[Schema.Record(Schema.String, Schema.Json)]
)));
export default { bank: 'acme', start: ['nightly'],
	rows: (bank) => ({ customers: bank.has('customers.json') ? customers(bank.json('customers.json')).map((c) => ({ ...c, name: c.name + ' ' + cents(1) })) : [] }),
} satisfies SeedSource;`
				);
				const { packs } = yield* buildWorkspace(root, { bank });
				expect(packs['sample']).toMatchObject({ start: ['nightly'], rows: { customers: 1 } });
				expect(
					(yield* readPack(join(root, '.norbital/seed/sample'))).rows['customers']?.[0]
				).toMatchObject({ name: 'Bank Co 100' });
				write(
					join(root, 'seed/seed.ts'),
					`export default { bank: 'acme', start: ['nope'], rows: () => ({}) };`
				);
				const failed = yield* buildWorkspace(root, { bank }).pipe(Effect.flip);
				expect(failed).toBeInstanceOf(AuthorErrors);
				if (!(failed instanceof AuthorErrors)) throw new Error('Expected author errors.');
				expect(failed.errors.map((e) => e.code)).toEqual(['seed/start']);
				write(
					join(root, 'seed/seed.ts'),
					`import type { SeedSource } from '@norbital-ai/bolt';
import { Schema } from 'effect';
const customers = Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Json)));
const users = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({
	id: Schema.String, name: Schema.String, email: Schema.String, status: Schema.String, team_id: Schema.String
})));
export default { bank: 'acme', start: ['nightly'], rows: (b) => !b.has('customers.json') ? {} : ({ customers: customers(b.json('customers.json')),
sys_user: users(b.json('user.json')).map((u) => ({ id: u.id, name: u.name, email: u.email, kind: 'staff', admin: u.status === 'admin', team: u.team_id })) }) } satisfies SeedSource;`
				);
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000
	);

	it.live(
		'exits 1 on an author error and prints every diagnostic',
		() =>
			Effect.gen(function* () {
				const bad = join(scratch, 'bad');
				write(join(bad, 'src/+workspace.ts'), `export default { tz: 'UTC', locale: 'en' };`);
				write(join(bad, 'src/automations/+x.automation.ts'), 'export default {};');
				expect(yield* main(['check', bad])).toBe(1);
				expect(yield* main(['nonsense'])).toBe(2);
			}).pipe(Effect.provide(NodeServices.layer)),
		30_000
	);
});

const port = 5300 + Math.floor(Math.random() * 500);
const development = Layer.unwrap(
	Effect.gen(function* () {
		const { artifact } = yield* fixtureBuild(root, { bank });
		const pack = yield* readPackSource(join(root, '.norbital/seed/sample'));
		const audit = yield* auditShape(memoryAudit().port);
		return DevHostLive(artifact, {
			port,
			pack,
			audit,
			founder: 'ann@acme.example',
			files: localFiles(join(scratch, 'files')),
			log: () => {}
		}).pipe(Layer.provideMerge(PgliteDb.layer()));
	})
).pipe(Layer.provideMerge(NodeServices.layer));

layer(development, { timeout: 60_000, excludeTestServices: true })('bolt dev host', (it) => {
	const cookies: string[] = [];
	const call = Effect.fn('test.devRequest')(function* (
		path: string,
		body?: unknown,
		headers: Record<string, string> = {}
	) {
		const host = yield* DevHost;
		const native = yield* host.handle(
			HttpServerRequest.fromWeb(
				new Request(`${host.url}${path}`, {
					method: body === undefined ? 'GET' : 'POST',
					headers: { 'content-type': 'application/json', cookie: cookies.join('; '), ...headers },
					...(body === undefined ? {} : { body: JSON.stringify(body) })
				})
			).modify({ remoteAddress: Option.some('127.0.0.1') })
		);
		const response = HttpServerResponse.toWeb(native);
		for (const cookie of response.headers.getSetCookie()) {
			const pair = cookie.split(';')[0];
			if (pair !== undefined) cookies.push(pair);
		}
		return response;
	});
	const json = Effect.fn('test.devJson')(function* (response: Response) {
		return yield* Effect.promise((): Promise<unknown> => response.json());
	});
	const names = Schema.Struct({
		answers: Schema.Array(
			Schema.Struct({ rows: Schema.Array(Schema.Struct({ name: Schema.String })) })
		)
	});

	it.effect(
		'signs the seeded administrator in with the dev sink code and reads the seeded rows',
		() =>
			Effect.gen(function* () {
				expect((yield* call('/__bolt/session/code', { address: 'ann@acme.example' })).status).toBe(
					200
				);
				expect(
					(yield* call('/__bolt/session/verify', { address: 'ann@acme.example', code: '123456' }))
						.status
				).toBe(200);
				const q = yield* Schema.decodeUnknownEffect(names)(
					yield* json(
						yield* call('/__bolt/q', { reads: [{ m: 'query', a: ['customers', { all: true }] }] })
					)
				);
				expect(q.answers[0]?.rows.map((row) => row.name)).toEqual(['Bank Co']);
				const act = yield* call(
					'/__bolt/act',
					{
						callable: 'customers.create',
						input: { name: 'New' },
						issuedAt: new Date().toISOString()
					},
					{ 'Idempotency-Key': randomUUID() }
				);
				expect(yield* json(act)).toMatchObject({ outcome: { kind: 'committed' } });
			})
	);

	it.effect(
		'keeps teams in source (no sys_team table) and queues the first-admission start run (rule 70)',
		() =>
			Effect.gen(function* () {
				const db = yield* TenantDb;
				const [teams, runs] = yield* db.read([
					{ text: `SELECT to_regclass('sys_team') IS NULL AS absent`, params: [] },
					{ text: `SELECT automation, cause FROM sys_run WHERE cause = 'start'`, params: [] }
				]);
				expect(teams?.rows).toEqual([{ absent: true }]);
				expect(runs?.rows).toEqual([{ automation: 'nightly', cause: 'start' }]);
			})
	);

	it.effect('put the pack assets in the files store as FileRefs (rule 70)', () =>
		Effect.gen(function* () {
			const db = yield* TenantDb;
			const [result] = yield* db.read([
				{
					text: `SELECT c.logo, f.key, f.field FROM customers c JOIN sys_file f ON f.id = c.logo->>'id'`,
					params: []
				}
			]);
			const row = result?.rows[0];
			if (row === undefined) throw new Error('Restored file row missing.');
			expect(row).toMatchObject({
				logo: { name: 'bank.png', mime: 'image/png' },
				field: 'customers.logo'
			});
			expect(readFileSync(join(scratch, 'files', String(row['key'])), 'utf8')).toBe('PNG bytes');
		})
	);

	it.effect('serves the client document on app paths and its chunks', () =>
		Effect.gen(function* () {
			const response = yield* call('/app/sales/board');
			const html = yield* Effect.promise(() => response.text());
			const entry = /src="\/(assets\/[^"]+\.js)"/.exec(html)?.[1];
			if (entry === undefined) throw new Error('Client entry missing.');
			const js = yield* call(`/${entry}`);
			expect(js.status).toBe(200);
			expect(js.headers.get('content-type')).toBe('text/javascript');
			expect((yield* call('/__bolt/nope')).status).toBe(404);
			const thumbnail = yield* call('/assets/thumbnail.svg');
			expect(yield* Effect.promise(() => thumbnail.text())).toBe('<svg/>');
		})
	);

	it.effect(
		'hot-swaps a rebuilt activation onto the same database',
		() =>
			Effect.gen(function* () {
				const host = yield* DevHost;
				const model = join(root, 'src/data/model/customers/+model.ts');
				writeFileSync(
					model,
					readFileSync(model, 'utf8').replace(
						"name: { kind: 'text' },",
						"name: { kind: 'text' }, city: { kind: 'text', optional: true },"
					)
				);
				const { artifact } = yield* buildWorkspace(root);
				yield* host.swap(yield* readArtifact(artifact.dir));
				const q = yield* Schema.decodeUnknownEffect(
					Schema.Struct({
						answers: Schema.Array(
							Schema.Struct({
								rows: Schema.Array(Schema.Struct({ name: Schema.String, city: Schema.Null }))
							})
						)
					})
				)(
					yield* json(
						yield* call('/__bolt/q', { reads: [{ m: 'query', a: ['customers', { all: true }] }] })
					)
				);
				expect(q.answers[0]?.rows).toHaveLength(2);
				expect(q.answers[0]?.rows[0]).toHaveProperty('city', null);
			}),
		60_000
	);
});
