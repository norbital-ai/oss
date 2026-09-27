/**
 * The oss realm gates (RFC §2.1, §5.1): no published `@norbital-ai/*` surface names the host, and the realm
 * `boundaries` pack holds over every package's source.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { doctor } from '../build/index.js';

const OSS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACKAGES = join(OSS, 'packages');

function walk(path: string): string[] {
	if (!existsSync(path)) return [];
	if (!statSync(path).isDirectory()) return [path];
	return readdirSync(path).filter((name) => name !== 'node_modules').flatMap((name) => walk(join(path, name)));
}

test('§2.1: no package names the host in its src, docs, README or published files', () => {
	const offenders: string[] = [];
	for (const name of readdirSync(PACKAGES)) {
		const root = join(PACKAGES, name);
		if (!existsSync(join(root, 'package.json'))) continue;
		const published = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files?: string[] }).files ?? [];
		// `build` is compiled from `src`, which is scanned.
		const scanned = new Set(['src', 'docs', 'README.md', 'package.json', ...published.filter((entry) => entry !== 'build')]);
		for (const entry of scanned)
			for (const file of walk(join(root, entry)))
				readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
					if (/colony/i.test(line)) offenders.push(`${file.slice(OSS.length + 1)}:${index + 1}`);
				});
	}
	assert.deepEqual(offenders, []);
});

test('the realm boundaries pack reports nothing over the oss packages', () => {
	assert.deepEqual(doctor({ root: OSS, packs: ['realm/boundaries'] }).map((finding) => finding.location), []);
});
