/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discover, LAYOUT_HELP } from '../src/compiler/discover.ts';
import { load } from '../src/compiler/load.ts';
import { namesIndex, writeNames } from '../src/compiler/names.ts';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const BOLT = '../../../../src/index.ts'; // src as seen from a fixture's .norbital/

describe('next compiler: discover', () => {
	it('names every role from its path', () => {
		const { files, errors } = discover(fixture('good'));
		expect(errors).toEqual([]);
		expect(files.map((f) => `${f.role} ${f.name}`).sort()).toEqual([
			'agent ', 'app hr/kiosk', 'app sales', 'automation nightly', 'channel mail', 'collection customers', 'collection notices',
			'collection orders', 'connection erp', 'custom_field rating', 'group hr', 'integration notices', 'locale ms',
			'mcp hq', 'messages ', 'model customers', 'model notices', 'model orders', 'page hr/kiosk/clock', 'page sales/board',
			'page sales/list', 'policy sales_rep', 'relationship ', 'renderer rating', 'representation orders', 'skill triage',
			'team ', 'workspace '
		]);
	});

	it('refuses every layout mistake with a stable code and the role table as help', () => {
		const { errors } = discover(fixture('bad'));
		expect(errors.map((e) => `${e.code} ${e.path}`).sort()).toEqual([
			'discover/app-and-group src/app/sales/+app.ts',
			'discover/app-and-group src/app/sales/+group.ts',
			'discover/app-nesting src/app/shop/inner/+app.ts',
			'discover/bad-name src/data/model/Bad/+model.ts',
			'discover/collection-without-model src/data/collection/ghost/+collection.ts',
			'discover/custom-field-without-definition src/data/custom_field/stars/+renderer.svelte',
			'discover/messages-missing src/i18n/+ms.messages.ts',
			'discover/name-clash src/automation/+orders.automation.ts',
			'discover/one-per-folder src/channel/+inbox.channel.ts',
			'discover/one-per-folder src/data/collection/orders/+erp.integration.ts',
			'discover/page-without-app src/app/empty/+board.page.svelte',
			'discover/plural-folder src/automations/+sync.automation.ts',
			'discover/reserved-name src/data/custom_field/phone/+definition.ts',
			'discover/reserved-name src/data/model/sys_thing/+model.ts',
			'discover/seed-unknown-collection seed/nope.json',
			'discover/unknown-role src/+layout.ts',
			'discover/unknown-role src/lib/+helper.ts',
			'discover/without-collection src/data/collection/lonely/+pipeline.ts',
			'discover/workspace-missing src/+workspace.ts',
			'discover/wrong-folder src/access/+late.automation.ts'
		]);
		expect(errors.every((e) => e.help === LAYOUT_HELP)).toBe(true);
		expect(LAYOUT_HELP).toContain('src/data/collection/<name>/+integration.ts');
		expect(LAYOUT_HELP).toContain('src/access/+<name>.policy.ts');
		expect(errors.find((e) => e.code === 'discover/plural-folder')?.message).toContain("'automations' is 'automation'");
	});
});

describe('next compiler: load', () => {
	it('imports each default export into the manifest', async () => {
		const root = fixture('good');
		const { manifest, errors } = await load(root, discover(root).files);
		expect(errors).toEqual([]);
		expect(Object.keys(manifest.model).sort()).toEqual(['customers', 'notices', 'orders']);
		expect((manifest.collection.orders as { bodies: { queries: object } }).bodies.queries).toHaveProperty('count_placed');
		expect((manifest.custom_field.rating as { check?: unknown }).check).toBeTypeOf('function');
		expect(manifest.integration.notices).toMatchObject({ name: 'notices', spec: { direction: 'one_way' } });
		expect(manifest.skill.triage).toContain('description: Triage a notice');
		expect(manifest.page['sales/board']).toBe('src/app/sales/+board.page.svelte');
	});

	it('refuses declarations that do not load or do not match their path', async () => {
		const root = fixture('load-bad');
		const found = discover(root);
		expect(found.errors).toEqual([]);
		const { errors } = await load(root, found.files);
		expect(errors.map((e) => `${e.code} ${e.path}`).sort()).toEqual([
			'app/page-unlisted src/app/sales/+stray.page.svelte',
			'load/collection-name src/data/collection/orders/+collection.ts',
			'load/failed src/connection/+broken.connection.ts',
			'load/integration-direction src/data/collection/orders/+integration.ts',
			'load/no-default src/data/model/orders/+model.ts',
			'load/skill-description src/agent/skill/+nodesc.skill.md'
		]);
		expect(errors.find((e) => e.code === 'load/failed')?.message).toContain('boom at load');
	});
});

describe('next compiler: names index', () => {
	it('maps every path-derived name to its default export, sorted, written only on change', async () => {
		const root = fixture('good');
		const { files } = discover(root);
		const { manifest } = await load(root, files);
		const text = namesIndex(files, manifest, BOLT);
		rmSync(join(root, '.norbital'), { recursive: true, force: true });
		expect(writeNames(root, text)).toBe(true);
		expect(writeNames(root, text)).toBe(false);
		expect(readFileSync(join(root, '.norbital/names.ts'), 'utf8')).toBe(text);
		expect(text).toContain(`models: { "customers": typeof import("../src/data/model/customers/+model.ts").default; "notices": `);
		expect(text).toContain('integrations: { "notices": "one_way" };');
		expect(text).toContain('pages: { "hr/kiosk": "clock"; "sales": "board" | "list" };');
		expect(text).toContain('groups: { "hr": "kiosk" };');
		expect(text).toContain('skills: { "triage": true };');
		expect(text).toContain('hostTools: { "browser_act": true; "browser_evaluate": true; "browser_navigate": true; "browser_screenshot": true; "browser_snapshot": true; ');
		expect(text).toContain('export const __verify: Check<Verify> = true;');
		const parts = [...text.matchAll(/^\t\t(\w+):/gm)].map((m) => m[1]);
		expect(parts).toEqual([...parts].sort());
	});

	it('type-checks the fixture against the generated index: names, content and the __verify line', () => {
		const root = fixture('good');
		const tsgo = fileURLToPath(new URL('../../../node_modules/.bin/tsgo', import.meta.url));
		const run = spawnSync(tsgo, ['-p', join(root, 'tsconfig.json'), '--noEmit'], { encoding: 'utf8' });
		expect(run.stdout + run.stderr).toBe('');
		expect(run.status).toBe(0);
	}, 30_000);
});
