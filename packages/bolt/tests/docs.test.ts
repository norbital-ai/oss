// The API reference: `scripts/docs.ts` writes it into `build/docs/` at the end of bolt's build, so this reads
// the corpus the last build produced (`pnpm --dir oss build` first). Every symbol a workspace imports has a summary;
// declaration functions carry their option shapes; `workspace_lang` reads the same source JSDoc through the compiler.
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { docs as cached } from '../src/docs/index.ts';
import { corpus } from '../src/engine/docs-corpus.ts';

const required = <A>(value: A | null | undefined): A => {
	if (value == null) throw new Error('A required documentation entry is missing');
	return value;
};

it.effect('validates and decodes each documentation document once', () => Effect.gen(function* () {
	const files: Record<string, unknown> = {
		'index.json': {
			namespaces: [
				{
					namespace: 'bolt',
					module: '@norbital-ai/bolt',
					summary: 'Bolt',
					symbols: 1,
					reference: true
				}
			],
			missing: [],
			guides: [],
			skills: [{ name: 'authoring', description: 'Authoring', files: ['SKILL.md'] }]
		},
		'bolt.json': {
			namespace: 'bolt',
			module: '@norbital-ai/bolt',
			summary: 'Bolt',
			symbols: [
				{
					name: 'Row',
					kind: 'type',
					signature: 'type Row = {}',
					summary: 'A row',
					source: 'row.ts:1'
				}
			]
		},
		'skill.authoring.json': {
			name: 'authoring',
			description: 'Authoring',
			files: [{ path: 'SKILL.md', text: 'Guide' }]
		}
	};
	const reads: string[] = [];
	const local = yield* corpus((file) =>
		Effect.sync(() => {
			reads.push(file);
			return files[file];
		})
	);
	expect(local.index()).toBe(local.index());
	expect(local.namespace('bolt')).toBe(local.namespace('bolt'));
	expect(local.skill('authoring')).toBe(local.skill('authoring'));
	expect(local.search('row')[0]).toMatchObject({ name: 'Row', kind: 'type' });
	expect(local.namespace('missing')).toBeNull();
	expect(local.skill('missing')).toBeNull();
	expect(reads).toEqual(['index.json', 'bolt.json', 'skill.authoring.json']);
}));

it.effect('rejects malformed documents and mismatched document identities', () => Effect.gen(function* () {
	const index = {
		namespaces: [
			{
				namespace: 'bolt',
				module: '@norbital-ai/bolt',
				summary: 'Bolt',
				symbols: 0,
				reference: true
			}
		],
		missing: [],
		guides: [],
		skills: [{ name: 'authoring', description: 'Authoring', files: [] }]
	};
	yield* Effect.flip(corpus(() => Effect.succeed({ ...index, namespaces: 'bad' })));
	for (const document of [
		{ namespace: 'other', module: 'other', summary: '', symbols: [] },
		{ namespace: 'bolt', module: 'bolt', summary: '', symbols: [{ name: 7 }] }
	]) {
		yield* Effect.flip(corpus((file) => Effect.succeed(file === 'index.json' ? index : document)));
	}
	const skilled = { ...index, namespaces: [] };
	yield* Effect.flip(
		corpus((file) =>
			Effect.succeed(file === 'index.json' ? skilled : { name: 'other', description: '', files: [] })
		)
	);
}));

it.effect('one namespace per public entry, with its module and the entry summary', () => Effect.gen(function* () {
	const docs = yield* cached;
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
}));

it.effect('the declaration functions are documented, and spec parameters list their fields', () => Effect.gen(function* () {
	const docs = yield* cached;
	const fns = required(docs.namespace('bolt'))
		.symbols.filter((s) => s.kind === 'function')
		.map((s) => s.name);
	expect(fns).toEqual([
		'app',
		'automation',
		'browser_start',
		'custom_field',
		'group',
		'id_of',
		'instance_id',
		'is_instance',
		'mcp',
		'messages',
		'policy',
		'secrets',
		'seeder',
		'team',
		'workspace'
	]);
	const model = required(docs.symbol('bolt/declarations', 'ModelLiteral'));
	expect(model.signature).toContain('type ModelLiteral');
	expect(model.source).toMatch(/^packages\/bolt\/src\/decl\/model\.ts:\d+$/);
	expect(model.members?.map((f) => f.name)).toContain('fields');
}));

it.effect('keeps implementation guidance and parameter documentation on the core public contracts', () => Effect.gen(function* () {
	const docs = yield* cached;
	// `model()` and `integration()` are generated bindings: their literals and role cards carry the guidance
	for (const [name, role] of [['ModelLiteral', 'model'], ['IntegrationLiteral', 'integration']] as const) {
		expect(docs.symbol('bolt/declarations', name)?.summary, name).not.toBe('');
		expect(docs.skill('bolt-contract')?.files.find((file) => file.path === `${role}.md`)?.text, name).toContain(
			`## ${name}`
		);
	}
	expect(docs.skill('bolt-contract')?.files.find((file) => file.path === 'model.md')?.text).toContain(
		'export default model('
	);
	for (const name of ['workspace', 'automation', 'secrets']) {
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
	expect(query?.examples?.[0]).toContain('ctx.query');
}));

it.effect('svelte components list their props with the props docs', () => Effect.gen(function* () {
	const docs = yield* cached;
	const stack = required(docs.symbol('ui/layout', 'Stack'));
	expect(stack.kind).toBe('component');
	expect(stack.props?.map((p) => p.name)).toContain('gap');
	expect(docs.symbol('ui', 'Table')?.kind).toBe('component');
}));

it.effect('search ranks an exact name first and narrows by namespace', () => Effect.gen(function* () {
	const docs = yield* cached;
	expect(docs.search('ModelLiteral')[0]).toMatchObject({
		namespace: 'bolt/declarations',
		name: 'ModelLiteral',
		kind: 'type'
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
	expect(docs.search('enum field kind values options')[0]).toMatchObject({ namespace: 'std/kind', name: 'Kind' });
}));

it.effect('documents native Effect service implementations needed by test layers', () => Effect.gen(function* () {
	const docs = yield* cached;
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
}));

it.effect('ships every maintained mechanism guide with source and complete text', () => Effect.gen(function* () {
	const docs = yield* cached;
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
}));

it.effect('bolt-contract holds a generated card per role, naming what a role is written with', () => Effect.gen(function* () {
	const docs = yield* cached;
	const contract = docs.skill('bolt-contract');
	expect(contract?.files.map((file) => file.path)).toEqual([
		'SKILL.md',
		'model.md',
		'access.md',
		'automation.md',
		'sync.md',
		'integration.md',
		'page.md',
		'test.md'
	]);
	const card = (path: string) => contract?.files.find((file) => file.path === path)?.text ?? '';
	expect(card('model.md')).toContain("kind: 'money'");
	expect(card('automation.md')).toContain('- policies: NonEmpty<string>');
	expect(card('page.md').length).toBeLessThan(25_000);
}));

it.effect('documents the optional snapshot host bridge from its public source type and page-role card', () => Effect.gen(function* () {
	const docs = yield* cached;
	const bridge = required(docs.symbol('bolt/page', 'PageSnapshotHost'));
	expect(bridge.kind).toBe('interface');
	expect(bridge.source).toMatch(/^packages\/bolt\/src\/page\/bolt\.ts:\d+$/);
	expect(bridge.signature).toContain('readonly bolt_refresh?');
	expect(bridge.members?.find((member) => member.name === 'bolt_live_mode')).toMatchObject({
		optional: true, type: expect.stringContaining('snapshot')
	});
	expect(bridge.members?.find((member) => member.name === 'bolt_refresh')).toMatchObject({
		optional: true, type: expect.stringContaining('Promise<void>'),
		summary: expect.stringContaining('read-only')
	});
	const card = docs.skill('bolt-contract')?.files.find((file) => file.path === 'page.md')?.text;
	expect(card).toContain('## PageSnapshotHost');
	expect(card).toContain('- bolt_refresh?: () => Promise<void>');
	expect(docs.guide('client-bundling')?.text).toContain('window.bolt_refresh()');
}));
