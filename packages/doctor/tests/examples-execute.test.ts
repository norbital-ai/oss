/**
 * Every shipped rule is run against its own examples.
 *
 * `examples` was mandatory for a rule written in TypeScript and optional for the same rule written
 * in YAML: `DELEGATED_EXAMPLES` filled in `{ bad: [''], good: [''] }` and the counter-example
 * contract was suspended for exactly the surface every rule is moving to. No YAML example had ever
 * been run.
 *
 * A rule that cannot report its own defect is not a rule, and a `good` case that reports is a false
 * positive with a fixture already written for it. Both are failures here.
 *
 * `reports` below has to know one thing the rule documents assume: a component-scoped rule writes
 * its examples as script bodies, so a bare statement must be given a `<script>` block. A `.svelte`
 * file without one has no script for the runner to parse, and the example would be judged against
 * an empty file — passing for the wrong reason, which is worse than failing.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { analyseCrossFile, bindCrossFileIndex } from '../build/cross-file.js';
import { loadPackDirectory, runRules, type Rule } from '../build/index.js';

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '../..');



type Documented = Readonly<{
	rule: Rule;
	bad: ReadonlyArray<string>;
	good: ReadonlyArray<string>;
	/** Other files the examples need — a neighbouring module, a `tsconfig.json` declaring an alias. */
	fixture: Readonly<Record<string, string>>;
	/** Where the example is written, for a rule whose claim depends on the path. */
	at: string | undefined;
	/** Reachability claims need a different path for the counter-example than for the defect. */
	goodAt: string | undefined;
	source: string;
}>;

/** Every rule document this repository ships, paired with the examples it declares. */
function documented(): ReadonlyArray<Documented> {
	const rows: Array<Documented> = [];
	for (const pkg of ['doctor', 'doctor-effect', 'doctor-norbital']) {
		const packs = join(PACKAGES, pkg, 'packs');
		if (!existsSync(packs)) continue;
		for (const entry of readdirSync(packs, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const directory = join(packs, entry.name);
			const byId = new Map(loadPackDirectory(directory).map((rule) => [rule.id, rule]));
			for (const name of readdirSync(directory).filter((n) => /\.ya?ml$/.test(n))) {
				const document = parseYaml(readFileSync(join(directory, name), 'utf8')) as {
					id?: string;
					examples?: {
						bad?: ReadonlyArray<string>;
						good?: ReadonlyArray<string>;
						fixture?: Readonly<Record<string, string>>;
						file?: string;
						goodFile?: string;
					};
				};
				const rule = document.id === undefined ? undefined : byId.get(document.id);
				if (rule === undefined) continue;
				rows.push({
					rule,
					bad: document.examples?.bad ?? [],
					good: document.examples?.good ?? [],
					fixture: document.examples?.fixture ?? {},
					at: document.examples?.file,
					goodAt: document.examples?.goodFile,
					source: `${pkg}/packs/${entry.name}/${name}`
				});
			}
		}
	}
	return rows;
}

/**
 * Run one rule over one example.
 *
 * A rule scoped to components is given a component, and a bare script body is wrapped in a
 * `<script>` block — a `.svelte` file without one has no script for the runner to parse, which is
 * exactly how six examples came to be unable to provoke their own rule.
 */
function reports(
	rule: Rule,
	example: string,
	fixture: Readonly<Record<string, string>>,
	at: string | undefined
): number {
	const componentScoped = (rule.files ?? []).some((glob) => glob.includes('.svelte'));
	const file = at ?? (componentScoped ? 'src/Probe.svelte' : 'src/probe.ts');
	const body =
		componentScoped && !/<\w/.test(example) ? `<script lang="ts">\n${example}\n</script>\n` : example;
	const root = mkdtempSync(join(tmpdir(), 'doctor-examples-'));
	try {
		const files: Record<string, string> = { ...fixture, [file]: body };
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), content);
		}
		const sourceNames = Object.keys(files).filter((path) =>
			/\.(?:[mc]?tsx?|[mc]?jsx?|svelte)$/.test(path)
		);
		bindCrossFileIndex(
			root,
			analyseCrossFile({
				root,
				files: sourceNames.map((path) => {
					const source = files[path] ?? '';
					return {
						file: path,
						source,
						sourceFile: ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
					};
				})
			})
		);
		return runRules({ root, rules: [rule], files: Object.keys(files) }).filter(
			(f) => f.rule === rule.id
		).length;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test('every shipped rule document declares examples', () => {
	const bare = documented().filter((row) => row.bad.length === 0 || row.good.length === 0);
	assert.deepEqual(
		bare.map((row) => row.source),
		[],
		'a rule with no counter-example cannot show it detects anything'
	);
});

test('every bad example reports, and every good example does not', () => {
	const rows = documented();
	assert.ok(rows.length > 0, 'no rule documents were loaded, so this proves nothing');
	const failures: Array<string> = [];
	for (const row of rows) {
		for (const example of row.bad)
			if (reports(row.rule, example, row.fixture, row.at) === 0)
				failures.push(`${row.source}: bad example does not report — ${example.slice(0, 60)}`);
		for (const example of row.good)
			if (reports(row.rule, example, row.fixture, row.goodAt ?? row.at) > 0)
				failures.push(`${row.source}: good example reports — ${example.slice(0, 60)}`);
	}
	assert.deepEqual(failures, []);
});
