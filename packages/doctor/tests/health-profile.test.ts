/**
 * Health-profile contract: language default, merge, and configurable convention entries.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { runCrossFile } from '../build/cross-file.js';
import {
	LANGUAGE_HEALTH_PROFILE,
	compileHealthProfile,
	matchesAny,
	mergeHealthProfile
} from '../build/health-profile.js';

const PRODUCT = /svelte|effect|bolt|colony|norbital|drizzle|tenant|workspace|pgTable/i;

function repository(name: string, files: Readonly<Record<string, string>>): string {
	const root = mkdtempSync(join(tmpdir(), `health-profile-${name}-`));
	for (const [file, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), contents);
	}
	execFileSync('git', ['init', '-q'], { cwd: root });
	execFileSync('git', ['add', '-A'], { cwd: root });
	return root;
}

function parsed(root: string, file: string): {
	file: string;
	source: string;
	sourceFile: ts.SourceFile;
} {
	const source = readFileSync(join(root, file), 'utf8');
	return {
		file,
		source,
		sourceFile: ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
	};
}

test('language default carries no product vocabulary', () => {
	assert.equal(LANGUAGE_HEALTH_PROFILE.serviceHeritage.length, 0);
	const serialized = JSON.stringify(LANGUAGE_HEALTH_PROFILE);
	assert.equal(PRODUCT.test(serialized), false, serialized);
});

test('merge concatenates and rejects unknown fields', () => {
	const merged = mergeHealthProfile(LANGUAGE_HEALTH_PROFILE, {
		frameworkEntries: ['\\.host\\.ts$'],
		genericLabels: ['succeed']
	});
	assert.ok(merged.frameworkEntries.includes('\\.host\\.ts$'));
	assert.ok(merged.frameworkEntries.includes(LANGUAGE_HEALTH_PROFILE.frameworkEntries[0] ?? ''));
	assert.ok(merged.genericLabels.includes('succeed'));
	assert.ok(merged.genericLabels.includes('Array'));
	assert.throws(
		() => mergeHealthProfile(LANGUAGE_HEALTH_PROFILE, { extra: [] } as never),
		/unknown health profile field extra/
	);
	assert.throws(
		() => mergeHealthProfile(LANGUAGE_HEALTH_PROFILE, { frameworkEntries: ['('] }),
		/invalid health profile pattern/
	);
});

test('language entries match index/main and not convention files', () => {
	const compiled = compileHealthProfile(LANGUAGE_HEALTH_PROFILE);
	assert.equal(matchesAny('src/index.ts', compiled.frameworkEntries), true);
	assert.equal(matchesAny('src/main.ts', compiled.frameworkEntries), true);
	assert.equal(matchesAny('vite.config.ts', compiled.frameworkEntries), true);
	assert.equal(matchesAny('scripts/seed.ts', compiled.frameworkEntries), true);
	assert.equal(matchesAny('src/+page.ts', compiled.frameworkEntries), false);
	assert.equal(matchesAny('src/app.host.ts', compiled.frameworkEntries), false);
	assert.equal(matchesAny('src/hooks.server.ts', compiled.frameworkEntries), false);
	assert.equal(matchesAny('src/Widget.svelte', compiled.frameworkEntries), false);
});

test('a plus-named file is FILE1 without a profile entry and reachable with one', (context) => {
	const root = repository('plus-entry', {
		'package.json': '{"name":"hp","type":"module","exports":"./src/index.ts"}',
		'src/index.ts': 'export const run = (): number => 1;\n',
		'src/+page.ts': 'export const load = (): number => 2;\n'
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));
	const files = [parsed(root, 'src/index.ts'), parsed(root, 'src/+page.ts')];

	const without = runCrossFile({ root, files, profile: LANGUAGE_HEALTH_PROFILE });
	assert.equal(
		without.some(
			(finding) => finding.rule === 'FILE1' && finding.location.startsWith('src/+page.ts:')
		),
		true
	);

	const withProfile = runCrossFile({
		root,
		files,
		profile: mergeHealthProfile(LANGUAGE_HEALTH_PROFILE, {
			frameworkEntries: ['(?:^|/)\\+[^/]*\\.[cm]?[jt]sx?$']
		})
	});
	assert.equal(
		withProfile.some((finding) => finding.rule === 'FILE1'),
		false
	);
});
