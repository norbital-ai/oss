import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { unexportedSpecifiers } from '../lib/package-archive.mjs';
import { publicPackageDirectories, readManifest } from '../lib/package-release.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

it('flags a specifier naming an entry its package does not export (L-BOLT-1002)', () => {
	const manifests = new Map([
		['@norbital-ai/bolt-server', { exports: { '.': { default: './build/index.js' } } }],
		['@norbital-ai/ui', { exports: { '.': {}, './layout': {}, './assets/*': './assets/*' } }]
	]);
	const sources = [
		['a.ts', `createRequire(x).resolve('@norbital-ai/bolt-server/next')`],
		['b.ts', `import { Stack } from '@norbital-ai/ui/layout'; import logo from "@norbital-ai/ui/assets/logo.svg";`],
		['c.ts', `id.startsWith('@norbital-ai/ui/'); import('@norbital-ai/ui/' + x); import '@norbital-ai/other/deep';`],
		['d.ts', `import '@norbital-ai/ui/page-header';`]
	];
	assert.deepEqual(unexportedSpecifiers(sources, manifests), [
		'a.ts: @norbital-ai/bolt-server/next',
		'd.ts: @norbital-ai/ui/page-header'
	]);
});

it('every first-party specifier in the packages names an export', () => {
	const manifests = new Map(
		publicPackageDirectories.map((d) => {
			const m = readManifest(path.join(repositoryRoot, 'packages', d, 'package.json'));
			return [m.name, m];
		})
	);
	const sources = publicPackageDirectories.flatMap((d) => {
		const src = path.join(repositoryRoot, 'packages', d, 'src');
		return readdirSync(src, { recursive: true })
			.map(String)
			.filter((f) => /\.(?:[cm]?[jt]s|svelte)$/.test(f))
			.map((f) => [`${d}/${f}`, readFileSync(path.join(src, f), 'utf8')]);
	});
	assert.deepEqual(unexportedSpecifiers(sources, manifests), []);
});
