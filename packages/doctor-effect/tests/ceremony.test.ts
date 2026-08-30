/**
 * Every described effect-ceremony pattern proves itself against its own bad and good examples,
 * executed the way the audit runs them — on files on disk.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { defineRule, runRules } from "@norbital-ai/doctor";
import { effectCeremonyPatterns } from "../build/index.js";

function repository(name: string, files: Readonly<Record<string, string>>): string {
	const root = mkdtempSync(join(tmpdir(), `probe-${name}-`));
	for (const [file, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), contents);
	}
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["add", "-A"], { cwd: root });
	return root;
}

test('every described pattern proves itself against its own examples', async (context) => {
	const root = repository('examples', { 'package.json': '{"name":"e","type":"module"}' });
	context.after(() => rmSync(root, { recursive: true, force: true }));

	// Each example is written to the file the rule is scoped to, so `files` is honoured too.
	const runOne = (source: string, compiled: ReturnType<typeof defineRule>): number => {
		const file = compiled.files?.some((pattern) => pattern.endsWith('.svelte'))
			? 'src/probe.svelte'
			: 'src/probe.ts';
		const body = file.endsWith('.svelte') ? `<script lang="ts">\n${source}\n</script>\n` : source;
		writeFileSync(join(root, file), body);
		return runRules({ root, rules: [compiled], files: [file] }).length;
	};

	mkdirSync(join(root, 'src'), { recursive: true });
	const failures: Array<string> = [];
	for (const description of effectCeremonyPatterns) {
		const compiled = defineRule(description);
		for (const source of description.examples.bad)
			if (runOne(source, compiled) === 0)
				failures.push(`${description.id}: expected a match — ${source}`);
		for (const source of description.examples.good)
			if (runOne(source, compiled) > 0)
				failures.push(`${description.id}: unexpected match — ${source}`);
	}
	assert.deepEqual(failures, [], failures.join('\n'));
});
