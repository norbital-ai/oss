import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from '@effect/vitest';
import { Schema } from 'effect';
import { unexportedSpecifiers } from '../lib/package-archive.ts';
import { Manifest } from '../lib/package-release.ts';
it('flags a specifier naming an entry its package does not export (L-BOLT-1002)', () => {
	const manifests = new Map<string, Pick<Manifest, 'exports'>>([
		['@norbital-ai/bolt-server', { exports: { '.': { default: './build/index.js' } } }],
		['@norbital-ai/ui', { exports: { '.': {}, './layout': {}, './assets/*': './assets/*' } }]
	]);
	const sources: Array<[string, string]> = [
		['a.ts', `createRequire(x).resolve('@norbital-ai/bolt-server/next')`],
		[
			'b.ts',
			`import { Stack } from '@norbital-ai/ui/layout'; import logo from "@norbital-ai/ui/assets/logo.svg";`
		],
		[
			'c.ts',
			`id.startsWith('@norbital-ai/ui/'); import('@norbital-ai/ui/' + x); import '@norbital-ai/other/deep';`
		],
		['d.ts', `import '@norbital-ai/ui/page-header';`]
	];
	assert.deepEqual(unexportedSpecifiers(sources, manifests), [
		'a.ts: @norbital-ai/bolt-server/next',
		'd.ts: @norbital-ai/ui/page-header'
	]);
});
it('ignores service IDs and other data while retaining literal module import checks', () => {
	const manifests = new Map<string, Pick<Manifest, 'exports'>>([
		['@norbital-ai/bolt', { exports: { '.': {}, './declarations': {} } }]
	]);
	const sources: Array<[string, string]> = [
		[
			'identities.ts',
			`
			class TestWorkspace extends Context.Service<TestWorkspace, {}>()('@norbital-ai/bolt/test/TestWorkspace') {}
			const ShellConfiguration = Context.Reference('@norbital-ai/bolt/ShellConfiguration', {});
			const text = '@norbital-ai/bolt/plain-data';
			object.resolve('@norbital-ai/bolt/data-resolution');
			// import '@norbital-ai/bolt/comment';
			import '@norbital-ai/bolt/declarations';
		`
		],
		[
			'imports.ts',
			`
			import '@norbital-ai/bolt/static';
			export { x } from '@norbital-ai/bolt/export';
			import old = require('@norbital-ai/bolt/import-equals');
			type T = import('@norbital-ai/bolt/import-type').T;
			import('@norbital-ai/bolt/dynamic', { with: { type: 'json' } });
			require('@norbital-ai/bolt/require');
			require.resolve('@norbital-ai/bolt/resolve');
			createRequire(import.meta.url)('@norbital-ai/bolt/direct-require');
			const local = createRequire(import.meta.url);
			local('@norbital-ai/bolt/local-require');
			local.resolve('@norbital-ai/bolt/local-resolve');
			const { resolve: find } = createRequire(import.meta.url);
			find('@norbital-ai/bolt/destructured-resolve');
		`
		],
		[
			'component.svelte',
			`
			<script lang="ts">import '@norbital-ai/bolt/svelte-script';</script>
			<p>@norbital-ai/bolt/markup-data</p>
		`
		]
	];
	assert.deepEqual(unexportedSpecifiers(sources, manifests), [
		'imports.ts: @norbital-ai/bolt/static',
		'imports.ts: @norbital-ai/bolt/export',
		'imports.ts: @norbital-ai/bolt/import-equals',
		'imports.ts: @norbital-ai/bolt/import-type',
		'imports.ts: @norbital-ai/bolt/dynamic',
		'imports.ts: @norbital-ai/bolt/require',
		'imports.ts: @norbital-ai/bolt/resolve',
		'imports.ts: @norbital-ai/bolt/direct-require',
		'imports.ts: @norbital-ai/bolt/local-require',
		'imports.ts: @norbital-ai/bolt/local-resolve',
		'imports.ts: @norbital-ai/bolt/destructured-resolve',
		'component.svelte: @norbital-ai/bolt/svelte-script'
	]);
});

it('keeps declarations and the CLI test kit on their current entries and refuses retired Bolt entries', () => {
	const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest));
	const manifests = new Map<string, Pick<Manifest, 'exports'>>([
		['@norbital-ai/bolt', decode(readFileSync(new URL('../../packages/bolt/package.json', import.meta.url), 'utf8'))],
		['@norbital-ai/bolt-cli', decode(readFileSync(new URL('../../packages/bolt-cli/package.json', import.meta.url), 'utf8'))]
	]);
	const sources: Array<[string, string]> = [
		['current.ts', `
			import { bind_model } from '@norbital-ai/bolt/declarations';
			import { TestWorkspace } from '@norbital-ai/bolt-cli/test';
			import { read_artifact } from '@norbital-ai/bolt/artifact';
		`],
		['retired.ts', `
			import '@norbital-ai/bolt/test';
			import '@norbital-ai/bolt/cell';
			import '@norbital-ai/bolt/protocol/cursor';
			import '@norbital-ai/bolt/isolate-globals';
		`]
	];
	assert.deepEqual(unexportedSpecifiers(sources, manifests), [
		'retired.ts: @norbital-ai/bolt/test',
		'retired.ts: @norbital-ai/bolt/cell',
		'retired.ts: @norbital-ai/bolt/protocol/cursor',
		'retired.ts: @norbital-ai/bolt/isolate-globals'
	]);
});
