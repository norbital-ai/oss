/**
 * `.doctorignore` nests: a workspace's own file, met while scanning a parent root, scopes its subtree. Its paths and its
 * `inherit:` files resolve from its own directory, its lines follow its ancestors', and nothing leaks to siblings.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { clearIgnoreCache, ignoredFile, ignoredRule } from '../build/ignore.js';

const TREE: Record<string, string> = {
	'.doctorignore': '**/shared/ COERCE1\n',
	'hr/.doctorignore': 'inherit: .gitignore\nsrc/engine/ COERCE1\n!shared/ COERCE1\n',
	'hr/.gitignore': 'generated/\n'
};

it.effect('a nested .doctorignore scopes its own subtree, relative to its directory', () =>
	Effect.acquireUseRelease(
		Effect.sync(() => {
			const root = mkdtempSync(join(tmpdir(), 'doctor-ignore-'));
			for (const [path, text] of Object.entries(TREE)) {
				mkdirSync(dirname(join(root, path)), { recursive: true });
				writeFileSync(join(root, path), text);
			}
			return root;
		}),
		(root) =>
			Effect.sync(() => {
				clearIgnoreCache(root);
				assert.equal(ignoredRule(root, 'hr/src/engine/cel.ts', 'COERCE1'), true);
				assert.equal(ignoredRule(root, 'hr/src/engine/cel.ts', 'EFF1'), false);
				assert.equal(ignoredRule(root, 'src/engine/cel.ts', 'COERCE1'), false);
				assert.equal(ignoredRule(root, 'other/src/engine/cel.ts', 'COERCE1'), false);
				// `inherit:` reads the nested directory's own .gitignore
				assert.equal(ignoredFile(root, 'hr/generated/types.ts'), true);
				assert.equal(ignoredFile(root, 'generated/types.ts'), false);
				// the root's line reaches every depth; the nested file's later `!` re-includes it beneath hr/
				assert.equal(ignoredRule(root, 'shared/a.ts', 'COERCE1'), true);
				assert.equal(ignoredRule(root, 'hr/shared/a.ts', 'COERCE1'), false);
			}),
		(root) => Effect.sync(() => rmSync(root, { recursive: true, force: true }))
	)
);
