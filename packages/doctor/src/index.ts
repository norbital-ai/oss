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
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runAuthored } from './authored.js';
import { publishEvidence } from './evidence.js';
import { buildMetrics } from './metrics/emitter.js';
import { Effect } from 'effect';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { assembleReport } from './analysis/index.js';
export { computeCheckpointDelta, deltaSummary } from './analysis/delta.js';
export type { CheckpointDelta, DeltaOptions, DeltaSide, PillarDelta } from './analysis/delta.js';
import type { Confidence, Severity } from './rules.js';

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
export { defineConfig, DOCTOR_CONFIG_DIRECTORY, findConfig, loadConfig } from './config.js';
export type { LoadedConfig, OverlapBinding, ProbeConfig } from './config.js';
export { overlapRules } from './overlaps.js';
export type { OverlapShape } from './overlaps.js';
export { runRules, sourceFiles, svelteMarkup, svelteScript } from './runner.js';
export { stringlyPack, stringlyTyped } from './packs/stringly.js';
export type { StringlyOptions } from './packs/stringly.js';
export { defineRule, defineScope, verifyExamples, matchSource } from './pattern.js';
export { bindingTexts, compile, match, matcherKinds, parsePattern, withUtils } from './matcher.js';
export { nameOf } from './nameof.js';
export { boundariesPack, boundaryRules } from './packs/boundaries.js';
export { structurePack, structureRules } from './packs/structure.js';
export { runCrossFile } from './cross-file.js';
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

/** Same discipline as the evidence writer: a temporary file, then an atomic rename. */
function atomicWriteText(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, contents);
	renameSync(temporary, path);
}

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
	/** Absolute path to the derived metrics table. */
	readonly metricsPath: string;
	/** Packs loaded from the repository's `.norbital/config/doctor` config, if it has one. */
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
	const parsed = Effect.runSync(
		Effect.result(
			// repository-health:allow R6b -- the parse becomes a schema decode on the next step.
			Effect.try(() => JSON.parse(text))
		)
	);
	/*
	 * One decode at the boundary. The receipt is a received shape and is understood here and
	 * nowhere else: the parse becomes a schema decode, and a half-written file fails as the
	 * thing it is — evidence that never was evidence — rather than as prose.
	 */
	return Result.match(parsed, {
		onFailure: (failure) => {
			throw new Error(`norbital-doctor: ${path} is not valid JSON: ${String(failure)}`);
		},
		onSuccess: (value) => decodeReceiptShape(value, path)
	});
}

/** The receipt schema, decoded field by field at the boundary that received it. */
function decodeReceiptShape(value: unknown, path: string): Receipt {
	const decoded = Effect.runSync(
		Effect.result(Schema.decodeUnknownEffect(ReceiptHeadSchema)(value))
	);
	return Result.match(decoded, {
		onFailure: (failure) => {
			throw new Error(`norbital-doctor: ${path} ${receiptFailureMessage(failure, path)}`);
		},
		onSuccess: (receipt) => {
			// Schema's number check accepts 1.5; a source count must be a safe integer, and the
			// boundary says so in the message a console reader expects.
			if (!Number.isSafeInteger(receipt.files))
				throw new Error(`norbital-doctor: ${path} has no valid source count`);
			return receipt as Receipt;
		}
	});
}

const ReceiptTierSchema = Schema.Struct({
	syntactic: Schema.Boolean,
	graph: Schema.Boolean,
	typeAware: Schema.Boolean
});

const ReceiptHeadSchema = Schema.Struct({
	tiers: ReceiptTierSchema,
	findings: Schema.String,
	files: Schema.Number,
	complete: Schema.Literal(true)
});

/** Map a Schema failure to the message a scanner receipt consumer expects to read. */
function receiptFailureMessage(failure: unknown, path: string): string {
	const text = String(failure);
	const segments = [...text.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1] ?? '');
	const slot = segments[segments.length - 1] ?? '';
	if (text.includes('Expected object') && segments.length === 0) return 'is not a receipt object';
	const tierSlots = new Set(['syntactic', 'graph', 'typeAware']);
	if (segments[0] === '"tiers"' && tierSlots.has(clean(slot)))
		return `has no boolean "${clean(slot)}" tier`;
	if (segments[0] === '"tiers"') return 'records no tier coverage';
	if (slot === '"findings"') return 'does not name its catalogue';
	if (slot === '"files"') return 'has no valid source count';
	if (slot === '"complete"') return 'describes an incomplete scan';
	return `cannot be read as evidence (${text.slice(0, 60)})`;
}

function clean(value: string): string {
	return value.replace(/"/g, '');
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
	 * One path. The legacy detector is gone, so `packs: ['norbital']` selects a pack of ported rules
	 * rather than a second scanner, and there is nothing left to spawn.
	 */
	if (options.paths?.length && authored.selectedFiles.length === 0)
		throw new Error(
			`norbital-doctor: --path selected zero source files (${options.paths.join(', ')}) in ${root}`
		);
	const counts: Record<Severity, number> = { error: 0, hint: 0 };
	for (const finding of authored.findings) counts[finding.severity] += 1;

	// The metrics table is derived evidence: pure computation over sources this audit already
	// trusts, written beside the catalogue so consolidated reports can cite it without parsing.
	const metrics = buildMetrics({
		root,
		files: authored.allFiles
	});
	atomicWriteText(join(root, DIAGNOSIS_DIRECTORY, 'metrics.tsv'), metrics.tsv);

	const receipt = publishEvidence({
		root,
		findings: authored.findings,
		authoredRuleSetDigest: authored.ruleSetDigest,
		// The graph pass is part of the neutral baseline and always runs.
		graph: true,
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
		metricsPath: join(root, DIAGNOSIS_DIRECTORY, 'metrics.tsv'),
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

	// Consolidation runs in-process now: the analyzer is typed source, byte-proven against the
	// `.mjs` it replaced, and a subprocess bought nothing but an exec boundary. The receipt of
	// every root is handed over explicitly, exactly as the argv form did.
	const run = assembleReport({
		roots,
		receipts: roots.map((root) => join(root, DIAGNOSIS_DIRECTORY, 'receipt.json')),
		// Always required, because the tier always runs: a root whose receipt reports otherwise
		// is describing a scan this consolidation cannot speak for.
		requireTypeAware: true,
		format: options.format ?? (options.out ? 'both' : 'json'),
		out: options.out
	});
	return { status: run.exitCode, report: run.stdout, stderr: '' };
}
