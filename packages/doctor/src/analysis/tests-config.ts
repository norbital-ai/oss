/**
 * Test-configuration analysis, ported from `analyze.mjs`.
 *
 * A file that looks like a test is only counted as one when its owning package declares a command
 * that can actually select it. This is command-shape analysis, not a build-tool interpreter: broad
 * runner names count everywhere, a literal path counts when it names this file, and `node --test`
 * arguments are matched as globs against the file's package-relative path. Custom wrappers can
 * therefore classify conservatively, and unconfigured candidates stay visible in the report rather
 * than silently padding production.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, matchesGlob, relative, sep } from 'node:path';
import { Schema } from 'effect';
import { jsonRecord, readJsonObject, recordField } from '../manifest.js';

const isString = Schema.is(Schema.String);

/** Require a package test command that can actually select the test source. */
export function isConfiguredTest(path: string, owner: Readonly<{ root: string }>): boolean {
	const manifest = join(owner.root, 'package.json');
	if (!existsSync(manifest)) return false;
	let scriptsValue: unknown;
	try {
		scriptsValue = JSON.parse(readFileSync(manifest, 'utf8'));
	} catch {
		/* best effort */
		return false;
	}
	// The manifest is a parsed boundary value: scripts is read tolerantly, and any non-object
	// slot is "no test command", which is what an empty map is for.
	const scripts =
		(jsonRecord(scriptsValue)?.['scripts'] ?? jsonRecord(scriptsValue) ?? {}) as Readonly<Record<string, unknown>>;
	const commands = Object.entries(scripts)
		.filter(([name]) => name === 'test' || name.startsWith('test:'))
		.map(([, command]) => command)
		.filter(isString);
	const local = relative(owner.root, path).split(sep).join('/');
	for (const command of commands) {
		if (/\b(?:vitest|jest|mocha|ava|playwright)\b/.test(command)) return true;
		if (!/\bnode\b[^&|;]*\s--test\b/.test(command)) {
			if (command.includes(local) || command.includes(basename(local))) return true;
			continue;
		}
		const tail =
			command
				.split(/\s--test(?:=\S+)?\s*/)
				.at(-1)
				?.split(/(?:&&|\|\||;)/, 1)[0] ?? '';
		const patterns = tail
			.split(/\s+/)
			.map((item) => item.replace(/^['"]|['"]$/g, ''))
			.filter((item) => item !== '' && !item.startsWith('-'));
		if (patterns.length === 0) return true;
		for (const pattern of patterns)
			try {
				if (matchesGlob(local, pattern) || local === pattern) return true;
			} catch {
				/* best effort */
				if (local === pattern) return true;
			}
	}
	return false;
}
