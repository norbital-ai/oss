/**
 * The rule engine asked where a rule matches (the agent's `workspace_search`): ast-grep's rule language over files read
 * from memory, answering each match's line, the matched code and what it bound.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { search } from '../build/index.js';

const files: Record<string, string> = {
	'src/a.ts': "export function add(a: number, b: number): number {\n\treturn a + b;\n}\nexport const one = api.collection.sites.create({ name: 'x' });\n",
	'src/page.svelte': '<script lang="ts">\n\tlet open = $state(false);\n</script>\n\n<button class="mt-4" onclick={() => (open = true)}>Open</button>\n'
};
const find = (rule: Parameters<typeof search>[0]['rule']) => search({ rule, files: Object.keys(files), read: (f) => files[f] });

test('a pattern answers the whole matched declaration and its bindings; $$$ spans parameters and statements', () => {
	const r = find('function $F($$$) { $$$ }');
	assert.equal(r.total, 1);
	assert.equal(r.matches[0]!.line, 1);
	assert.match(r.matches[0]!.span, /return a \+ b;\n\}$/);
	assert.match(find('api.collection.$C.create($$$)').matches[0]!.evidence, /\$C=sites/);
});

test('an object rule ANDs its keys as ast-grep does, and markup is searched like code', () => {
	assert.equal(find({ kind: 'CallExpression', regex: '^api\\.' }).total, 1);
	const r = find({ kind: 'svelte:Attribute', regex: '^onclick' });
	assert.deepEqual([r.total, r.matches[0]!.file, r.matches[0]!.line], [1, 'src/page.svelte', 5]);
});
