import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	importsMatching,
	listFiles,
	specifierContainsPath,
	specifiersInSource,
	walkImportSpecifiers
} from '../src/import-specifiers.ts';

describe('import specifiers', () => {
	it('lists files and skips install trees', () => {
		const root = mkdtempSync(join(tmpdir(), 'import-walk-'));
		mkdirSync(join(root, 'node_modules', 'other'), { recursive: true });
		writeFileSync(join(root, 'kept.ts'), 'export const kept = true;\n');
		writeFileSync(
			join(root, 'node_modules', 'other', 'ignored.ts'),
			'export const ignored = true;\n'
		);
		assert.deepEqual(listFiles(root), [join(root, 'kept.ts')]);
	});

	it('collects import, export-from, dynamic import, and require specifiers', () => {
		const specifiers = specifiersInSource(
			'mod.ts',
			`
				import { a } from './a.js';
				export { b } from '../other/root';
				const c = await import('dynamic/root');
				const d = require('legacy/root');
			`
		);
		assert.deepEqual(specifiers, ['./a.js', '../other/root', 'dynamic/root', 'legacy/root']);
	});

	it('does not treat a comment or a plain string as a specifier', () => {
		const specifiers = specifiersInSource(
			'mod.ts',
			`
				// import { hidden } from "forbidden/root"
				const note = 'forbidden/root';
				import { ok } from './ok.js';
			`
		);
		assert.deepEqual(specifiers, ['./ok.js']);
	});

	it('reads script imports from a component file', () => {
		const specifiers = specifiersInSource(
			'surface.svelte',
			`
				<script lang="ts">
					import { ok } from './ok.js';
				</script>
				<p>forbidden/root</p>
			`
		);
		assert.deepEqual(specifiers, ['./ok.js']);
	});

	it('matches path fragments as segments, not substrings', () => {
		assert.equal(specifierContainsPath('../other/root/src', 'other/root'), true);
		assert.equal(specifierContainsPath('other/root', 'other/root'), true);
		assert.equal(specifierContainsPath('#lib/hosting/root.js', 'other/root'), false);
		assert.equal(specifierContainsPath('../other_root_copy', 'other/root'), false);
	});

	it('walks a tree and reports matching specifiers', () => {
		const root = mkdtempSync(join(tmpdir(), 'import-walk-'));
		writeFileSync(
			join(root, 'guest.ts'),
			`import { host } from '../../../apps/other/src/lib.js';\n`
		);
		writeFileSync(join(root, 'ok.ts'), `import { ok } from './ok.js';\n`);
		const hits = importsMatching(walkImportSpecifiers(root), ['apps/other']);
		assert.deepEqual(
			hits.map((hit) => hit.specifier),
			['../../../apps/other/src/lib.js']
		);
	});
});
