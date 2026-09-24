/**
 * The audit engine run as a search: one ad-hoc rule over a repository and a draft that exists only
 * in memory, answering where it matched rather than a finding.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { searchRule, searchRules } from '../build/index.js';

test('a pattern finds every call it names, with the line, its text and what it bound', () => {
	const root = mkdtempSync(join(tmpdir(), 'doctor-search-'));
	try {
		mkdirSync(join(root, 'src'), { recursive: true });
		writeFileSync(
			join(root, 'src', 'a.ts'),
			"const api = {} as any;\nexport const one = api.collection.sites.create({ name: 'x' });\nexport const two = api.collection.jobs.update({});\n"
		);
		const found = searchRules({
			root,
			rules: [searchRule({ pattern: 'api.collection.$C.create($$$)' })],
			files: ['src/a.ts']
		});
		assert.equal(found.total, 1);
		assert.deepEqual(found.matches, [
			{
				file: 'src/a.ts',
				line: 2,
				text: "export const one = api.collection.sites.create({ name: 'x' });",
				evidence: found.matches[0]?.evidence
			}
		]);
		assert.match(found.matches[0]!.evidence, /\$C=sites/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a markup rule searches a .svelte draft that is not on disk', () => {
	const root = mkdtempSync(join(tmpdir(), 'doctor-search-'));
	try {
		const draft: Record<string, string> = {
			'src/page.svelte':
				'<script lang="ts">\n\tlet open = $state(false);\n</script>\n\n<button class="mt-4" onclick={() => (open = true)}>Open</button>\n'
		};
		const found = searchRules({
			root,
			rules: [searchRule({ all: [{ kind: 'svelte:Attribute' }, { regex: '^onclick' }] })],
			files: Object.keys(draft),
			read: (file) => draft[file]
		});
		assert.equal(found.total, 1);
		assert.equal(found.matches[0]?.file, 'src/page.svelte');
		assert.equal(found.matches[0]?.line, 5);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
