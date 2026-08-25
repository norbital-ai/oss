import { Effect } from 'effect';
import * as Result from 'effect/Result';
import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { loadConfig } from './config.js';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCrossFile } from './cross-file.js';
import { runRules, sourceFiles, svelteScript } from './runner.js';
import { runSemanticTier } from './semantic/run.js';
import { runTypeAware } from './type-aware.js';
import { applyAllowances } from './allowances.js';
import { ignoredRule } from '../engine/scripts/ignore.mjs';

type WorkerRequest = Readonly<{
	root: string;
	includeTests: boolean;
	paths: ReadonlyArray<string>;
	semanticDisabled: boolean;
}>;

const request = workerData as WorkerRequest;
const loaded = await loadConfig(request.root);
// A caller-level decline sits above configuration, the way --include-tests sits beside it: the
// API answers to its invoker first.
const config = request.semanticDisabled
	? { ...loaded, semantic: { ...loaded.semantic, disabled: true } }
	: loaded;
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
		const read = Effect.runSync(Effect.result(Effect.try(() => readFileSync(absolute, 'utf8'))));
		if (Result.isFailure(read)) return [];
		const source = Result.match(read, { onSuccess: (v) => v, onFailure: () => '' });
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
 * Whole-repository rules run beside the per-file ones, always.
 *
 * Reachability, dead exports and duplicate bodies are properties of the set, so they are computed
 * once over every file rather than once per file — and they run on `allFiles`, not the `--path`
 * selection, because "nothing imports this" is only answerable against the whole repository.
 * These checks are part of the neutral baseline: they encode no product's architecture, only
 * arithmetic about the module graph.
 */
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
const crossFile = runCrossFile({ root: request.root, files: parsed, consumers }).filter(
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

/*
 * The semantic tier runs last: it needs the whole file set for its Merkle diff, and a failure —
 * no credential, unreachable provider, corrupt index — must surface as exit-2 evidence rather
 * than an all-clear, so nothing here catches on its behalf.
 *
 * Findings are filtered to the selection like the cross-file ones; the index itself always spans
 * `allFiles`, because "what does this repository say?" is a whole-repository question.
 */
const semantic = await runSemanticTier({
	root: request.root,
	config,
	rules: config.rules,
	allFiles
});

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
	.update(JSON.stringify({ packs: config.packs, rules }))
	.digest('hex')}`;

const selected = (location: string): boolean =>
	request.paths.length === 0 || selectedFiles.some((file) => location.startsWith(`${file}:`));

parentPort?.postMessage({
	packs: config.packs,
	// `.doctorignore` rule scoping answers every pass, not just the per-file runner: a
	// rule-scoped exception is a statement about a family of findings wherever they were
	// produced, and a cross-file finding that ignores the repository's own scoping would
	// make the catalogue disagree with the configuration it was produced from.
	findings: applyAllowances(request.root, [
		...findings,
		...crossFile,
		...typeAware.findings,
		...semantic.findings.filter((finding) => selected(finding.location))
	].filter((finding) => {
		const [file] = finding.location.split(':');
		return file === undefined || !ignoredRule(request.root, file, finding.rule);
	})),
	ruleCount: config.rules.length,
	ruleSetDigest,
	allFiles,
	selectedFiles,
	queries: config.queries,
	typeAware,
	semantic: {
		ran: semantic.ran,
		embedderId: semantic.embedderId,
		indexDigest: semantic.indexDigest,
		stats: semantic.stats,
		clusterCount: semantic.clusterCount,
		singletonCount: semantic.singletonCount
	}
});
