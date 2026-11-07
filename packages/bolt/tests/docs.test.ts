// The API reference (§7.3): `scripts/docs.ts` writes it into `build/docs/` at the end of bolt's build, so this reads
// the corpus the last build produced (`pnpm --dir oss build` first). Every symbol a workspace imports has a summary;
// declaration functions carry their option shapes; `workspace_lang` reads the same source JSDoc through the compiler.
import { expect, it } from '@effect/vitest';
import { docs } from '../src/docs/index.ts';

it('one namespace per public entry, with its module and the entry summary', () => {
	const names = docs.index().namespaces.map((n) => n.namespace);
	expect(names).toEqual(
		expect.arrayContaining([
			'bolt',
			'bolt/page',
			'bolt-cli/test',
			'ui',
			'ui/layout',
			'std/date',
			'std/zone',
			'std/label'
		])
	);
	expect(names).toEqual([...names].sort());
	expect(docs.index().namespaces.find((n) => n.namespace === 'bolt/page')?.module).toBe(
		'@norbital-ai/bolt/page'
	);
	for (const n of docs.index().namespaces.filter((x) => x.reference))
		expect(n.summary, n.namespace).not.toBe('');
});

it('the declaration functions are documented, and spec parameters list their fields', () => {
	const fns = docs
		.namespace('bolt')!
		.symbols.filter((s) => s.kind === 'function')
		.map((s) => s.name);
	expect(fns).toEqual([
		'app',
		'automation',
		'browserStart',
		'customField',
		'envoy',
		'group',
		'idOf',
		'instanceId',
		'integration',
		'isInstance',
		'jsonDiff',
		'kiosk',
		'mcp',
		'messages',
		'model',
		'pageServer',
		'policy',
		'secrets',
		'seeder',
		'team',
		'tool',
		'workspace'
	]);
	const model = docs.symbol('bolt', 'model')!;
	expect(model.signature).toContain('function model');
	expect(model.source).toMatch(/^packages\/bolt\/src\/decl\/model\.ts:\d+$/);
	expect(model.params?.[1]?.fields?.map((f) => f.name)).toContain('fields');
	expect(docs.symbol('bolt', 'pageServer')?.params?.[0]?.fields?.map((f) => f.name)).toEqual([
		'data',
		'load'
	]);
});

it('keeps implementation guidance and parameter documentation on the core public contracts', () => {
	for (const name of ['model', 'workspace', 'automation', 'secrets']) {
		const contract = docs.symbol('bolt', name);
		expect(
			contract?.params?.every((param) => Boolean(param.summary)),
			name
		).toBe(true);
		expect(contract?.examples?.length, name).toBeGreaterThan(0);
		expect(contract?.docs, name).toContain('@returns');
	}
	expect(docs.symbol('bolt', 'ActInput')?.summary).toContain('write exposure');
	expect(docs.symbol('bolt', 'ActOutput')?.summary).toContain('records');
	expect(docs.symbol('bolt', 'Row')?.summary).toContain('runtime');
	expect(docs.symbol('bolt', 'InputOf')?.examples?.[0]).toContain('optional: true');
	const query = docs
		.symbol('bolt/page', 'PageBolt')
		?.members?.find((member) => member.name === 'query');
	expect(query?.docs).toContain('@returns');
	expect(query?.examples?.[0]).toContain('bolt.query');
});

it('svelte components list their props with the props docs', () => {
	const stack = docs.symbol('ui/layout', 'Stack')!;
	expect(stack.kind).toBe('component');
	expect(stack.props?.map((p) => p.name)).toContain('gap');
	expect(docs.symbol('ui', 'Table')?.kind).toBe('component');
});

it('search ranks an exact name first and narrows by namespace', () => {
	expect(docs.search('model')[0]).toMatchObject({
		namespace: 'bolt',
		name: 'model',
		kind: 'function'
	});
	expect(
		docs.search('add days', { namespaces: ['std/'] }).every((h) => h.namespace.startsWith('std/'))
	).toBe(true);
	expect(docs.search('zzzz-no-such-word')).toEqual([]);
	// a sentence finds what its words name, never nothing when one of them matches
	const sentence = docs.search('app page table view records edit form');
	expect(sentence.length).toBeGreaterThan(0);
	const names = sentence.map((h) => h.name);
	expect(names).toContain('app');
	expect(names.some((n) => n.startsWith('Table'))).toBe(true);
	expect(names).not.toContain('ApprovalPanel'); // "app" matches where a word starts, not inside "approval"
	expect(docs.search('enum field kind values options')[0]?.name).toBe('FieldKind');
});

it('documents native Effect service implementations needed by test layers', () => {
	const convert = docs.symbol('bolt/engine', 'Convert');
	expect(convert?.members?.map((member) => member.name)).toEqual(
		expect.arrayContaining(['targets', 'convert', 'ingest'])
	);
	expect(convert?.members?.find((member) => member.name === 'ingest')).toMatchObject({
		optional: true,
		type: expect.stringContaining('Effect')
	});
	expect(docs.symbol('bolt/engine', 'Files')?.members?.map((member) => member.name)).toEqual(
		expect.arrayContaining(['put', 'get', 'url', 'remove', 'download'])
	);
	expect(docs.symbol('bolt/engine', 'Sql')?.signature).toContain('readonly params');
});

it('ships every maintained mechanism guide with source and complete text', () => {
	const guides = docs.index().guides;
	expect(guides.map((guide) => guide.slug)).toEqual(
		expect.arrayContaining([
			'overview',
			'mechanisms',
			'models',
			'apis',
			'documents',
			'hosts',
			'seeding'
		])
	);
	expect(docs.guide('mechanisms')?.text).toContain('reserved system identity');
	expect(docs.guide('models')?.source).toBe('packages/bolt/docs/models.md');
	expect(docs.guide('not-a-guide')).toBeNull();
});

it('bolt-contract holds a generated card per role, naming what a role is written with', () => {
	const contract = docs.skill('bolt-contract');
	expect(contract?.files.map((file) => file.path)).toEqual([
		'SKILL.md',
		'model.md',
		'access.md',
		'automation.md',
		'sync.md',
		'tool.md',
		'page.md',
		'test.md'
	]);
	const card = (path: string) => contract?.files.find((file) => file.path === path)?.text ?? '';
	expect(card('model.md')).toContain("kind: 'money'");
	expect(card('automation.md')).toContain('- policies: NonEmpty<string>');
	expect(card('page.md').length).toBeLessThan(25_000);
});
