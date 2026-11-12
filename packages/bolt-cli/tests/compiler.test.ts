import { Effect } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
/// <reference types="node" />
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { scratchPath } from '../../../scripts/lib/scratch.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect } from 'vitest';
import { it } from '@effect/vitest';
import { discover, sourcePath } from '../src/compiler/discover.ts';
import { LAYOUT_HELP } from '../../bolt/src/decl/layout.ts';
import { buildPacks, seedRows } from '../src/compiler/artifact/seed.ts';
import type { CheckDiagnostic } from '../src/compiler/check/index.ts';
import type { EngineManifest } from '../../bolt/src/engine/manifest.ts';
import { engine_manifest } from '../../bolt/src/engine/manifest.ts';
import { load, manifestErrors } from '../src/compiler/load.ts';
import { namesIndex, writeNames, writeTypeSetup } from '../src/compiler/names.ts';
import { install } from '../../bolt/src/decl/runtime/guest.ts';
install();
const fixture = (name: string) =>
	fileURLToPath(new URL(`../../bolt/tests/fixtures/${name}`, import.meta.url));
const BOLT = '../../../../src/index.ts'; // src as seen from a fixture's .norbital/
describe('next compiler: discover', () => {
	it.live('generates typed path bindings and removes a deleted declaration binding', () =>
		Effect.gen(function* () {
			const root = yield* scratchPath(`compiler-bindings-${randomUUID()}`);
			try {
				yield* writeTypeSetup(root, [
					{ role: 'model', name: 'orders', path: 'src/data/model/sales/orders/+model.ts' },
					{
						role: 'integration_definition',
						name: 'crm',
						path: 'src/integration/crm/+integration.ts'
					}
				]);
				expect(readFileSync(join(root, '.norbital/models/orders.ts'), 'utf8')).toContain(
					'bind_model("orders")'
				);
				expect(readFileSync(join(root, '.norbital/integrations/crm.ts'), 'utf8')).toContain(
					'bind_integration("crm")'
				);
				yield* writeTypeSetup(root, [
					{ role: 'model', name: 'invoices', path: 'src/data/model/invoices/+model.ts' }
				]);
				expect(existsSync(join(root, '.norbital/models/orders.ts'))).toBe(false);
				expect(existsSync(join(root, '.norbital/integrations/crm.ts'))).toBe(false);
				expect(readFileSync(join(root, '.norbital/models/invoices.ts'), 'utf8')).toContain(
					'bind_model("invoices")'
				);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeServices.layer))
	);

	it.live(
		'loads nested model folders by leaf identity, with parent models and sibling representations',
		() =>
			Effect.gen(function* () {
				const root = yield* scratchPath(`compiler-nested-models-${randomUUID()}`);
				const write = (path: string, text: string) => {
					mkdirSync(dirname(join(root, path)), { recursive: true });
					writeFileSync(join(root, path), text);
				};
				const folders = [
					'jurisdiction_settings',
					'jurisdiction_settings/leave_catalog',
					'jurisdiction_settings/leave_catalog/leave_catalog_entry',
					'payroll/payroll_run'
				];
				try {
					write('src/+workspace.ts', "export default { tz: 'UTC', locale: 'en' };");
					for (const folder of folders)
						write(
							`src/data/model/${folder}/+model.ts`,
							`export default { name: '${folder.split('/').at(-1)}', spec: {
							description: 'Nested model', record_label: 'record.name', fields: { name: { kind: 'text' } }, outputs: { default: { fields: 'all' } }
						} };`
						);
					const representation =
						'src/data/model/jurisdiction_settings/leave_catalog/leave_catalog_entry/+representation.svelte';
					write(representation, '<p>entry</p>');
					write('seed/public/catalogue/leave_catalog_entry.json', '[]');
					const { files, errors } = yield* discover(root);
					expect(errors).toEqual([]);
					expect(files.filter((file) => file.role === 'model')).toEqual(
						folders.map((folder) => ({
							role: 'model',
							name: folder.split('/').at(-1),
							path: `src/data/model/${folder}/+model.ts`
						}))
					);
					expect(sourcePath('model', 'payroll_run', files)).toBe(
						'src/data/model/payroll/payroll_run/+model.ts'
					);
					expect(sourcePath('model', 'payroll_run')).toBe('src/data/model/payroll_run/+model.ts');
					const loaded = yield* load(root, files);
					expect(loaded.errors).toEqual([]);
					expect(manifestErrors(loaded.manifest, 'workspace', files)).toEqual([]);
					expect(loaded.manifest.representation.leave_catalog_entry).toBe(representation);
					expect(Object.keys(engine_manifest(loaded.manifest).models).sort()).toEqual(
						folders.map((folder) => folder.split('/').at(-1)).sort()
					);
					const index = namesIndex(files, loaded.manifest);
					// a duplicate here is a type error in every workspace's generated names
					const tools = [...index.matchAll(/"((?:workspace|browser)_\w+)": true/g)].map(
						(m) => m[1]
					);
					expect(tools.length).toBeGreaterThan(0);
					expect(new Set(tools).size).toBe(tools.length);
					expect(index).toContain('"leave_catalog_entry": {');
					expect(index).not.toContain('"jurisdiction_settings/leave_catalog');
					write('src/automation/+payroll_run.automation.ts', 'export default {};');
					expect((yield* discover(root)).errors.map((error) => error.code)).toEqual([
						'discover/name-clash'
					]);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('preserves model layout guards across grouping folders', () =>
		Effect.gen(function* () {
			for (const { paths, codes } of [
				{
					paths: [
						'payroll/entries/+model.ts',
						'payroll/entries/+representation.svelte',
						'rules/entries/+model.ts',
						'rules/entries/+representation.svelte'
					],
					codes: ['discover/duplicate-declaration', 'discover/name-clash']
				},
				{
					paths: ['payroll/entries/+model.ts', 'rules/entries/+representation.svelte'],
					codes: ['discover/representation-without-model']
				},
				{ paths: ['payroll/sys_thing/+model.ts'], codes: ['discover/reserved-name'] },
				{ paths: ['payroll/bolt_thing/+model.ts'], codes: ['discover/reserved-name'] },
				{ paths: ['Bad/entries/+model.ts'], codes: ['discover/bad-name'] },
				{ paths: ['payroll/Entries/+model.ts'], codes: ['discover/bad-name'] }
			]) {
				const root = yield* scratchPath(`compiler-nested-guards-${randomUUID()}`);
				try {
					mkdirSync(join(root, 'src'), { recursive: true });
					writeFileSync(join(root, 'src/+workspace.ts'), 'export default {};');
					for (const path of paths) {
						const file = join(root, 'src/data/model', path);
						mkdirSync(dirname(file), { recursive: true });
						writeFileSync(file, 'export default {};');
					}
					expect((yield* discover(root)).errors.map((error) => error.code)).toEqual(codes);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('discovers model folders and policies', () =>
		Effect.gen(function* () {
			const root = yield* scratchPath(`compiler-layout-${randomUUID()}`);
			const write = (path: string) => {
				mkdirSync(dirname(join(root, path)), { recursive: true });
				writeFileSync(join(root, path), 'export default {};');
			};
			try {
				for (const path of [
					'src/+workspace.ts',
					'src/data/model/orders/+model.ts',
					'src/access_control/policy/+sales.policy.ts'
				])
					write(path);
				const found = yield* discover(root);
				expect(found.errors).toEqual([]);
				expect(found.files).toContainEqual({
					role: 'model',
					name: 'orders',
					path: 'src/data/model/orders/+model.ts'
				});
				expect(found.files).toContainEqual({
					role: 'policy',
					name: 'sales',
					path: 'src/access_control/policy/+sales.policy.ts'
				});
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
					expect(engine_manifest(loaded.manifest).workspace.secrets).toEqual({
						API_URL: { label: 'API', description: 'The base URL' },
						API_SECRET: { label: 'Secret' }
					});
					expect(namesIndex(files, loaded.manifest)).toContain('"API_URL": {');
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
	it.live('rejects retired agent tool declarations', () =>
		Effect.gen(function* () {
			const root = yield* scratchPath(`compiler-tool-${randomUUID()}`);
			try {
				mkdirSync(join(root, 'src/agent/tool/plans'), { recursive: true });
				writeFileSync(join(root, 'src/+workspace.ts'), "export default { tz: 'UTC', locale: 'en' };");
				writeFileSync(join(root, 'src/agent/tool/plans/+tool.ts'), 'export default {};');
				writeFileSync(join(root, 'src/agent/tool/plans/run.ts'), 'export default function* () {};');
				expect((yield* discover(root)).errors).toContainEqual(expect.objectContaining({
					code: 'discover/unknown-role', path: 'src/agent/tool/plans/+tool.ts'
				}));
			} finally { rmSync(root, { recursive: true, force: true }); }
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('names every role from its path', () =>
		Effect.gen(function* () {
			const { files, errors } = yield* discover(fixture('good'));
			expect(errors).toEqual([]);
			expect(files.map((f) => `${f.role} ${f.name}`).sort()).toEqual([
				'agent ',
				'app clock',
				'app hr/kiosk',
				'app sales',
				'automation nightly',
				'custom_field rating',
				'group hr',
				'integration_definition erp',
				'integration_definition mail',
				'locale ms',
				'mcp hq',
				'messages ',
				'model customers',
				'model notices',
				'model orders',
				'page clock/clock',
				'page hr/kiosk/clock',
				'page sales/board',
				'page sales/list',
				'policy kiosk_reader',
				'policy sales_rep',
				'renderer rating',
				'representation orders',
				'secrets ',
				'skill triage',
				'team ',
				'workspace '
			]);
		}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('refuses every layout mistake with a stable code and the role table as help', () =>
		Effect.gen(function* () {
			const { errors } = yield* discover(fixture('bad'));
			expect(errors.map((e) => `${e.code} ${e.path}`).sort()).toEqual(
				[
					'discover/app-and-group src/app/sales/+app.ts',
					'discover/app-and-group src/app/sales/+group.ts',
					'discover/app-nesting src/app/shop/inner/+app.ts',
					'discover/bad-name src/data/model/Bad/+model.ts',
					'discover/representation-without-model src/data/model/ghost/+representation.svelte',
					'discover/custom-field-without-definition src/data/custom_field/stars/+renderer.svelte',
					'discover/messages-missing src/i18n/+ms.messages.ts',
					'discover/name-clash src/automation/+orders.automation.ts',
					'discover/one-per-folder src/data/model/orders/+erp.integration.ts',
					'discover/page-without-app src/app/empty/+board.page.svelte',
					'discover/plural-folder src/automations/+sync.automation.ts',
					'discover/reserved-name src/data/custom_field/phone/+definition.ts',
					'discover/reserved-name src/data/model/sys_thing/+model.ts',
					'discover/reserved-name src/integration/whatsapp/+integration.ts',
					'discover/seed-layout seed/stray.json',
					'discover/seed-unknown-model seed/public/nope.json',
					'discover/unknown-role src/+layout.ts',
					'discover/unknown-role src/lib/+helper.ts',
					'discover/workspace-missing src/+workspace.ts',
					'discover/wrong-folder src/access_control/policy/+late.automation.ts',
					'discover/wrong-folder src/data/model/orders/+integration.ts'
				].sort()
			);
			expect(errors.every((e) => e.help === LAYOUT_HELP)).toBe(true);
			expect(LAYOUT_HELP).toContain('src/integration/<name>/+integration.ts');
			expect(LAYOUT_HELP).toContain('src/data/model/<name>/+model.ts');
			expect(LAYOUT_HELP).toContain('src/access_control/policy/+<name>.policy.ts');
			expect(errors.find((e) => e.code === 'discover/plural-folder')?.message).toContain(
				"'automations' is 'automation'"
			);
		}).pipe(Effect.provide(NodeServices.layer))
	);
});
describe('next compiler: load', () => {
	it.live('reports nested model name and reserved-field failures at their actual source path', () =>
		Effect.gen(function* () {
			const root = yield* scratchPath(`compiler-nested-load-${randomUUID()}`);
			const file = 'src/data/model/payroll/entries/+model.ts';
			try {
				mkdirSync(dirname(join(root, file)), { recursive: true });
				writeFileSync(join(root, 'src/+workspace.ts'), 'export default {};');
				writeFileSync(
					join(root, file),
					"export default { name: 'payroll_entries', spec: { fields: { revision: { kind: 'number' } }, table: 'entries' } };"
				);
				const { files, errors } = yield* discover(root);
				expect(errors).toEqual([]);
				const loaded = yield* load(root, files);
				expect(loaded.errors).toEqual([]);
				expect(
					manifestErrors(loaded.manifest, 'workspace', files).map(({ code, path }) => ({
						code,
						path
					}))
				).toEqual([
					{ code: 'load/name-path', path: file },
					{ code: 'load/reserved-field', path: file },
					{ code: 'load/system-only', path: file }
				]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeServices.layer))
	);
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
					"export default { root: { name: 'Shared label', parent: null, policies: ['sales'] }, branch: { name: 'Shared label', parent: 'root', policies: [] }, Root: { policies: ['sales'] } };"
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
				expect(check({ role: { policies: ['unknown'] } })).toContain('load/team-policy');
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
	it.live('splits inline model refs and syncs beside integration definitions and runtime accounts', () =>
		Effect.gen(function* () {
			const root = yield* scratchPath(`compiler-integration-load-${randomUUID()}`);
			const write = (path: string, text: string) => {
				mkdirSync(dirname(join(root, path)), { recursive: true });
				writeFileSync(join(root, path), text);
			};
			try {
				write(
					'src/+workspace.ts',
					"export default { tz: 'UTC', locale: 'en' };"
				);
				write(
					'src/data/model/entries/+model.ts',
					`export default { name: 'entries', spec: {
					description: 'Ledger entries', record_label: 'record.code', constraints: { one_code: { unique: ['source', 'code'], import_key: true } },
					fields: { code: { kind: 'text' }, source: { kind: 'ref', to: 'sys_integration', where: { integration: { eq: 'books' } } } },
					outputs: { default: { fields: 'all' } }, syncs: { ledger: { with: 'books', every: '1h', read: function* () { return { rows: [] }; } } }
				} };`
				);
				write(
					'src/integration/books/+integration.ts',
					"export default { name: 'books', spec: { description: 'Books', driver: 'sqlserver' }, bodies: {} };"
				);
				const found = yield* discover(root),
					loaded = yield* load(root, found.files);
				expect(found.errors).toEqual([]);
				expect([...loaded.errors, ...manifestErrors(loaded.manifest)]).toEqual([]);
				const manifest = engine_manifest(loaded.manifest);
				expect(manifest.integrations['books']).toEqual({
					description: 'Books',
					driver: 'sqlserver'
				});
				expect(manifest.relationships['entries.source']).toMatchObject({ to: 'sys_integration' });
				expect(manifest.exposures['entries']?.syncs?.['ledger']).toEqual({
					with: 'books',
					every: '1h',
					read: true
				});
				expect(manifest).not.toHaveProperty('connections');
				expect(manifest.workspace).not.toHaveProperty('connections');
				const names = namesIndex(found.files, loaded.manifest);
				expect(names).toContain('"syncs": {');
				expect(names).toContain('"read": true;');
				expect(names).not.toContain('typeof import');
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
				expect(errors[0]?.message).toContain('is a built-in integration');
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
			expect(manifest.model.orders).toHaveProperty(
				['spec', 'outputs', 'default', 'customer', 'fields'],
				['name', 'rating']
			);
			expect(manifest.model.orders).not.toHaveProperty('bodies.queries');
			expect(manifest.custom_field.rating).toHaveProperty('check', expect.any(Function));
			expect(manifest.integration_definition.mail).toMatchObject({
				name: 'mail',
				spec: { driver: 'email' }
			});
			expect(manifest.model.notices).toHaveProperty(
				'bodies.syncs.messages.read',
				expect.any(Function)
			);
			// a skill is its folder: `+skill.md` is its SKILL.md, beside its scripts
			expect(manifest.skill.triage).toEqual({
				text: expect.stringContaining('description: Triage a notice'),
				digest: expect.stringMatching(/^[0-9a-f]{64}$/),
				files: ['SKILL.md', 'scripts/count.js']
			});
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
				'load/failed src/integration/broken/+integration.ts',
				'load/name-path src/data/model/lines/+model.ts',
				'load/name-path src/integration/orders_source/+integration.ts',
				'load/no-default src/data/model/orders/+model.ts',
				'load/skill-description src/agent/skill/nodesc/+skill.md'
			]);
			expect(errors.find((e) => e.code === 'load/failed')?.message).toContain('boom at load');
		}).pipe(Effect.provide(NodeServices.layer))
	);
});
describe('next compiler: names index', () => {
	it.live(
		'prints each evaluated declaration as literal types, sorted, written only on change',
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
				expect(text).toContain('models: {');
				expect(text).toContain('"description": "Buyers";');
				expect(text).toContain('"orders.customer": "customers";');
				expect(text).toContain('"syncs": {');
				expect(text).not.toContain('typeof import');
				expect(text).toContain('"sales": "board" | "list";');
				expect(text).toContain('"hr": "kiosk";');
				expect(text).toContain('"triage": true;');
				expect(text).toContain('"browser_act": true;');
				expect(text).toContain('export const __verify: Check<Verify> = true;');
				const parts = [...text.matchAll(/^\t\t(\w+):/gm)].map((m) => m[1]);
				expect(parts).toEqual([...parts].sort());
			}).pipe(Effect.provide(NodeServices.layer))
	);
});
describe('next compiler: seed packs', () => {
	const m: EngineManifest = {
		needs: [],
		workspace: { tz: 'UTC', locale: 'en' },
		models: {},
		relationships: {},
		exposures: {},
		policies: {},
		integrations: {},
		automations: {},
		teams: {},

		mcp: {},
		apps: {},
		custom_fields: {},
		agent: { skills: {} }
	};
	const member = (id: string) => ({
		id,
		name: id,
		email: null,
		kind: 'staff',
		admin: false,
		team: null
	});
	const write = (root: string, files: { readonly [path: string]: string }) => {
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), text);
		}
	};
	it.live(
		'the release carries the public rows of seed/public/ as its base pack and never a bank pack',
		() =>
			Effect.gen(function* () {
				const root = yield* scratchPath(`compiler-packs-${randomUUID()}`),
					out = join(root, '.norbital/seed');
				try {
					write(root, { 'seed/public/sys_user.json': JSON.stringify([member('ada')]) });
					const errors: CheckDiagnostic[] = [];
					const packs = yield* buildPacks(root, m, out, errors);
					expect(errors).toEqual([]);
					expect(Object.keys(packs)).toEqual(['base']);
					expect(packs['base']?.rows).toEqual({ sys_user: 1 });
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live(
		'bolt seed reads the seeder’s bank tree rows into memory beside the public rows; a refused row or a missing tree is reported',
		() =>
			Effect.gen(function* () {
				const root = yield* scratchPath(`compiler-seed-${randomUUID()}`),
					bank = join(root, 'bank'),
					cache = join(root, '.norbital/cache');
				try {
					write(root, {
						'seed/public/sys_user.json': JSON.stringify([member('ada')]),
						'seed/+seeder.ts': `export default { bank: { tree: 'acme' } };`,
						'bank/acme/rows/people/sys_user.json': JSON.stringify([member('grace')])
					});
					const errors: CheckDiagnostic[] = [];
					const seeding = yield* seedRows(root, m, bank, cache, errors);
					expect(errors).toEqual([]);
					expect(seeding?.rows['sys_user']?.map((r) => r['id'])).toEqual(['ada', 'grace']);
					expect(existsSync(join(root, '.norbital/seed'))).toBe(false);
					write(root, {
						'bank/acme/rows/people/sys_user.json': JSON.stringify([
							{ ...member('x'), team: 'nobody' }
						])
					});
					expect(yield* seedRows(root, m, bank, cache, errors)).toBeUndefined();
					expect(errors.map((e) => e.code)).toEqual(['seed/decode']);
					errors.length = 0;
					expect(yield* seedRows(root, m, join(root, 'elsewhere'), cache, errors)).toBeUndefined();
					expect(errors.map((e) => e.code)).toEqual(['seed/bank']);
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			}).pipe(Effect.provide(NodeServices.layer))
	);
});
describe('next compiler: datatypes named in a seeded JSON Schema', () => {
	const period = {
		type: 'object',
		format: 'period',
		properties: {
			from: { type: 'string', format: 'date' },
			to: { type: ['string', 'null'], format: 'date' }
		},
		required: ['from', 'to']
	};
	const schemaOf = (range: object) => ({
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		properties: { range }
	});
	const packErrors = (schema: object) =>
		Effect.gen(function* () {
			const root = yield* scratchPath(`compiler-datatype-${randomUUID()}`);
			const write = (path: string, text: string) => {
				mkdirSync(dirname(join(root, path)), { recursive: true });
				writeFileSync(join(root, path), text);
			};
			try {
				write('src/+workspace.ts', "export default { tz: 'UTC', locale: 'en' };");
				write(
					'src/data/model/forms/+model.ts',
					"export default { name: 'forms', spec: { description: 'Forms', record_label: 'record.name', fields: { name: { kind: 'text' }, schema: { kind: 'json' } }, outputs: { default: { fields: 'all' } } } };"
				);
				write('seed/public/forms.json', JSON.stringify([{ id: 'f1', name: 'one', schema }]));
				const found = yield* discover(root),
					loaded = yield* load(root, found.files);
				expect([...found.errors, ...loaded.errors]).toEqual([]);
				const errors: CheckDiagnostic[] = [];
				yield* buildPacks(
					root,
					engine_manifest(loaded.manifest),
					join(root, '.norbital/seed'),
					errors
				);
				return errors.map((e) => `${e.code} ${e.message}`);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}).pipe(Effect.provide(NodeServices.layer));
	it.live('a field naming a datatype in its exact shape builds', () =>
		Effect.gen(function* () {
			expect(yield* packErrors(schemaOf(period))).toEqual([]);
		})
	);
	it.live('a format naming no datatype fails the build with its path', () =>
		Effect.gen(function* () {
			const [error, ...rest] = yield* packErrors(schemaOf({ ...period, format: 'periodd' }));
			expect(rest).toEqual([]);
			expect(error).toContain('seed/datatype');
			expect(error).toContain(
				"forms[0].schema /properties/range: format 'periodd' names no datatype"
			);
		})
	);
	it.live('a field naming a datatype in another shape fails the build with the difference', () =>
		Effect.gen(function* () {
			const [error, ...rest] = yield* packErrors(
				schemaOf({
					...period,
					properties: { from: { type: 'number' }, note: { type: 'string' } },
					required: ['from']
				})
			);
			expect(rest).toEqual([]);
			expect(error).toContain("/properties/range: 'period' does not match its shape");
			expect(error).toContain("missing 'to'");
			expect(error).toContain("extra 'note'");
			expect(error).toContain("'from' is number, not string (date)");
		})
	);
});
