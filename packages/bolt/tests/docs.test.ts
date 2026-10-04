// The API reference (§7.3): `src/cli/docs.ts` writes it into `build/docs/` at the end of bolt's build, so this reads
// the corpus the last build produced (`pnpm --dir oss build` first). Every symbol a workspace imports has a summary;
// declaration functions carry their option shapes; the agent's `docs` tool reads the same corpus.
import { expect, it } from 'vitest';
import { docs } from '../src/docs/index.ts';
import { catalogue, type ToolContext } from '../src/engine/agent/tools.ts';

it('the reference namespaces are §7.3\'s, and every symbol they export has a summary', () => {
	const reference = docs.index().namespaces.filter((n) => n.reference).map((n) => n.namespace);
	expect(reference.filter((n) => !n.startsWith('std/'))).toEqual(['bolt', 'bolt/client', 'bolt/test', 'ui', 'ui/capture', 'ui/layout']);
	expect(reference.filter((n) => n.startsWith('std/')).length).toBeGreaterThan(10);
	expect(docs.index().missing).toEqual([]);
});

it('one namespace per public entry, with its module and the entry summary', () => {
	const names = docs.index().namespaces.map((n) => n.namespace);
	expect(names).toEqual(expect.arrayContaining(['bolt', 'bolt/client', 'bolt/test', 'ui', 'ui/layout', 'std/date', 'std/zone', 'std/label']));
	expect(names).toEqual([...names].sort());
	expect(docs.index().namespaces.find((n) => n.namespace === 'bolt/client')?.module).toBe('@norbital-ai/bolt/client');
	for (const n of docs.index().namespaces.filter((x) => x.reference)) expect(n.summary, n.namespace).not.toBe('');
});

it('the 16 declaration functions are functions whose spec parameter lists its fields', () => {
	const fns = docs.namespace('bolt')!.symbols.filter((s) => s.kind === 'function').map((s) => s.name);
	expect(fns).toEqual(['app', 'automation', 'channel', 'collection', 'connection', 'customField', 'group', 'integration', 'mcp', 'messages',
		'model', 'pipeline', 'policy', 'relationship', 'team', 'workspace']);
	const model = docs.symbol('bolt', 'model')!;
	expect(model.signature).toContain('function model');
	expect(model.source).toMatch(/^packages\/bolt\/src\/decl\/model\.ts:\d+$/);
	expect(model.params?.[0]?.fields?.map((f) => f.name)).toContain('fields');
});

it('svelte components list their props with the props docs', () => {
	const stack = docs.symbol('ui/layout', 'Stack')!;
	expect(stack.kind).toBe('component');
	expect(stack.props?.map((p) => p.name)).toContain('gap');
	expect(docs.symbol('ui', 'Table')?.kind).toBe('component');
});

it('search ranks an exact name first and narrows by namespace', () => {
	expect(docs.search('collection')[0]).toMatchObject({ namespace: 'bolt', name: 'collection', kind: 'function' });
	expect(docs.search('add days', { namespaces: ['std/'] }).every((h) => h.namespace.startsWith('std/'))).toBe(true);
	expect(docs.search('zzzz-no-such-word')).toEqual([]);
});

// the smallest context `catalogue` reads for a staff member's in-app turn
const staff = (external: boolean) => ({
	engine: { manifest: { collections: {}, models: {}, relationships: {}, policies: {}, workspace: { tz: 'UTC' }, agent: { skills: {} } } },
	authority: { actor: { kind: 'member', id: 'ann', external, teamPath: [] }, admin: false, policies: [], collections: {}, automations: [],
		capabilities: { apps: [], tools: [], mcp: [], skills: [] } },
	conv: { channel: null, plan: null, goals: [] }, mode: 'agent', inApp: true, delegation: false, skills: {}, mcpTools: [], hostTools: []
}) as unknown as ToolContext;
const docsTool = (external = false) => catalogue(staff(external)).find((t) => t.name === 'docs');

it('the agent reads the reference through docs: namespaces, a search, one symbol; host namespaces are not offered', async () => {
	const tool = docsTool()!;
	const list = (await tool.run({}, 'c1')) as { result: { namespace: string }[] };
	expect(list.result.map((n) => n.namespace)).toEqual(expect.arrayContaining(['bolt', 'ui', 'std/date']));
	expect(list.result.map((n) => n.namespace)).not.toContain('bolt/engine');
	const hit = (await tool.run({ symbol: 'collection', namespace: 'bolt' }, 'c2')) as { result: { import: string; name: string }[] };
	expect(hit.result[0]).toMatchObject({ import: '@norbital-ai/bolt', name: 'collection' });
	expect(((await tool.run({ namespace: 'bolt/engine' }, 'c3')) as { result: { error?: string } }).result.error).toMatch(/No namespace/);
	expect(((await tool.run({ query: 'stack' }, 'c4')) as { result: { name: string }[] }).result.map((h) => h.name)).toContain('Stack');
});

it('an external member gets no docs tool', () => {
	expect(docsTool(true)).toBeUndefined();
});
