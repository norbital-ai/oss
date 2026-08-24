import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { loadConfig } from './config.js';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCrossFile } from './cross-file.js';
import { runRules, sourceFiles, svelteScript } from './runner.js';
import { runTypeAware } from './type-aware.js';
import { applyAllowances } from './allowances.js';

type WorkerRequest = Readonly<{
	root: string;
	includeTests: boolean;
	paths: ReadonlyArray<string>;
}>;

const request = workerData as WorkerRequest;
const config = await loadConfig(request.root);
const allFiles = sourceFiles(request.root, { includeTests: request.includeTests });
const selectedFiles = sourceFiles(request.root, {
	includeTests: request.includeTests,
	paths: request.paths.length === 0 ? undefined : request.paths
});
const findings = runRules({ root: request.root, rules: config.rules, files: selectedFiles });

/*
 * Whole-repository rules run beside the per-file ones.
 *
 * Reachability, dead exports and duplicate bodies are properties of the set, so they are computed
 * once over every file rather than once per file — and they run on `allFiles`, not the `--path`
 * selection, because "nothing imports this" is only answerable against the whole repository.
 */
const parse = (files: ReadonlyArray<string>) =>
	files.flatMap((file) => {
		const absolute = join(request.root, file);
		let source: string;
		try {
			source = readFileSync(absolute, 'utf8');
		} catch {
			return [];
		}
		// One extraction, shared with the runner. Two copies of this drifted apart: the runner kept
		// line offsets and this one did not, so cross-file findings pointed at the wrong lines.
		const text = file.endsWith('.svelte') ? (svelteScript(source) ?? '') : source;
		return [
			{
				file,
				source,
				sourceFile: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
			}
		];
	});

const parsed = parse(allFiles);

/*
 * Tests are consumers of the production set, never members of it.
 *
 * A default scan reports on production files only, so with the tests absent from the graph an
 * export that five test files import reads as dead code — 57 of bolt's 88 `EXP1` findings were
 * exactly that. They join the graph here, and are still never reported against.
 */
const scanned = new Set(allFiles);
const consumers = parse(
	sourceFiles(request.root, { includeTests: true }).filter((file) => !scanned.has(file))
);
const crossFile =
	config.base === 'none'
		? []
		: runCrossFile({ root: request.root, files: parsed, consumers }).filter(
				(finding) =>
					request.paths.length === 0 ||
					selectedFiles.some((file) => finding.location.startsWith(`${file}:`))
			);
/*
 * The type-aware tier runs beside the other two, always.
 *
 * It is the only tier that can see a `@deprecated` tag written in somebody else's `.d.ts`, so
 * making it optional made the absence of those findings mean two different things.
 */
const typeAware = runTypeAware({ root: request.root, files: selectedFiles });

const rules = config.rules
	.map((rule) => ({
		id: rule.id,
		severity: rule.severity,
		confidence: rule.confidence ?? 'high',
		summary: rule.summary,
		principles: rule.principles,
		when: rule.when,
		files: rule.files ?? [],
		ignore: rule.ignore ?? [],
		check: rule.check.toString()
	}))
	.sort((left, right) => left.id.localeCompare(right.id));
const ruleSetDigest = `sha256:${createHash('sha256')
	.update(JSON.stringify({ base: config.base, packs: config.packs, rules }))
	.digest('hex')}`;

parentPort?.postMessage({
	base: config.base,
	packs: config.packs,
	findings: applyAllowances(request.root, [...findings, ...crossFile, ...typeAware.findings]),
	ruleCount: config.rules.length,
	ruleSetDigest,
	allFiles,
	selectedFiles,
	typeAware
});
