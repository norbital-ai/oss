import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceTypeService } from '../src/tooling/type-service.js';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const workspace = async (): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), 'bolt-type-service-'));
	roots.push(root);
	await mkdir(join(root, 'src'), { recursive: true });
	await writeFile(
		join(root, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				module: 'ESNext',
				moduleResolution: 'Bundler',
				noEmit: true,
				// A tenant tsconfig plugin is code the host would execute; it is never loaded.
				plugins: [{ name: 'definitely-not-installed' }]
			},
			include: ['src']
		})
	);
	await writeFile(
		join(root, 'src', 'money.ts'),
		'/** A charge with its currency. */\nexport type Money = { readonly value: number; readonly currency: string };\n'
	);
	await writeFile(
		join(root, 'src', 'job.ts'),
		"import type { Money } from './money.js';\nexport const charge: Money = { value: 40, currency: 'SGD' };\n"
	);
	return root;
};

/** Two components, one using the other, with the workspace's own `svelte` for the shims. */
const components = async (root: string): Promise<void> => {
	await mkdir(join(root, 'node_modules'), { recursive: true });
	await symlink(
		join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'svelte'),
		join(root, 'node_modules', 'svelte')
	);
	await writeFile(
		join(root, 'src', 'badge.svelte'),
		[
			'<script lang="ts">',
			'\t/** How loud the badge is. */',
			"\ttype Tone = 'info' | 'warn';",
			'\tlet { tone, label }: { tone: Tone; label: string } = $props();',
			'\tconst upper = label.toUpperCase();',
			'</script>',
			'',
			'<span data-tone={tone}>{upper}</span>',
			''
		].join('\n')
	);
	await writeFile(
		join(root, 'src', 'page.svelte'),
		[
			'<script lang="ts">',
			"\timport Badge from './badge.svelte';",
			"\timport { charge } from './job.js';",
			'</script>',
			'',
			'<Badge tone="info" label={charge.currency} />',
			''
		].join('\n')
	);
};

describe('workspace type service', () => {
	it('hovers a symbol and follows it to its declaration', { timeout: 60_000 }, async () => {
		const root = await workspace();
		const service = createWorkspaceTypeService();
		expect(
			service.hover({ key: 'w', root }, { path: 'src/job.ts', line: 2, column: 14 })?.text
		).toBe('const charge: Money');
		const hover = service.hover({ key: 'w', root }, { path: 'src/job.ts', line: 2, column: 22 });
		// The editor's own quick info: an imported alias, expanded.
		expect(hover?.text).toContain(
			'type Money = {\n    readonly value: number;\n    readonly currency: string;\n}'
		);
		expect(hover?.documentation).toBe('A charge with its currency.');
		expect(hover?.definition).toEqual({ path: 'src/money.ts', line: 2 });
		// A position past a line's end or past the file is answered, not a compiler assertion.
		expect(
			service.hover({ key: 'w', root }, { path: 'src/job.ts', line: 1, column: 500 })
		).toBeUndefined();
		expect(
			service.hover({ key: 'w', root }, { path: 'src/job.ts', line: 90, column: 1 })
		).toBeUndefined();
		service.dispose();
	});

	it(
		'checks a draft without writing it, and re-checks after the draft changes',
		{ timeout: 60_000 },
		async () => {
			const root = await workspace();
			const service = createWorkspaceTypeService();
			expect(service.check({ key: 'w', root }, ['src/job.ts'])).toEqual([]);
			const broken = {
				key: 'w',
				root,
				overlay: {
					'src/job.ts':
						"import type { Money } from './money.js';\nexport const charge: Money = { value: '40', currency: 'SGD' };\n"
				}
			};
			const [problem] = service.check(broken, ['src/job.ts']);
			expect(problem).toMatchObject({ path: 'src/job.ts', line: 2, code: 2322 });
			expect(problem?.message).toContain("Type 'string' is not assignable to type 'number'");
			// The same key reuses the warm service; the draft reverting is seen on the next call.
			expect(service.check({ key: 'w', root }, ['src/job.ts'])).toEqual([]);
			expect(service.stats().workspaces).toBe(1);
			service.dispose();
		}
	);

	it(
		'drops the least recently used workspace past its budget, and an idle one on the next call',
		{ timeout: 60_000 },
		async () => {
			const [first, second] = [await workspace(), await workspace()];
			let clock = 0;
			const service = createWorkspaceTypeService({
				budgetBytes: 1,
				idleMillis: 1_000,
				now: () => clock
			});
			service.check({ key: 'a', root: first }, ['src/job.ts']);
			clock = 10;
			service.check({ key: 'b', root: second }, ['src/job.ts']);
			// One byte of budget holds only the workspace in use.
			expect(service.stats()).toMatchObject({ workspaces: 1, evictions: 1 });

			const roomy = createWorkspaceTypeService({ idleMillis: 1_000, now: () => clock });
			roomy.check({ key: 'a', root: first }, ['src/job.ts']);
			clock = 5_000;
			roomy.check({ key: 'b', root: second }, ['src/job.ts']);
			expect(roomy.stats()).toMatchObject({ workspaces: 1, evictions: 1 });
			service.dispose();
			roomy.dispose();
		}
	);
	it('sees a draft that changes within the same millisecond', { timeout: 60_000 }, async () => {
		const root = await workspace();
		const service = createWorkspaceTypeService({ now: () => 0 });
		expect(service.check({ key: 'w', root }, ['src/job.ts'])).toEqual([]);
		const broken = {
			key: 'w',
			root,
			overlay: { 'src/job.ts': 'export const charge: number = "40";\n' }
		};
		expect(service.check(broken, ['src/job.ts'])).toMatchObject([{ code: 2322 }]);
		service.dispose();
	});

	it('names a path the workspace program does not contain', { timeout: 60_000 }, async () => {
		const root = await workspace();
		const service = createWorkspaceTypeService();
		expect(() => service.check({ key: 'w', root }, ['src/nowhere.ts'])).toThrow(
			'src/nowhere.ts is not a file of this workspace'
		);
		expect(() =>
			service.hover({ key: 'w', root }, { path: 'src/nowhere.ts', line: 1, column: 1 })
		).toThrow('src/nowhere.ts is not a file of this workspace');
		service.dispose();
	});

	it('hovers inside a component and its props where it is used', { timeout: 60_000 }, async () => {
		const root = await workspace();
		await components(root);
		const service = createWorkspaceTypeService();
		const key = { key: 'w', root };
		// `upper` in the component's own script.
		expect(service.hover(key, { path: 'src/badge.svelte', line: 5, column: 9 })?.text).toBe(
			'const upper: string'
		);
		// The same symbol in the markup, mapped back to its declaration line in the .svelte source.
		expect(service.hover(key, { path: 'src/badge.svelte', line: 8, column: 26 })).toMatchObject({
			text: 'const upper: string',
			definition: { path: 'src/badge.svelte', line: 5 }
		});
		// A prop at the call site resolves to the component's declared prop type.
		expect(service.hover(key, { path: 'src/page.svelte', line: 6, column: 9 })?.text).toContain(
			'tone: Tone'
		);
		// A .ts export read from a component.
		expect(service.hover(key, { path: 'src/page.svelte', line: 6, column: 27 })?.text).toBe(
			'(alias) const charge: Money\nimport charge'
		);
		expect(service.check(key, ['src/badge.svelte', 'src/page.svelte'])).toEqual([]);
		service.dispose();
	});

	it('checks a component draft at the line of its source', { timeout: 60_000 }, async () => {
		const root = await workspace();
		await components(root);
		const service = createWorkspaceTypeService();
		const [problem, ...rest] = service.check(
			{
				key: 'w',
				root,
				overlay: {
					'src/page.svelte': [
						'<script lang="ts">',
						"\timport Badge from './badge.svelte';",
						'</script>',
						'',
						'<Badge tone="loud" label="Open" />',
						''
					].join('\n')
				}
			},
			['src/page.svelte']
		);
		expect(rest).toEqual([]);
		expect(problem).toMatchObject({ path: 'src/page.svelte', line: 5, code: 2322 });
		expect(problem?.message).toContain('"loud"');
		service.dispose();
	});
});
