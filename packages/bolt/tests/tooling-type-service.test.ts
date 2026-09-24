import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('workspace type service', () => {
	it('hovers a symbol and follows it to its declaration', { timeout: 60_000 }, async () => {
		const root = await workspace();
		const service = createWorkspaceTypeService();
		expect(
			service.hover({ key: 'w', root }, { path: 'src/job.ts', line: 2, column: 14 })?.text
		).toBe('const charge: Money');
		const hover = service.hover({ key: 'w', root }, { path: 'src/job.ts', line: 2, column: 22 });
		// The editor's own quick info: an imported alias, expanded.
		expect(hover?.text).toContain('type Money = {\n    readonly value: number;\n    readonly currency: string;\n}');
		expect(hover?.documentation).toBe('A charge with its currency.');
		expect(hover?.definition).toEqual({ path: 'src/money.ts', line: 2 });
		service.dispose();
	});

	it('checks a draft without writing it, and re-checks after the draft changes', { timeout: 60_000 }, async () => {
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
	});

	it('drops the least recently used workspace past its budget, and an idle one on the next call', { timeout: 60_000 }, async () => {
		const [first, second] = [await workspace(), await workspace()];
		let clock = 0;
		const service = createWorkspaceTypeService({ budgetBytes: 1, idleMillis: 1_000, now: () => clock });
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
	});
});
