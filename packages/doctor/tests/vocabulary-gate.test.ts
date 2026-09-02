/**
 * D12: product words stay out of the health tier and the engine modules the RFC names.
 *
 * Allowed: diagnosis output paths, `.svelte` as a file extension, `svelte:` kind namespace in a
 * front-end module, and error strings prefixed `norbital-doctor:`.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const PRODUCT = /svelte|effect|bolt|colony|norbital|drizzle|tenant|workspace|pgTable/gi;

const ALWAYS = ['metrics', 'analysis'];
const WHEN_PRESENT = [
	'model.ts',
	'frontend',
	'facts.ts',
	'analyses',
	'matcher.ts',
	'pattern.ts',
	'runner.ts'
];

function walk(target: string, files: Array<string>): void {
	if (!existsSync(target)) return;
	const stats = statSync(target);
	if (stats.isFile()) {
		if (target.endsWith('.ts')) files.push(target);
		return;
	}
	for (const entry of readdirSync(target)) walk(join(target, entry), files);
}

function targets(): ReadonlyArray<string> {
	const files: Array<string> = [];
	for (const name of ALWAYS) walk(join(SRC, name), files);
	for (const name of WHEN_PRESENT) walk(join(SRC, name), files);
	return files.sort();
}

function allowed(file: string, line: string, word: string): boolean {
	const token = word.toLowerCase();
	if (token === 'norbital' && /norbital-doctor/.test(line)) return true;
	if (token === 'norbital' && /\.norbital(?:\/diagnosis)?\b/.test(line)) return true;
	if (token === 'svelte' && /\.svelte(?:-kit|-check)?\b/.test(line)) return true;
	if (token === 'svelte' && /\bsvelte(?:Script|Markup)\b/.test(line)) return true;
	if (token === 'svelte' && (file.startsWith(`frontend${join('/')}`) || file === 'model.ts'))
		return true;
	if (
		token === 'effect' &&
		/(?:from ['"]effect(?:\/[^'"]+)?['"]|import \{ Effect|\bEffect\.(?:runSync|result|try)\b)/.test(
			line
		)
	)
		return true;
	if (token === 'effect' && /side[- ]effects?/.test(line)) return true;
	return false;
}

type Hit = Readonly<{ file: string; line: number; word: string; text: string }>;

function hitsIn(files: ReadonlyArray<string>): ReadonlyArray<Hit> {
	const hits: Array<Hit> = [];
	for (const file of files) {
		const lines = readFileSync(file, 'utf8').split(/\r?\n/);
		for (const [index, text] of lines.entries()) {
			for (const match of text.matchAll(PRODUCT)) {
				const word = match[0] ?? '';
				if (allowed(relative(SRC, file), text, word)) continue;
				hits.push({
					file: relative(SRC, file),
					line: index + 1,
					word,
					text: text.trim()
				});
			}
		}
	}
	return hits;
}

test('vocabulary gate: product words only appear in the allowed forms', () => {
	const files = targets();
	assert.ok(
		files.some((file) => file.endsWith(`${join('analysis', 'complexity.ts')}`)),
		'analysis/complexity.ts must be in the gate'
	);
	assert.ok(
		files.some((file) => file.endsWith(`${join('analysis', 'entities.ts')}`)),
		'analysis/entities.ts must be in the gate'
	);
	const leaks = hitsIn(files);
	const health = leaks.filter(
		(hit) => hit.file.startsWith(`metrics${join('/')}`) || hit.file.startsWith(`analysis${join('/')}`)
	);
	assert.deepEqual(
		health,
		[],
		health.map((hit) => `${hit.file}:${hit.line} ${hit.word} — ${hit.text}`).join('\n')
	);
	const engine = leaks
		.filter((hit) => !health.includes(hit))
		.map((hit) => `${hit.file}:${hit.line}:${hit.word}`);
	// Phase 3 still owns matcher/runner comments and a package import. The health tier is the
	// Phase 4b gate; this list is the remainder D12 still names.
	const leftover = engine.filter(
		(hit) =>
			!(
				hit.startsWith('matcher.ts:') ||
				hit.startsWith('pattern.ts:') ||
				hit.startsWith('runner.ts:')
			)
	);
	assert.deepEqual(leftover, [], leftover.join('\n'));
});
