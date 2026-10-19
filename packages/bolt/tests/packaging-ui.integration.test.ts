/// <reference types="node" />
// Packaging gaps found migrating the 0.0.1 templates, on PGlite: a restore fills a column's default for a key a row
// omits (rule 70); `/runs` lists a holder's runs as rule 56 lets them read them; `testWorkspace({ seed })` takes the
// named packs, and the base pack goes through `seed/seed.ts`; the client build loads representations lazily, hands
// custom field renderers to the shell and keeps pages on the shell's one `@norbital-ai/ui`.
import { randomUUID } from 'node:crypto';
import {
	cpSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Result, Schema } from 'effect';
import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import type { Authority } from '../src/engine/contracts.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { json, qReply, routeFixture } from './support/route-fixture.ts';
import { runList } from '../src/shell/runs/data.ts';
import { TestWorkspace } from '../src/test/index.ts';
import { check } from '../src/compiler/check/index.ts';
import { discover } from '../src/compiler/discover.ts';
import { buildClient } from '../src/compiler/artifact/client.ts';

const node = NodeServices.layer;

const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en', apps: [] },
		models: {
			jobs: {
				description: 'Jobs',
				label: 'title',
				fields: {
					title: { kind: 'text' },
					status: { kind: 'enum', values: ['open', 'closed'], default: 'open' }
				}
			}
		},
		relationships: {},
		collections: { jobs: { read: { fields: 'all' } } },
		integrations: {},
		pipelines: {},
		policies: {},
		apps: {},
		teams: {},
		automations: {},
		connections: {},
		envoys: {},
		mcp: {},
		customFields: {},
		agent: { skills: {} }
	})
);

describe('seed restore', () => {
	it.live('gives a key a row omits its column default, not null', () =>
		Effect.gen(function* () {
			const context = yield* Layer.build(
				TestWorkspace.layer({
					manifest,
					seed: {
						jobs: [
							{ id: randomUUID(), title: 'A', status: 'closed' },
							{ id: randomUUID(), title: 'B' }
						]
					}
				})
			);
			const t = Context.get(context, TestWorkspace);
			const [r] = yield* t.db.read([
				{ text: 'SELECT title, status FROM jobs ORDER BY title', params: [] }
			]);
			if (r === undefined) throw new Error('seed result missing');
			expect(r.rows).toEqual([
				{ title: 'A', status: 'closed' },
				{ title: 'B', status: 'open' }
			]);
		})
	);
});

describe('/runs', () => {
	it.live(
		"lists a holder's runs of one automation in full, and a causing member's with the error code only",
		() =>
			Effect.gen(function* () {
				const context = yield* Layer.build(TestWorkspace.layer({ manifest }));
				const t = Context.get(context, TestWorkspace);
				const run = (automation: string, actor: string) =>
					t.db.write({
						text: `INSERT INTO sys_run (id, automation, input, due_at, cause, depth, actor, state, error)
			VALUES ($1, $2, '{}', now(), 'start', 0, $3, 'failed', '{"code":"invalid","message":"bad row 3"}')`,
						params: [randomUUID(), automation, actor]
					});
				yield* run('export', 'member:u9');
				yield* run('export', 'member:u2');
				yield* run('import', 'member:u9');
				const who = (id: string, automations: string[], external: boolean): Authority => ({
					key: id,
					admin: false,
					policies: [],
					collections: {},
					automations,
					limits: [],
					teamTree: [],
					scopes: {},
					actor: {
						kind: 'member',
						id,
						email: null,
						phone: null,
						external,
						teams: [],
						teamPath: [],
						admin: false,
						party: null
					},
					capabilities: { apps: [], tools: [], mcp: [], skills: [] }
				});
				const holder = yield* runList(t.db, who('u1', ['export'], true), 10, 'export');
				expect(holder.map((r) => [r.automation, r.error])).toEqual([
					['export', { code: 'invalid', message: 'bad row 3' }],
					['export', { code: 'invalid', message: 'bad row 3' }]
				]);
				expect(yield* runList(t.db, who('u2', [], false), 10)).toEqual([
					expect.objectContaining({
						automation: 'export',
						status: 'failed',
						error: { code: 'invalid' }
					})
				]);
			})
	);
});

describe('the page organization', () => {
	it.live(
		"boots with the workspace name and the host's brand logo, which pages read as bolt.org",
		() =>
			Effect.gen(function* () {
				const site = Result.getOrThrow(
					decodeManifest({
						...manifest,
						apps: {
							site: {
								title: 'Site',
								description: 'd',
								icon: 'i',
								audience: { public: ['guest'] },
								pages: { home: { title: 'Home' } }
							}
						},
						policies: { guest: { description: 'Visitors', grants: {} } }
					})
				);
				const context = yield* Layer.build(
					TestWorkspace.layer({
						manifest: site,
						host: {
							publicUrl: 'https://acme.example',
							ai: false,
							workspace: {
								name: 'Acme',
								handle: 'acme',
								icons: [{ src: '/assets/logo.svg', sizes: 'any', type: 'image/svg+xml' }]
							}
						}
					})
				);
				const t = Context.get(context, TestWorkspace);
				const response = yield* t.handle(new Request('https://acme.example/__bolt/shell?app=site'));
				const body = yield* Schema.decodeUnknownEffect(
					Schema.Struct({ value: Schema.Struct({ workspace: Schema.Json }) })
				)(yield* json(response));
				expect(body.value.workspace).toMatchObject({ name: 'Acme', logo: '/assets/logo.svg' });
			})
	);
});

const FIXTURE = fileURLToPath(new URL('./fixtures/good', import.meta.url));
const scratch = join(tmpdir(), 'norbital-scratch', `packaging-${randomUUID()}`);
const write = (path: string, text: string) => {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, text);
};
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
function copy(name: string): string {
	const root = join(scratch, name);
	cpSync(FIXTURE, root, { recursive: true, filter: (p) => !p.includes('.norbital') });
	mkdirSync(join(root, 'node_modules'), { recursive: true });
	symlinkSync(
		fileURLToPath(new URL('../node_modules/effect', import.meta.url)),
		join(root, 'node_modules', 'effect'),
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
	write(join(root, 'tsconfig.json'), '{}');
	return root;
}

describe('testWorkspace seed', () => {
	it.live(
		'builds the base pack through seed/seed.ts, restores none on request, and needs a built sample',
		() =>
			Effect.gen(function* () {
				const root = copy('seeded');
				write(
					join(root, 'seed/seed.ts'),
					`export default { bank: 'acme',
	rows: (bank) => ({ customers: [{ id: '0199a000-0000-4000-8000-0000000000c1', name: bank.has('customers.json') ? 'Bank' : 'Public' }] }) };`
				);
				const base = yield* Layer.build(TestWorkspace.layer({ root })),
					bt = Context.get(base, TestWorkspace),
					br = yield* routeFixture(base);
				const read = (
					route: Effect.Success<ReturnType<typeof routeFixture>>,
					authority: Authority
				) =>
					qReply(route, authority, {
						reads: [{ m: 'read', a: ['customers', { limit: 10 }] }]
					}).pipe(
						Effect.flatMap((reply) =>
							Schema.decodeUnknownEffect(
								Schema.Struct({ rows: Schema.Array(Schema.Struct({ name: Schema.String })) })
							)(reply.answers[0])
						)
					);
				expect((yield* read(br, bt.as(bt.admin).authority)).rows.map((row) => row.name)).toEqual([
					'Public'
				]);
				const none = yield* Layer.build(TestWorkspace.layer({ root, seed: 'none' })),
					nt = Context.get(none, TestWorkspace),
					nr = yield* routeFixture(none);
				expect((yield* read(nr, nt.as(nt.admin).authority)).rows).toEqual([]);
				expect(
					(yield* Layer.build(TestWorkspace.layer({ root, seed: 'sample' })).pipe(Effect.flip))
						.message
				).toContain('bolt build --bank');
			}).pipe(Effect.provide(node)),
		60_000
	);
});

describe('the client build', () => {
	it.live(
		'loads representations on first use, registers custom field renderers, and resolves @norbital-ai/ui to the shell copy',
		() =>
			Effect.gen(function* () {
				const root = copy('client');
				write(
					join(root, 'src/app/sales/+board.page.svelte'),
					`<script lang="ts">import { Table } from '@norbital-ai/ui';</script>\n<p class="tracking-[13.271px]">INTERNAL_PAGE_4c517192</p><button onclick={() => new Worker(new URL('./sample.worker.ts', import.meta.url), { type: 'module' })}>Worker</button><Table of="customers" columns={['name']} />\n`
				);
				write(
					join(root, 'src/app/sales/sample.worker.ts'),
					"self.onmessage = () => self.postMessage('WORKER_MODULE_91e4936b');"
				);
				write(join(root, 'src/app/sales/+session.svelte'), '<p>INTERNAL_SESSION_94735c67</p>');
				write(
					join(root, 'src/app/public/+app.ts'),
					`import { app } from '@norbital-ai/bolt';
export default app('public', { title: 'Public', description: 'Public pages', icon: 'info', audience: 'external', pages: { welcome: { title: 'Welcome' }, other: { title: 'Other' } } });`
				);
				for (const name of ['welcome', 'other']) {
					write(
						join(root, `src/lib/public-${name}.svelte`),
						`<p class="tracking-[${name === 'welcome' ? '7.123' : '9.431'}px]">PUBLIC_${name.toUpperCase()}_dc7818fd</p>`
					);
					write(
						join(root, `src/app/public/+${name}.page.svelte`),
						`<script lang="ts">import Content from '../../lib/public-${name}.svelte'; let { data }: { data: null } = $props();</script><Content />`
					);
					write(
						join(root, `src/app/public/${name}.page.data.ts`),
						"import { Schema } from 'effect'; export default Schema.Null;"
					);
					write(
						join(root, `src/app/public/+${name}.page.server.ts`),
						`import { pageServer } from '@norbital-ai/bolt'; import data from './${name}.page.data.ts'; export default pageServer({ data, load: function* () { return null; } });`
					);
				}
				write(
					join(root, 'src/integration/mail/+integration.svelte'),
					'<p data-own-setup>Mail setup</p>'
				);
				write(
					join(root, 'src/integration/erp/+integration.svelte'),
					'<p data-own-setup>ERP setup</p>'
				);
				const c = yield* check(root).pipe(Effect.provide(node));
				expect(c.errors).toEqual([]);
				const out = join(root, '.norbital', 'artifact', 'client');
				if (c.manifest === undefined) throw new Error('compiled manifest missing');
				const discovered = yield* discover(root).pipe(Effect.provide(node));
				const privateText = {
					internal: 'PRIVATE_INTERNAL_AGENT_PROMPT_67c0fcf4',
					external: 'PRIVATE_EXTERNAL_AGENT_PROMPT_f75cfe87',
					skill: 'PRIVATE_AGENT_SKILL_BODY_a4d4c847'
				};
				const { entry: internalEntry, pages: publicPages } = yield* buildClient(
					root,
					discovered.files,
					{
						...c.manifest,
						agent: {
							internal: privateText.internal,
							external: privateText.external,
							skills: { private_skill: privateText.skill }
						}
					},
					out,
					'Good'
				).pipe(Effect.provide(node));
				const html = readFileSync(join(out, 'index.html'), 'utf8');
				expect(html).toContain('id="bolt-loading" role="status"');
				expect(html).toContain('Opening workspace…');
				expect(html).toContain('id="bolt-initial-modules"');
				const initialized = yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(
						Schema.Struct({
							modules: Schema.Array(Schema.String),
							css: Schema.Array(Schema.String)
						})
					)
				)(/id="bolt-initial-modules">([^<]*)<\/script>/.exec(html)?.[1]);
				const mainThread = initialized.modules.map((file) => readFileSync(join(out, file), 'utf8'));
				expect(mainThread.some((text) => text.includes('INTERNAL_PAGE_4c517192'))).toBe(true);
				expect(mainThread.some((text) => text.includes('WORKER_MODULE_91e4936b'))).toBe(false);
				expect(
					readdirSync(join(out, 'assets')).some(
						(file) =>
							file.endsWith('.js') &&
							readFileSync(join(out, 'assets', file), 'utf8').includes('WORKER_MODULE_91e4936b')
					)
				).toBe(true);
				const js = readFileSync(join(out, internalEntry), 'utf8');
				expect(js).toMatch(/representations:\{orders:\(\)=>/);
				expect(js).toMatch(/customFields:\{rating:\{shape:\{/);
				const registry = js.match(/integrationSetups:\{(.{0,700})/s)?.[1] ?? '';
				expect(registry).toMatch(/erp:\{load:\(\)=>/);
				expect(registry).toMatch(/mail:\{load:\(\)=>/);
				expect(js).not.toContain('connects:');
				const chunks = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js'));
				for (const file of readdirSync(out, { recursive: true }).map(String)) {
					if (!/\.(?:html|js|map)$/.test(file)) continue;
					const payload = readFileSync(join(out, file), 'utf8');
					for (const text of Object.values(privateText)) expect(payload, file).not.toContain(text);
				}
				expect(Object.keys(publicPages).sort()).toEqual(['app/public/other', 'app/public/welcome']);
				const publicManifest = yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(
						Schema.Record(
							Schema.String,
							Schema.Struct({
								file: Schema.String,
								imports: Schema.optionalKey(Schema.Array(Schema.String)),
								dynamicImports: Schema.optionalKey(Schema.Array(Schema.String))
							})
						)
					)
				)(readFileSync(join(out, 'public/.vite/manifest.json'), 'utf8'));
				for (const name of ['welcome', 'other']) {
					const publicRoot = join(out, 'public', 'app', 'public', name);
					const page = publicPages[`app/public/${name}`];
					if (page === undefined) throw new Error(`Missing public ${name} build`);
					const entry = Object.entries(publicManifest).find(
						([, chunk]) => `public/${chunk.file}` === page.entry
					)?.[0];
					if (entry === undefined) throw new Error(`Missing public ${name} manifest entry`);
					const reached = new Set<string>();
					const collect = (key: string): void => {
						if (reached.has(key)) return;
						reached.add(key);
						const chunk = publicManifest[key];
						if (chunk === undefined) throw new Error(`Missing public chunk ${key}`);
						for (const dependency of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])])
							collect(dependency);
					};
					collect(entry);
					const payload = [...reached]
						.map((key) => {
							const chunk = publicManifest[key];
							if (chunk === undefined) throw new Error(`Missing public chunk ${key}`);
							return (
								readFileSync(join(out, 'public', chunk.file), 'utf8') +
								readFileSync(join(out, 'public', `${chunk.file}.map`), 'utf8')
							);
						})
						.join('\n');
					expect(payload).toContain(`PUBLIC_${name.toUpperCase()}_dc7818fd`);
					expect(payload).not.toContain(
						`PUBLIC_${name === 'welcome' ? 'OTHER' : 'WELCOME'}_dc7818fd`
					);
					expect(payload).not.toContain('INTERNAL_PAGE_4c517192');
					expect(payload).not.toContain('INTERNAL_SESSION_94735c67');
					for (const component of ['Shell.svelte', 'agent/Agent.svelte', 'studio/Studio.svelte'])
						expect(payload).not.toContain(`/shell/${component}`);
					const css = page.css.map((file) => readFileSync(join(out, file), 'utf8')).join('\n');
					expect(css).toContain(`${name === 'welcome' ? '7.123' : '9.431'}px`);
					expect(css).not.toContain(`${name === 'welcome' ? '9.431' : '7.123'}px`);
					expect(css).not.toContain('13.271px');
					expect(readFileSync(join(publicRoot, 'index.html'), 'utf8')).not.toContain(
						'bolt-loading'
					);
				}
				expect(js.includes('<p>order</p>')).toBe(false);
				expect(
					chunks.some((f) => readFileSync(join(out, 'assets', f), 'utf8').includes('<p>order</p>'))
				).toBe(true);
				// one ui: no chunk carries a second copy of the views' context module
				const copies = chunks.filter((f) =>
					readFileSync(join(out, 'assets', f), 'utf8').includes(
						'A view needs the shell: call provideBolt(bolt) above it.'
					)
				);
				expect(copies.length).toBe(1);
			}),
		120_000
	);
});
