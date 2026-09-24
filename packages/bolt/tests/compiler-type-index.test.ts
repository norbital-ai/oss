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
	it(
		'carries the authored comments, and the line each is written at',
		{ timeout: 60_000 },
		async () => {
			const root = await workspace(
				[
					'export type Row = { readonly id: string; readonly status: string | null };',
					'export type CreateInput = { readonly status?: string | null };',
					'export type UpdateInput = never;'
				].join('\n')
			);
			await writeFile(
				join(root, 'src', 'collections', 'jobs', '+model.ts'),
				[
					"import { defineModel, text } from '@norbital-ai/bolt/authoring';",
					'export default defineModel(',
					'\t{',
					'\t\t/**',
					'\t\t * Where the work has got to.',
					'\t\t *',
					'\t\t * A second paragraph of history the agent does not need.',
					'\t\t */',
					'\t\tstatus: text(),',
					'\t\tnature: text()',
					'\t},',
					"\t{ name: 'jobs' }",
					');'
				].join('\n')
			);
			await writeFile(
				join(root, 'src', 'collections', 'jobs', '+collection.ts'),
				[
					"import model from './+model.js';",
					'/** A work order for one day. */',
					'export default defineCollection({',
					'\tmodel,',
					'\tcreate: { input: { columns: { status: true } } },',
					'\t/** Files it unassigned until a contractor holds it. Stamps the dispatch. */',
					'\ttransform: (inputs) => inputs',
					'});'
				].join('\n')
			);
			const index = buildTypeIndex(root, [{ name: 'jobs', create: true, update: false }]);
			const jobs = index?.collections['jobs'];
			expect(jobs?.docs?.fields['status']).toEqual({
				text: 'Where the work has got to.',
				source: 'src/collections/jobs/+model.ts:9'
			});
			expect(jobs?.docs?.fields['nature']).toEqual({
				text: '',
				source: 'src/collections/jobs/+model.ts:10'
			});
			expect(jobs?.docs?.collection).toEqual({
				text: 'A work order for one day.',
				source: 'src/collections/jobs/+collection.ts:3'
			});
			expect(jobs?.docs?.transform).toEqual({
				text: 'Files it unassigned until a contractor holds it. Stamps the dispatch.',
				source: 'src/collections/jobs/+collection.ts:7'
			});
			// The expanded type reads with the author's comment above the field.
			expect(jobs?.row).toContain('  /** Where the work has got to. */\n  status: string | null;');
			expect(jobs?.create).toContain(
				'  /** Where the work has got to. */\n  status?: string | null;'
			);
		}
	);
});
