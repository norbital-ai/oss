import { Effect } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { scratchPath } from '../../../scripts/lib/scratch.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect } from 'vitest';
import { it } from '@effect/vitest';
import { discover, LAYOUT_HELP } from '../src/compiler/discover.ts';
import { buildPacks } from '../src/compiler/artifact/seed.ts';
import type { CheckDiagnostic } from '../src/compiler/check/index.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { engineManifest } from '../src/engine/manifest.ts';
import { load, manifestErrors } from '../src/compiler/load.ts';
import { namesIndex, writeNames } from '../src/compiler/names.ts';
import { install } from '../src/decl/runtime/guest.ts';
install();
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const BOLT = '../../../../src/index.ts'; // src as seen from a fixture's .norbital/
describe('next compiler: discover', () => {
	it.live('discovers named model files and policies and rejects retired layout roles', () =>
		Effect.gen(function* () {
			const root = yield* scratchPath(`compiler-layout-${randomUUID()}`);
			const write = (path: string) => {
				mkdirSync(dirname(join(root, path)), { recursive: true });
				writeFileSync(join(root, path), 'export default {};');
			};
			try {
				for (const path of [
					'src/+workspace.ts',
					'src/data/model/+orders.model.ts',
					'src/data/collection/orders/+collection.ts',
					'src/access_control/policy/+sales.policy.ts'
				])
					write(path);
				const found = yield* discover(root);
				expect(found.errors).toEqual([]);
				expect(found.files).toContainEqual({
					role: 'model',
					name: 'orders',
					path: 'src/data/model/+orders.model.ts'
				});
				expect(found.files).toContainEqual({
					role: 'policy',
					name: 'sales',
					path: 'src/access_control/policy/+sales.policy.ts'
				});
				write('src/data/model/orders/+model.ts');
				write('src/access/+sales.policy.ts');
				expect((yield* discover(root)).errors.map((error) => error.code)).toEqual([
					'discover/wrong-folder',
					'discover/unknown-role'
				]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('discovers named integration definitions and requires setup companions', () =>
		Effect.gen(function* () {
			const root = yield* scratchPath(`compiler-integrations-${randomUUID()}`);
			const write = (path: string) => {
				mkdirSync(dirname(join(root, path)), { recursive: true });
				writeFileSync(join(root, path), 'export default {};');
			};
			try {
				write('src/+workspace.ts');
				write('src/integration/calendar/+integration.ts');
				write('src/integration/calendar/+integration.svelte');
				expect((yield* discover(root)).errors).toEqual([]);
				expect((yield* discover(root)).files).toContainEqual({
					role: 'integration_definition',
					name: 'calendar',
					path: 'src/integration/calendar/+integration.ts'
				});
				expect((yield* discover(root)).files).toContainEqual({
					role: 'integration_setup',
					name: 'calendar',
					path: 'src/integration/calendar/+integration.svelte'
				});
				write('src/integration/orphan/+integration.svelte');
				expect((yield* discover(root)).errors.map((error) => error.code)).toEqual([
					'discover/setup-without-integration'
				]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live(
		'loads +secrets.ts into the tenant manifest, indexes its names and rejects values or unknown keys',
		() =>
			Effect.gen(function* () {
				const root = yield* scratchPath(`compiler-secrets-${randomUUID()}`);
				try {
					mkdirSync(join(root, 'src'), { recursive: true });
					writeFileSync(
						join(root, 'src/+workspace.ts'),
						"export default { tz: 'UTC', locale: 'en' };"
					);
					writeFileSync(
						join(root, 'src/+secrets.ts'),
						"export default { API_URL: { label: 'API', description: 'The base URL' }, API_SECRET: { label: 'Secret' } };"
					);
					const { files, errors } = yield* discover(root);
					expect(errors).toEqual([]);
					expect(files).toContainEqual({ role: 'secrets', name: '', path: 'src/+secrets.ts' });
					const loaded = yield* load(root, files);
					expect(loaded.errors).toEqual([]);
					expect(engineManifest(loaded.manifest).workspace.secrets).toEqual({
						API_URL: { label: 'API', description: 'The base URL' },
						API_SECRET: { label: 'Secret' }
					});
					expect(namesIndex(files, loaded.manifest)).toContain(
						'secrets: typeof import("../src/+secrets.ts").default'
					);
					loaded.manifest.secrets[''] = {
						API_SECRET: { label: 'Secret', default: 'must-not-ship' }
					};
					expect(manifestErrors(loaded.manifest).map((error) => error.code)).toContain(
						'load/secrets-shape'
					);
					loaded.manifest.secrets[''] = { api_secret: { label: 'Secret' } };
					expect(manifestErrors(loaded.manifest).map((error) => error.code)).toContain(
						'load/secrets-shape'
					);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('names every role from its path', () =>
		Effect.gen(function* () {
			const { files, errors } = yield* discover(fixture('good'));
			expect(errors).toEqual([]);
			expect(files.map((f) => `${f.role} ${f.name}`).sort()).toEqual([
				'agent ',
				'app hr/kiosk',
				'app sales',
				'automation nightly',
				'collection customers',
				'collection notices',
				'collection orders',
				'custom_field rating',
				'envoy desk',
				'group hr',
				'integration_definition erp',
				'integration_definition mail',
				'kiosk clock',
				'kiosk_page clock/clock',
				'locale ms',
				'mcp hq',
				'messages ',
				'model customers',
				'model notices',
				'model orders',
				'page hr/kiosk/clock',
				'page sales/board',
				'page sales/list',
				'policy kiosk_reader',
				'policy sales_rep',
				'relationship ',
				'renderer rating',
				'representation orders',
				'skill triage',
				'team ',
				'workspace '
			]);
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('refuses every layout mistake with a stable code and the role table as help', () =>
		Effect.gen(function* () {
			const { errors } = yield* discover(fixture('bad'));
			expect(errors.map((e) => `${e.code} ${e.path}`).sort()).toEqual([
				'discover/app-and-group src/app/sales/+app.ts',
				'discover/app-and-group src/app/sales/+group.ts',
				'discover/app-nesting src/app/shop/inner/+app.ts',
				'discover/bad-name src/data/model/+Bad.model.ts',
				'discover/collection-without-model src/data/collection/ghost/+collection.ts',
				'discover/custom-field-without-definition src/data/custom_field/stars/+renderer.svelte',
				'discover/messages-missing src/i18n/+ms.messages.ts',
				'discover/name-clash src/automation/+orders.automation.ts',
				'discover/one-per-folder src/data/collection/orders/+erp.integration.ts',
				'discover/page-without-app src/app/empty/+board.page.svelte',
				'discover/plural-folder src/automations/+sync.automation.ts',
				'discover/reserved-name src/data/custom_field/phone/+definition.ts',
				'discover/reserved-name src/data/model/+sys_thing.model.ts',
				'discover/reserved-name src/integration/whatsapp/+integration.ts',
				'discover/seed-unknown-collection seed/nope.json',
				'discover/unknown-role src/+layout.ts',
				'discover/unknown-role src/lib/+helper.ts',
				'discover/without-collection src/data/collection/lonely/+pipeline.ts',
				'discover/workspace-missing src/+workspace.ts',
				'discover/wrong-folder src/access_control/policy/+late.automation.ts',
				'discover/wrong-folder src/data/collection/orders/+integration.ts'
			]);
			expect(errors.every((e) => e.help === LAYOUT_HELP)).toBe(true);
			expect(LAYOUT_HELP).toContain('src/integration/<name>/+integration.ts');
			expect(LAYOUT_HELP).not.toContain('src/data/collection/<app>/+integration.ts');
			expect(LAYOUT_HELP).toContain('src/access_control/policy/+<name>.policy.ts');
			expect(errors.find((e) => e.code === 'discover/plural-folder')?.message).toContain(
				"'automations' is 'automation'"
			);
		}).pipe(Effect.provide(NodeServices.layer))
	);
});
describe('next compiler: load', () => {
	it.live('validates source team composition and hierarchy independently of display labels', () =>
		Effect.gen(function* () {
			const root = yield* scratchPath(`compiler-source-access-${randomUUID()}`);
			const write = (path: string, text: string) => {
				mkdirSync(dirname(join(root, path)), { recursive: true });
				writeFileSync(join(root, path), text);
			};
			try {
				write('src/+workspace.ts', "export default { tz: 'UTC', locale: 'en' };");
				write('src/access_control/policy/+sales.policy.ts', 'export default { grants: {} };');
				write(
					'src/access_control/team/+team.ts',
					"export default { root: { name: 'Shared label', parent: null, policies: ['sales'] }, branch: { name: 'Shared label', parent: 'root', policies: [] }, Root: ['sales'] };"
				);
				const found = yield* discover(root);
				expect(found.files).toContainEqual({
					role: 'team',
					name: '',
					path: 'src/access_control/team/+team.ts'
				});
				const loaded = yield* load(root, found.files);
				expect(loaded.errors).toEqual([]);
				const check = (teams: unknown) =>
					manifestErrors({ ...loaded.manifest, team: { '': teams } }).map((error) => error.code);
				expect(check({ role: ['unknown'] })).toContain('load/team-policy');
				expect(check({ role: { policies: [], parent: 'missing' } })).toContain('load/team-parent');
				expect(
					check({ a: { policies: [], parent: 'b' }, b: { policies: [], parent: 'a' } })
				).toContain('load/team-cycle');
				expect(check({ role: { policies: 'sales' } })).toContain('load/team-shape');
				expect(check({ role: { policies: [], name: '' } })).toContain('load/team-name');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('emits definitions, envoys and connections and indexes the feed targets', () =>
		Effect.gen(function* () {
			const root = yield* scratchPath(`compiler-integration-load-${randomUUID()}`);
			const write = (path: string, text: string) => {
				mkdirSync(dirname(join(root, path)), { recursive: true });
				writeFileSync(join(root, path), text);
			};
			try {
				write(
					'src/+workspace.ts',
					"export default { tz: 'UTC', locale: 'en', connections: { ledger: { integration: 'books' }, wa: { integration: 'whatsapp', envoy: 'desk' } } };"
				);
				write(
					'src/data/model/+entries.model.ts',
					"export default { key: ['source', 'code'], fields: { code: { kind: 'text' } } };"
				);
				write(
					'src/data/+relationship.ts',
					"export default { 'entries.source': { to: 'sys_integration', where: { integration: { eq: 'books' } } } };"
				);
				write(
					'src/data/collection/entries/+collection.ts',
					"export default { name: 'entries', spec: { read: { fields: 'all' } } };"
				);
				write(
					'src/agent/envoy/+desk.envoy.ts',
					"export default { name: 'Desk', audience: 'public', policies: ['p'], delegation: 'disabled', task: 'x' };"
				);
				write(
					'src/integration/books/+integration.ts',
					`export default { name: 'books', spec: { description: 'x', driver: 'sqlserver',
				feeds: { entries: { into: 'entries', key: ['code'], cron: '@hourly' } } }, bodies: { feeds: { entries: { read: () => null } }, outbound: {} } };`
				);
				const found = yield* discover(root),
					loaded = yield* load(root, found.files);
				expect(found.errors).toEqual([]);
				expect(loaded.errors).toEqual([]);
				const manifest = engineManifest(loaded.manifest);
				expect(Object.keys(manifest.integrations)).toEqual(['books']);
				expect(manifest.integrations['books']?.feeds?.['entries']).toEqual({
					into: 'entries',
					key: ['code'],
					cron: '@hourly'
				});
				expect(manifest.connections).toEqual({
					ledger: { integration: 'books' },
					wa: { integration: 'whatsapp', envoy: 'desk' }
				});
				expect(manifest.workspace).not.toHaveProperty('connections');
				expect(manifest.envoys['desk']).toMatchObject({ name: 'Desk', audience: 'public' });
				const names = namesIndex(found.files, loaded.manifest);
				expect(names).toContain('fed: { "entries": "books.entries" };');
				expect(names).toContain(
					'integrations: { "books": typeof import("../src/integration/books/+integration.ts").default };'
				);
				expect(names).toContain(
					'envoys: { "desk": typeof import("../src/agent/envoy/+desk.envoy.ts").default };'
				);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live(
		'refuses a feed that does not own its target or its key, a misnamed definition and a missing body',
		() =>
			Effect.gen(function* () {
				const root = yield* scratchPath(`compiler-integration-checks-${randomUUID()}`);
				const write = (path: string, text: string) => {
					mkdirSync(dirname(join(root, path)), { recursive: true });
					writeFileSync(join(root, path), text);
				};
				const definition = (name: string, spec: string, bodies = '{ feeds: {}, outbound: {} }') =>
					`export default { name: ${JSON.stringify(name)}, spec: ${spec}, bodies: ${bodies} };`;
				const feed = (into: string) =>
					`${into}: { into: '${into}', key: ['code'], cron: '@hourly' }`;
				const read = (...feeds: string[]) =>
					`{ feeds: { ${feeds.map((f) => `${f}: { read: true }`).join(', ')} }, outbound: {} }`;
				try {
					write(
						'src/+workspace.ts',
						"export default { tz: 'UTC', locale: 'en', connections: { ledger: { integration: 'books' } } };"
					);
					for (const m of ['entries', 'items', 'lines', 'open'])
						write(
							`src/data/model/+${m}.model.ts`,
							"export default { key: ['source', 'code'], fields: { code: { kind: 'text' } } };"
						);
					write(
						'src/data/+relationship.ts',
						`export default {
				'entries.source': { to: 'sys_integration', where: { integration: { eq: 'books' } } },
				'items.source': { to: 'sys_integration', where: { integration: { eq: 'books' } } },
				'lines.source': { to: 'sys_integration' },
				'open.source': { to: 'sys_integration', where: { integration: { eq: 'books' } } } };`
					);
					write(
						'src/data/collection/entries/+collection.ts',
						"export default { name: 'entries', spec: { read: { fields: 'all' }, notifications: { committed: [{ channel: 'ledger', to: [], title: 't' }] } } };"
					);
					for (const c of ['items', 'lines'])
						write(
							`src/data/collection/${c}/+collection.ts`,
							`export default { name: '${c}', spec: { read: { fields: 'all' } } };`
						);
					write(
						'src/data/collection/open/+collection.ts',
						"export default { name: 'open', spec: { read: { fields: 'all' }, create: { input: { columns: ['code'] } }, actions: { go: {} } } };"
					);
					// books: entries (fine), open (exposes writes), ghost (no collection), push (a command without run)
					write(
						'src/integration/books/+integration.ts',
						definition(
							'books',
							`{ description: 'x', driver: 'sqlserver',
				feeds: { ${feed('entries')}, ${feed('open')}, ${feed('ghost')} }, outbound: { push: { from: 'entries', via: 'ledger' } } }`,
							`{ feeds: { entries: { read: true }, open: { read: true }, ghost: { read: true } }, outbound: { push: { build: true } } }`
						)
					);
					// again: entries (first) keyed by books' instance; other: misnamed, items pinned to books, no body; third: lines unpinned
					write(
						'src/integration/again/+integration.ts',
						definition(
							'again',
							`{ description: 'x', driver: 'sqlserver', feeds: { ${feed('entries')} } }`,
							read('entries')
						)
					);
					write(
						'src/integration/other/+integration.ts',
						definition(
							'otter',
							`{ description: 'x', driver: 'sqlserver', feeds: { ${feed('items')} } }`
						)
					);
					write(
						'src/integration/third/+integration.ts',
						definition(
							'third',
							`{ description: 'x', driver: 'sqlserver', feeds: { ${feed('lines')} } }`,
							read('lines')
						)
					);
					write(
						'src/integration/chat/+integration.ts',
						definition(
							'chat',
							"{ description: 'x', driver: 'http', conversation: { kind: 'chat', handle: 'phone' }, webhook: { scheme: 'bearer', secret: 'token' } }"
						)
					);
					const found = yield* discover(root);
					expect(found.errors).toEqual([]);
					const loaded = yield* load(root, found.files);
					const errors = [...loaded.errors, ...manifestErrors(loaded.manifest)];
					const at = (code: string) => errors.filter((e) => e.code === code).map((e) => e.message);
					expect(at('load/name-mismatch')).toEqual([
						"src/integration/other/+integration.ts: declares integration('otter'); the folder names it 'other'"
					]);
					expect(at('load/feed-target')).toEqual([
						"src/integration/books/+integration.ts: feed 'entries' writes 'entries', which again.entries already writes",
						"src/integration/books/+integration.ts: feed 'open' writes 'open', whose collection exposes create, actions: a feed's rows change only through it (local fields through update)",
						"src/integration/books/+integration.ts: feed 'ghost' writes 'ghost', which is no collection"
					]);
					expect(at('load/feed-key').map((m) => m.slice(0, m.indexOf(':')))).toEqual([
						'src/integration/again/+integration.ts',
						'src/integration/other/+integration.ts',
						'src/integration/third/+integration.ts'
					]);
					expect(at('load/feed-key')[0]).toContain("one FK to sys_integration pinned to 'again'");
					expect(at('load/missing-body')).toEqual([
						"src/integration/books/+integration.ts: outbound 'push' commands through a sqlserver instance: its body declares run",
						'src/integration/chat/+integration.ts: a custom conversation attaches chat.receive(…)',
						'src/integration/chat/+integration.ts: a custom conversation attaches chat.send(…)',
						"src/integration/other/+integration.ts: feed 'items' has no body: attach other.feed('items', { read })"
					]);
					expect(at('load/notification-channel')).toEqual([
						"src/data/collection/entries/+collection.ts: a notification's channel is 'inbox' or a conversation connection; 'ledger' is not"
					]);
					expect(errors.length).toBe(12);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live("reserves bolt's conversation definitions and the inbox", () =>
		Effect.gen(function* () {
			const root = yield* scratchPath(`compiler-reserved-integrations-${randomUUID()}`);
			const write = (path: string) => {
				mkdirSync(dirname(join(root, path)), { recursive: true });
				writeFileSync(join(root, path), 'export default {};');
			};
			try {
				for (const path of [
					'src/+workspace.ts',
					'src/integration/email/+integration.ts',
					'src/integration/inbox/+integration.ts',
					'src/integration/supplier_mail/+integration.ts'
				])
					write(path);
				const { errors } = yield* discover(root);
				expect(errors.map((e) => `${e.code} ${e.path}`)).toEqual([
					'discover/reserved-name src/integration/email/+integration.ts',
					'discover/reserved-name src/integration/inbox/+integration.ts'
				]);
				expect(errors[0]?.message).toContain(
					'discord, email, slack, telegram, wechat, whatsapp, inbox are reserved'
				);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('imports each default export into the manifest', () =>
		Effect.gen(function* () {
			const root = fixture('good');
			const { manifest, errors } = yield* load(root, (yield* discover(root)).files);
			expect(errors).toEqual([]);
			expect(manifestErrors(manifest)).toEqual([]);
			expect(Object.keys(manifest.model).sort()).toEqual(['customers', 'notices', 'orders']);
			expect(manifest.collection.orders).toHaveProperty('bodies.queries.count_placed');
			expect(manifest.custom_field.rating).toHaveProperty('check', expect.any(Function));
			expect(manifest.integration_definition.mail).toMatchObject({
				name: 'mail',
				spec: { driver: 'email', feeds: { notices: { into: 'notices' } } }
			});
			expect(manifest.integration_definition.mail).toHaveProperty(
				'bodies.feeds.notices.map',
				expect.any(Function)
			);
			expect(manifest.envoy.desk).toMatchObject({ name: 'Norbius', policies: ['sales_rep'] });
			expect(manifest.skill.triage).toContain('description: Triage a notice');
			expect(manifest.page['sales/board']).toBe('src/app/sales/+board.page.svelte');
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('refuses declarations that do not load or do not match their path', () =>
		Effect.gen(function* () {
			const root = fixture('load-bad');
			const found = yield* discover(root);
			expect(found.errors).toEqual([]);
			const loaded = yield* load(root, found.files);
			const errors = [...loaded.errors, ...manifestErrors(loaded.manifest)];
			expect(errors.map((e) => `${e.code} ${e.path}`).sort()).toEqual([
				'app/page-unlisted src/app/sales/+stray.page.svelte',
				'load/collection-name src/data/collection/orders/+collection.ts',
				'load/failed src/integration/broken/+integration.ts',
				'load/feed-key src/integration/orders_source/+integration.ts',
				'load/missing-body src/integration/orders_source/+integration.ts',
				'load/name-mismatch src/integration/orders_source/+integration.ts',
				'load/no-default src/data/model/+orders.model.ts',
				'load/skill-description src/agent/skill/+nodesc.skill.md'
			]);
			expect(errors.find((e) => e.code === 'load/failed')?.message).toContain('boom at load');
		}).pipe(Effect.provide(NodeServices.layer))
	);
});
describe('next compiler: names index', () => {
	it.live(
		'maps every path-derived name to its default export, sorted, written only on change',
		() =>
			Effect.gen(function* () {
				const root = fixture('good');
				const { files } = yield* discover(root);
				const { manifest } = yield* load(root, files);
				const text = namesIndex(files, manifest, BOLT);
				rmSync(join(root, '.norbital'), { recursive: true, force: true });
				expect(yield* writeNames(root, text)).toBe(true);
				expect(yield* writeNames(root, text)).toBe(false);
				expect(readFileSync(join(root, '.norbital/names.ts'), 'utf8')).toBe(text);
				expect(text).toContain(
					`models: { "customers": typeof import("../src/data/model/+customers.model.ts").default; "notices": `
				);
				expect(text).toContain('fed: { "notices": "mail.notices" };');
				expect(text).toContain(
					'envoys: { "desk": typeof import("../src/agent/envoy/+desk.envoy.ts").default };'
				);
				expect(text).toContain('pages: { "hr/kiosk": "clock"; "sales": "board" | "list" };');
				expect(text).toContain('groups: { "hr": "kiosk" };');
				expect(text).toContain('skills: { "triage": true };');
				expect(text).toContain(
					'hostTools: { "browser_act": true; "browser_evaluate": true; "browser_navigate": true; "browser_screenshot": true; "browser_snapshot": true; '
				);
				expect(text).toContain('export const __verify: Check<Verify> = true;');
				const parts = [...text.matchAll(/^\t\t(\w+):/gm)].map((m) => m[1]);
				expect(parts).toEqual([...parts].sort());
			}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live(
		'type-checks the fixture against the generated index: names, content and the __verify line',
		() =>
			Effect.gen(function* () {
				const root = fixture('good');
				const tsgo = fileURLToPath(new URL('../../../node_modules/.bin/tsgo', import.meta.url));
				const run = spawnSync(tsgo, ['-p', join(root, 'tsconfig.json'), '--noEmit'], {
					encoding: 'utf8'
				});
				expect(run.stdout + run.stderr).toBe('');
				expect(run.status).toBe(0);
			}).pipe(Effect.provide(NodeServices.layer)),
		30000
	);
});
describe('next compiler: seed packs', () => {
	const m: EngineManifest = {
		workspace: { tz: 'UTC', locale: 'en' },
		models: {},
		relationships: {},
		collections: {},
		policies: {},
		integrations: {},
		connections: {},
		pipelines: {},
		automations: {},
		teams: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { skills: {} }
	};
	it.live(
		'removes the sample pack of an earlier build once the template names no bank tree; a template that names one keeps it for its next bank build',
		() =>
			Effect.gen(function* () {
				const root = yield* scratchPath(`compiler-packs-${randomUUID()}`),
					out = join(root, '.norbital/seed'),
					cache = join(root, '.norbital/cache');
				const earlier = () => {
					mkdirSync(join(out, 'sample/rows'), { recursive: true });
					writeFileSync(join(out, 'sample/pack.json'), '{}');
				};
				try {
					earlier();
					const errors: CheckDiagnostic[] = [];
					expect(Object.keys(yield* buildPacks(root, m, {}, out, { cache }, errors))).toEqual([
						'base'
					]);
					expect(errors).toEqual([]);
					expect(existsSync(join(out, 'base/pack.json'))).toBe(true);
					expect(existsSync(join(out, 'sample'))).toBe(false);
					earlier();
					expect(
						Object.keys(yield* buildPacks(root, m, {}, out, { tree: 'acme', cache }, errors))
					).toEqual(['base']);
					expect(errors).toEqual([]);
					expect(existsSync(join(out, 'sample/pack.json'))).toBe(true);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}).pipe(Effect.provide(NodeServices.layer))
	);
});
