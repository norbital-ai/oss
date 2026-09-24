import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTypeIndex } from '../src/compiler/type-index.js';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A workspace whose `$types` are written by hand, so the checker's reading is the only variable. */
const workspace = async (types: string): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), 'bolt-type-index-'));
	roots.push(root);
	await mkdir(join(root, 'src', 'collections', 'jobs'), { recursive: true });
	await writeFile(
		join(root, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				module: 'ESNext',
				moduleResolution: 'Bundler',
				noEmit: true
			},
			include: ['src']
		})
	);
	await writeFile(join(root, 'src', 'collections', 'jobs', '$types.ts'), types);
	return root;
};

describe('type index', () => {
	it('expands each surface to the checker text an agent reads', { timeout: 60_000 }, async () => {
		const root = await workspace(
			[
				'export type Money = { readonly value: number; readonly currency: string };',
				'export type Row = { readonly id: string; readonly amount_charged: Money | null };',
				'export type CreateInput = { readonly amount_charged?: Money | null; readonly urgent?: boolean };',
				'export type UpdateInput = never;'
			].join('\n')
		);
		const index = buildTypeIndex(root, [{ name: 'jobs', create: true, update: false }]);
		expect(index?.anyPaths).toEqual([]);
		expect(index?.collections['jobs']?.fields['amount_charged']).toBe(
			'{ value: number; currency: string } | null'
		);
		expect(index?.collections['jobs']?.createFields?.['amount_charged']).toBe(
			'?{ value: number; currency: string } | null'
		);
		expect(index?.collections['jobs']?.createFields?.['urgent']).toBe('?boolean');
		expect(index?.collections['jobs']?.update).toBeUndefined();
	});

	it('names every surface position that resolved to any', { timeout: 60_000 }, async () => {
		// The shape an unexported import or a missing dependency module leaves behind.
		const root = await workspace(
			[
				"import type { Missing } from './nowhere.js';",
				'export type Row = { readonly id: string; readonly facts: Missing };',
				'export type CreateInput = { readonly lines: ReadonlyArray<{ readonly amount: any }> };',
				'export type UpdateInput = never;'
			].join('\n')
		);
		const index = buildTypeIndex(root, [{ name: 'jobs', create: true, update: false }]);
		expect(index?.anyPaths).toEqual(['jobs.CreateInput.lines[].amount', 'jobs.Row.facts']);
	});

	it('builds no index for a workspace with no tsconfig', async () => {
		const root = await mkdtemp(join(tmpdir(), 'bolt-type-index-'));
		roots.push(root);
		expect(buildTypeIndex(root, [{ name: 'jobs', create: true, update: true }])).toBeUndefined();
	});
});
