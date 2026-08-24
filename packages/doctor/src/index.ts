/**
 * Deterministic static code-quality analysis for TypeScript, JavaScript, and Svelte repositories.
 *
 * Evidence comes from three tiers, and every receipt records which of them ran:
 *
 * - `syntactic` — per file, pure. Always on.
 * - `graph` — whole repository, module graph. On with the built-in detector.
 * - `typeAware` — a TypeScript program per owning tsconfig. Always on.
 *
 * The type-aware tier was optional, and off, until keeping it optional stopped being defensible:
 * `LEGACY2` reads `@deprecated` tags that live in somebody else's `.d.ts`, so with the tier off its
 * silence and its all-clear were the same result. It costs the scan roughly twice its syntactic
 * time and is worth that. `typeAware: false` in a receipt now means only that the selection held no
 * file a program can contain, and `assess` refuses to consolidate a root that reports it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runAuthored } from './authored.js';
import { findConfig } from './config.js';
import { runEngine } from './engine.js';
import { publishEvidence } from './evidence.js';
import type { Confidence, Severity } from './rules.js';

export { enginePath, runEngine } from './engine.js';
export type { EngineRun } from './engine.js';
export { definePack } from './rules.js';
export type {
	Confidence,
	NodeKind,
	Pack,
	Principle,
	Rule,
	RuleContext,
	Severity
} from './rules.js';
export { defineConfig, findConfig, loadConfig } from './config.js';
export type { LoadedConfig, OverlapBinding, ProbeConfig } from './config.js';
export { overlapRules } from './overlaps.js';
export type { OverlapShape } from './overlaps.js';
export { runRules, sourceFiles, svelteMarkup, svelteScript } from './runner.js';
export { reactivePack } from './packs/reactive.js';
export { stringlyPack, stringlyTyped } from './packs/stringly.js';
export type { StringlyOptions } from './packs/stringly.js';
export { effectCeremonyPack, effectCeremonyPatterns } from './packs/effect-ceremony.js';
export { defineRule, defineScope, verifyExamples, matchSource } from './pattern.js';
export { bindingTexts, compile, match, matcherKinds, parsePattern, withUtils } from './matcher.js';
export { boundariesPack, boundaryRules } from './packs/boundaries.js';
export { effectPack, effectRules } from './packs/effect.js';
export { structurePack, structureRules } from './packs/structure.js';
export { platformPack, platformRules } from './packs/platform.js';
export { sveltePack, svelteRules } from './packs/svelte.js';
export { norbitalPack, norbitalRules } from './packs/norbital.js';
export { runCrossFile } from './cross-file.js';
export { CAPABILITIES, capabilityPack, defineCapability } from './capability.js';
export type { Capability } from './capability.js';
export type {
	Bindings,
	Constraints,
	MatchResult,
	Matcher,
	NthChild,
	PatternStyle,
	Position,
	Range,
	StopBy,
	Strictness,
	Utils
} from './matcher.js';
export type { ShapeRule, VisitorRule, RuleDefinition, ScopeRule, Examples } from './pattern.js';
export type { RunOptions, SourceFileOptions } from './runner.js';

/** Where every root writes its findings, receipt, and reports. */
export const DIAGNOSIS_DIRECTORY = '.norbital/diagnosis';

export type Finding = Readonly<{
	readonly severity: Severity;
	readonly confidence: Confidence;
	/** Rule identifier, for example `EFF3` or `UI17c`. */
	readonly rule: string;
	readonly summary: string;
	/** `path/to/file.ts:12: source excerpt` */
	readonly location: string;
	readonly principles: ReadonlyArray<string>;
}>;

export type TierCoverage = Readonly<{
	readonly syntactic: boolean;
	readonly graph: boolean;
	readonly typeAware: boolean;
}>;

export type Receipt = Readonly<{
	readonly schemaVersion: number;
	readonly kind: string;
	readonly scannerVersion: number;
	readonly root: string;
	readonly scope: string;
	readonly includeTests: boolean;
	readonly tiers: TierCoverage;
	readonly files: number;
	readonly findings: string;
	readonly sourceInventoryDigest: string;
	readonly ruleSetDigest: string;
	readonly catalogueDigest: string;
	readonly counts: Readonly<{
		error: number;
		warning: number;
		hint: number;
		total: number;
		principles: Readonly<Record<string, number>>;
	}>;
	readonly complete: boolean;
}>;

export type AuditOptions = Readonly<{
	/** Repository to analyse. Defaults to the current working directory. */
	readonly root?: string | undefined;
	/** Include test and end-to-end sources in the scanned scope. */
	readonly includeTests?: boolean | undefined;
	/** Restrict the scan to these repository-relative paths. */
	readonly paths?: ReadonlyArray<string> | undefined;
	readonly signal?: AbortSignal | undefined;
}>;

export type AuditResult = Readonly<{
	readonly root: string;
	readonly findings: ReadonlyArray<Finding>;
	readonly receipt: Receipt;
	/** 0 clean, 1 actionable debt, 2 evidence incomplete or invalid. */
	readonly status: number;
	readonly counts: Readonly<Record<Severity, number>>;
	/** Absolute path to the canonical `findings.tsv`. */
	readonly cataloguePath: string;
	/** Packs loaded from the repository's `doctor.config.ts`, if it has one. */
	readonly packs: ReadonlyArray<string>;
	/** How many findings came from authored rules rather than the built-in detector. */
	readonly authoredFindings: number;
}>;

/**
 * Decode a receipt, checking the fields this module actually reads.
 *
 * The receipt is the thing that says whether the evidence can be trusted, so accepting it on an
 * unchecked cast would let a truncated or half-written file present itself as a complete scan —
 * the one failure the three-valued exit code exists to prevent. A malformed receipt is a thrown
 * error, never a quietly empty result.
 */
export function decodeReceipt(text: string, path: string): Receipt {
	let value: unknown;
	try {
		// Probe cannot take a schema dependency: it must analyse repositories that have none.
		// repository-health:allow R6b -- every field read below is checked before use
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(
			`norbital-doctor: ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (typeof value !== 'object' || value === null)
		throw new Error(`norbital-doctor: ${path} is not a receipt object`);

	// `in` narrowing reads each field as `unknown` without casting the receipt to a loose record,
	// so every field below is checked rather than asserted.
	if (!('tiers' in value) || typeof value.tiers !== 'object' || value.tiers === null)
		throw new Error(`norbital-doctor: ${path} records no tier coverage`);
	const tiers = value.tiers;
	// Written out rather than looped: `in` narrowing applies to a literal key, not to a loop
	// variable, so a loop would force exactly the loose-record cast this decoder avoids.
	if (!('syntactic' in tiers) || typeof tiers.syntactic !== 'boolean')
		throw new Error(`norbital-doctor: ${path} has no boolean "syntactic" tier`);
	if (!('graph' in tiers) || typeof tiers.graph !== 'boolean')
		throw new Error(`norbital-doctor: ${path} has no boolean "graph" tier`);
	if (!('typeAware' in tiers) || typeof tiers.typeAware !== 'boolean')
		throw new Error(`norbital-doctor: ${path} has no boolean "typeAware" tier`);
	if (!('findings' in value) || typeof value.findings !== 'string')
		throw new Error(`norbital-doctor: ${path} does not name its catalogue`);
	if (!('files' in value) || typeof value.files !== 'number' || !Number.isSafeInteger(value.files))
		throw new Error(`norbital-doctor: ${path} has no valid source count`);
	if (!('complete' in value) || value.complete !== true)
		throw new Error(`norbital-doctor: ${path} describes an incomplete scan`);

	return {
		...value,
		tiers: {
			syntactic: tiers.syntactic,
			graph: tiers.graph,
			typeAware: tiers.typeAware
		},
		findings: value.findings,
		files: value.files,
		complete: value.complete
	} as Receipt;
}

/** Parse the canonical tab-separated catalogue the scanner publishes. */
export function parseCatalogue(contents: string): ReadonlyArray<Finding> {
	const findings: Array<Finding> = [];
	for (const line of contents.split(/\r?\n/)) {
		if (!line) continue;
		const columns = line.split('\t');
		if (columns.length !== 6) throw new Error(`invalid catalogue row: ${line}`);
		const [severity, confidence, rule, summary, location, principles] = columns as [
			Severity,
			Confidence,
			string,
			string,
			string,
			string
		];
		findings.push({
			severity,
			confidence,
			rule,
			summary,
			location,
			principles: principles.split(',').filter(Boolean)
		});
	}
	return findings;
}

/**
 * Scan one repository and return its findings with the receipt that authenticates them.
 *
 * Exit 2 from the engine means the evidence is incomplete, stale, or invalid — most often because
 * the worktree changed while the scan was running. That is surfaced as a thrown error rather than
 * an empty result, because an empty finding list and an unusable scan must never look alike.
 */
export async function audit(options: AuditOptions = {}): Promise<AuditResult> {
	const root = resolve(options.root ?? process.cwd());
	// Always run: with no config the base pack is still the rule set, so a repository that has
	// configured nothing is measured rather than skipped.
	const authored = await runAuthored({
		root,
		includeTests: options.includeTests ?? false,
		paths: options.paths ?? [],
		signal: options.signal
	});

	/*
	 * One path. The legacy detector is gone, so `base: 'norbital'` selects a pack of ported rules
	 * rather than a second scanner, and there is nothing left to spawn.
	 */
	if (options.paths?.length && authored.selectedFiles.length === 0)
		throw new Error(
			`norbital-doctor: --path selected zero source files (${options.paths.join(', ')}) in ${root}`
		);
	const counts: Record<Severity, number> = { error: 0, hint: 0 };
	for (const finding of authored.findings) counts[finding.severity] += 1;
	const receipt = publishEvidence({
		root,
		findings: authored.findings,
		authoredRuleSetDigest: authored.ruleSetDigest,
		graph: authored.base !== 'none',
		typeAware: authored.typeAware.ran,
		allFiles: authored.allFiles,
		selectedFileCount: authored.selectedFiles.length,
		scope: options.paths?.length ? 'path' : 'all',
		includeTests: options.includeTests
	});
	return {
		root,
		findings: authored.findings,
		receipt,
		status: counts.error > 0 ? 1 : 0,
		counts,
		cataloguePath: join(root, DIAGNOSIS_DIRECTORY, 'findings.tsv'),
		packs: authored.packs,
		authoredFindings: authored.findings.length
	};
}

export type AssessOptions = AuditOptions &
	Readonly<{
		/** Additional repositories to include in one consolidated report. */
		readonly roots?: ReadonlyArray<string> | undefined;
		/** Write the report here; `--format both` adds `.json` and `.md`. */
		readonly out?: string | undefined;
		/** Report format. Defaults to `both` when `out` is set, `json` otherwise. */
		readonly format?: 'json' | 'markdown' | 'both' | undefined;
	}>;

/** Scan every selected root, authenticate each receipt, and emit one consolidated report. */
export async function assess(
	options: AssessOptions = {}
): Promise<Readonly<{ status: number; report: string; stderr: string }>> {
	const roots = (options.roots?.length ? options.roots : [options.root ?? process.cwd()]).map(
		(root) => resolve(root)
	);
	// Each root spawns a TypeScript program in the type-aware tier, so running them concurrently
	// thrashes CPU and memory on exactly the large repositories this is for.
	// repository-health:allow A6 -- roots are scanned one at a time on purpose
	for (const root of roots) await audit({ ...options, root });

	const argv: Array<string> = [];
	for (const root of roots) {
		argv.push('--root', root, '--receipt', join(root, DIAGNOSIS_DIRECTORY, 'receipt.json'));
	}
	// Always required, because the tier always runs: a root whose receipt reports otherwise is
	// describing a scan this consolidation cannot speak for.
	argv.push('--require-type-aware');
	argv.push('--format', options.format ?? (options.out ? 'both' : 'json'));
	if (options.out) argv.push('--out', options.out);

	const run = await runEngine('analyze', argv, { signal: options.signal });
	return { status: run.status, report: run.stdout, stderr: run.stderr };
}
