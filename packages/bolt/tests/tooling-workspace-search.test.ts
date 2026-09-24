import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { searchWorkspace } from '../src/tooling/workspace-search.js';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const workspace = async (): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), 'bolt-search-'));
	roots.push(root);
	await mkdir(join(root, 'src', 'automations'), { recursive: true });
	await writeFile(
		join(root, 'src', 'automations', '+file.ts'),
		"declare const api: any;\nexport const a = api.collection.sites.create({ name: 'x' });\nexport const b = api.collection.jobs.update({ id: '1' });\n"
	);
	return root;
};

describe('workspace search', () => {
	it('finds by structure across disk and the draft, .svelte included', async () => {
		const root = await workspace();
		const overlay = {
			'src/apps/+board.svelte':
				'<script lang="ts">\n\tdeclare const api: any;\n\tconst c = api.collection.jobs.create({ title: "t" });\n</script>\n\n<button onclick={() => {}}>Go</button>\n'
		};
		const creates = searchWorkspace(
			{ root, overlay },
			{ pattern: 'api.collection.$C.create($$$)' }
		);
		expect(creates.total).toBe(2);
		expect(creates.matches.map(({ path, line, bindings }) => ({ path, line, bindings }))).toEqual([
			{ path: 'src/apps/+board.svelte', line: 3, bindings: expect.stringContaining('$C=jobs') },
			{ path: 'src/automations/+file.ts', line: 2, bindings: expect.stringContaining('$C=sites') }
		]);
		// Markup is searched by the same engine the layout rules use.
		expect(
			searchWorkspace(
				{ root, overlay },
				{ rule: { all: [{ kind: 'svelte:Attribute' }, { regex: '^onclick' }] } }
			).matches
		).toEqual([
			{ path: 'src/apps/+board.svelte', line: 6, text: '<button onclick={() => {}}>Go</button>' }
		]);
		// `paths` narrows; `limit` caps and says so.
		expect(
			searchWorkspace(
				{ root, overlay },
				{ pattern: 'api.collection.$C.$M($$$)', paths: ['src/automations'] }
			).total
		).toBe(2);
		expect(
			searchWorkspace({ root, overlay }, { pattern: 'api.collection.$C.$M($$$)', limit: 1 })
		).toMatchObject({ total: 3, truncated: true });
	});

	it('names what it cannot search', async () => {
		const root = await workspace();
		expect(() => searchWorkspace({ root }, {})).toThrow(
			'workspace_search takes a pattern or a rule.'
		);
		expect(() => searchWorkspace({ root }, { rule: { regex: 'x' } })).toThrow(
			'no dispatchable kind'
		);
	});
});
