// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (relativePath: string): string =>
	readFileSync(new URL(`../src/workspace-shell/${relativePath}`, import.meta.url), 'utf8');

test('the workspace sidebar renders the ordered semantic section model', () => {
	const sidebar = source('workspace-sidebar.svelte');
	assert.match(sidebar, /\{#each model\.sections as section, index \(section\.key\)\}/u);
	assert.match(sidebar, /label=\{section\.label\}/u);
	assert.match(sidebar, /items=\{section\.items\}/u);
	assert.doesNotMatch(sidebar, /label=\{t\('misc\.platform'\)\}/u);
});

test('the section contract fixes the three job-oriented groups', () => {
	const types = source('workspace-shell.types.ts');
	assert.match(types, /'operations' \| 'administration' \| 'applications'/u);
	assert.match(types, /sections: Schema\.Array\(WorkspaceNavigationSectionSchema\)/u);
});
