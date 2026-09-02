/**
 * Scanner provenance: receipt authentication and static-finding attachment, ported from
 * `analyze.mjs`.
 *
 * Static evidence is only as good as the receipt that describes it, so every selected root must
 * present exactly one canonical receipt whose schema, scanner version, scope, tier coverage,
 * source count, input-inventory digest, catalogue digest, severity counts, and principle buckets
 * all recompute exactly. The validations run in one order and throw one message each; the release
 * gate's stderr is part of its contract, so that order is preserved verbatim here.
 *
 * Findings then attach to the analyzer's own file records by absolute path, with anything they
 * cannot name mapped to `unmapped` rather than dropped — a finding outside the inventory is a
 * coverage fact, not noise.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { jsonRecord } from '../manifest.js';
import { scannerInputInventory } from './inventory.js';
import type { ScannerInventory } from './inventory.js';
import type { RootDescription } from './inventory.js';

export const RECEIPT_SCHEMA_VERSION = 6;
export const SCANNER_VERSION = 34;

/** Scanner-owned principle buckets, in canonical order. */
export const PRINCIPLES = [
	'simplicity',
	'straightforwardness',
	'modularity',
	'testability',
	'efficiency',
	'type-safety',
	'colocation',
	'no-bloat'
] as const;

export type Principle = (typeof PRINCIPLES)[number];

/** Report-facing count keys for the buckets (`type-safety` counts as `typeSafety`, and so on). */
export const PRINCIPLE_COUNT_KEYS = [
	'colocation',
	'efficiency',
	'modularity',
	'noBloat',
	'simplicity',
	'straightforwardness',
	'testability',
	'typeSafety'
] as const;

export type PrincipleCountKey = (typeof PRINCIPLE_COUNT_KEYS)[number];

export function principleCountKey(principle: string): string {
	if (principle === 'no-bloat') return 'noBloat';
	if (principle === 'type-safety') return 'typeSafety';
	return principle;
}

export function emptyPrincipleCounts(): Record<PrincipleCountKey, number> {
	return Object.fromEntries(
		PRINCIPLES.map((principle) => [principleCountKey(principle), 0])
	) as Record<PrincipleCountKey, number>;
}

/** One validated scanner receipt, exactly as complete as authentication requires. */
export type ScannerReceipt = Readonly<{
	schemaVersion: number;
	kind: string;
	scannerVersion: number;
	root: string;
	scope: string;
	includeTests: boolean;
	tiers: Readonly<{
		syntactic: boolean;
		graph: boolean;
		typeAware: boolean;
	}>;
	files: number;
	findings: string;
	sourceInventoryDigest: string;
	ruleSetDigest: string;
	catalogueDigest: string;
	counts: Readonly<{
		error: unknown;
		warning: unknown;
		hint: unknown;
		total: unknown;
		principles: Readonly<Record<string, unknown>>;
	}>;
	complete: boolean;
}>;

/** One authenticated root: its receipt, its catalogue rows, and the recomputed inventory. */
export type ScannerCatalogue = Readonly<{
	receiptPath: string;
	receipt: ScannerReceipt;
	catalogue: string;
	rows: ReadonlyArray<string>;
	inventory: ScannerInventory;
}>;

/** One static finding attached to the analysis's own file records. Serialized in this key order. */
export type FindingRow = Readonly<{
	severity: 'error' | 'warning' | 'hint';
	confidence: string;
	rule: string;
	summary: string;
	location: string;
	line: number | null;
	evidence: string | null;
	principles: ReadonlyArray<Principle>;
	file: string | null;
	concept: string;
}>;

/** The authenticated static-quality section of a report, before coverage is attached. */
export type StaticQualityBase = Readonly<{
	catalogues: ReadonlyArray<{
		root: string;
		receipt: string;
		sourceInventoryDigest: string;
		ruleSetDigest: string;
		catalogueDigest: string;
	}>;
	totals: Readonly<{ error: number; warning: number; hint: number }>;
	byRule: ReadonlyArray<{ name: string; count: number }>;
	byPrinciple: Array<{ name: Principle; count: number; perThousandProductionLoc?: number | null }>;
	byConcept: ReadonlyArray<{ name: string; count: number }>;
	findings: ReadonlyArray<FindingRow>;
}>;

/** A file record as finding attachment sees it. */
export type FindingTarget = Readonly<{ displayPath: string; concept: string }>;

function isSha256(value: unknown): value is string {
	return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

const SEVERITIES: ReadonlyArray<string> = ['error', 'warning', 'hint'];

function isSeverity(value: string | undefined): value is FindingRow['severity'] {
	return value === 'error' || value === 'warning' || value === 'hint';
}

/**
 * Validate one complete scanner receipt per selected root before accepting its catalogue.
 *
 * Each check throws the engine's exact message in the engine's exact order; consumers match on
 * these strings when explaining an unusable gate run.
 */
export function scannerCatalogues(
	receiptPaths: ReadonlyArray<string>,
	roots: ReadonlyArray<string>
): Array<ScannerCatalogue> {
	if (receiptPaths.length !== roots.length)
		throw new Error(
			`expected one scanner receipt per root (${roots.length}), received ${receiptPaths.length}`
		);
	const byRoot = new Map<string, ScannerCatalogue>();
	for (const receiptPath of receiptPaths) {
		// Parsed without wrapping: the engine surfaced raw JSON syntax errors and gate operators
		// grep for them.
		const parsed: unknown = JSON.parse(readFileSync(receiptPath, 'utf8'));
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
			throw new Error(`scanner receipt fields do not match schema: ${receiptPath}`);
		const record = parsed as Record<string, unknown>;
		const fields = [
			'catalogueDigest',
			'complete',
			'counts',
			'files',
			'findings',
			'includeTests',
			'kind',
			'root',
			'ruleSetDigest',
			'scannerVersion',
			'schemaVersion',
			'scope',
			'sourceInventoryDigest',
			'tiers'
		];
		if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...fields].sort()))
			throw new Error(`scanner receipt fields do not match schema: ${receiptPath}`);
		if (
			record.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
			record.kind !== 'repository-health-static-receipt' ||
			record.scannerVersion !== SCANNER_VERSION
		)
			throw new Error(`unsupported scanner receipt: ${receiptPath}`);
		const tiers = record.tiers;
		if (
			typeof tiers !== 'object' ||
			tiers === null ||
			(tiers as Record<string, unknown>).syntactic !== true ||
			typeof (tiers as Record<string, unknown>).graph !== 'boolean' ||
			typeof (tiers as Record<string, unknown>).typeAware !== 'boolean'
		)
			throw new Error(`scanner receipt does not record tier coverage: ${receiptPath}`);
		const tierCoverage = tiers as {
			syntactic: boolean;
			graph: boolean;
			typeAware: boolean;
		};
		if (
			record.scope !== 'all' ||
			record.includeTests !== false ||
			record.complete !== true ||
			record.findings !== 'findings.tsv'
		)
			throw new Error(`scanner receipt is not a complete production scan: ${receiptPath}`);
		if (typeof record.root !== 'string')
			throw new Error(`scanner receipt root is not canonical: ${receiptPath}`);
		const root = realpathSync(record.root);
		if (record.root !== root)
			throw new Error(`scanner receipt root is not canonical: ${receiptPath}`);
		if (!roots.includes(root)) throw new Error(`scanner receipt root was not selected: ${root}`);
		if (byRoot.has(root)) throw new Error(`duplicate scanner receipt for root: ${root}`);
		if (receiptPath !== join(root, '.norbital/diagnosis/receipt.json'))
			throw new Error(`scanner receipt is not at the canonical root path: ${receiptPath}`);
		if (typeof record.files !== 'number' || !Number.isSafeInteger(record.files) || record.files < 0)
			throw new Error(`invalid scanner source count: ${receiptPath}`);
		const catalogue = join(dirname(receiptPath), record.findings);
		if (!existsSync(catalogue)) throw new Error(`scanner catalogue does not exist: ${catalogue}`);
		const inventory = scannerInputInventory(root);
		if (record.files !== inventory.sources.length)
			throw new Error(`scanner source count is stale for root: ${root}`);
		if (record.sourceInventoryDigest !== inventory.digest)
			throw new Error(`scanner input inventory is stale for root: ${root}`);
		for (const [name, value] of [
			['sourceInventoryDigest', record.sourceInventoryDigest],
			['ruleSetDigest', record.ruleSetDigest],
			['catalogueDigest', record.catalogueDigest]
		])
			if (!isSha256(value)) throw new Error(`invalid scanner ${name}: ${receiptPath}`);
		const catalogueBytes = readFileSync(catalogue);
		const catalogueDigest = `sha256:${createHash('sha256').update(catalogueBytes).digest('hex')}`;
		if (record.catalogueDigest !== catalogueDigest)
			throw new Error(`scanner catalogue digest mismatch: ${catalogue}`);
		const rows = catalogueBytes.toString('utf8').split(/\r?\n/).filter(Boolean);
		const counts = {
			error: 0,
			warning: 0,
			hint: 0,
			total: rows.length,
			principles: emptyPrincipleCounts()
		};
		for (const line of rows) {
			const columns = line.split('\t');
			if (columns.length !== 6) throw new Error(`invalid scanner catalogue row: ${catalogue}`);
			const [severity, , , , , encodedPrinciples] = columns;
			if (!isSeverity(severity))
				throw new Error(`invalid scanner severity in ${catalogue}`);
			counts[severity] += 1;
			const principles = (encodedPrinciples ?? '').split(',').filter(Boolean);
			const canonical = PRINCIPLES.filter((principle) => principles.includes(principle));
			if (
				canonical.length === 0 ||
				canonical.length !== principles.length ||
				canonical.some((principle, index) => principle !== principles[index])
			)
				throw new Error(`invalid scanner principle bucket in ${catalogue}`);
			for (const principle of canonical) {
				const key = principleCountKey(principle);
				counts.principles[key as PrincipleCountKey] += 1;
			}
		}
		const receiptCounts = record.counts;
		const countsRecord = jsonRecord(receiptCounts);
		const principlesRecord =
			countsRecord === undefined ? {} : (jsonRecord(countsRecord['principles']) ?? {});
		if (
			countsRecord === undefined ||
			JSON.stringify(Object.keys(countsRecord).sort()) !==
				JSON.stringify(['error', 'hint', 'principles', 'total', 'warning']) ||
			JSON.stringify(Object.keys(principlesRecord).sort()) !==
				JSON.stringify(PRINCIPLE_COUNT_KEYS) ||
			Object.entries(counts)
				.filter(([name]) => name !== 'principles')
				.some(([name, value]) => countsRecord[name] !== value) ||
			Object.entries(counts.principles).some(
				([name, value]) => principlesRecord[name] !== value
			)
		)
			throw new Error(`scanner finding counts mismatch: ${catalogue}`);
		byRoot.set(root, {
			receiptPath,
			receipt: {
				schemaVersion: RECEIPT_SCHEMA_VERSION,
				kind: 'repository-health-static-receipt',
				scannerVersion: SCANNER_VERSION,
				root,
				scope: 'all',
				includeTests: false,
				tiers: tierCoverage,
				files: record.files,
				findings: record.findings as string,
				sourceInventoryDigest: record.sourceInventoryDigest as string,
				ruleSetDigest: record.ruleSetDigest as string,
				catalogueDigest: record.catalogueDigest as string,
				counts: receiptCounts as ScannerReceipt['counts'],
				complete: true
			},
			catalogue,
			rows,
			inventory
		});
	}
	const ordered: Array<ScannerCatalogue> = [];
	for (const root of roots) {
		const found = byRoot.get(root);
		if (!found) throw new Error(`scanner receipt root was not selected: ${root}`);
		ordered.push(found);
	}
	return ordered;
}

/** Import verified scanner catalogues and attach each static violation to its owning concept. */
export function staticFindings(	catalogues: ReadonlyArray<ScannerCatalogue>,
	byPath: ReadonlyMap<string, FindingTarget>,
	rootByPath: ReadonlyMap<string, RootDescription>
): StaticQualityBase {
	const rows: Array<FindingRow> = [];
	for (const { receiptPath, receipt, rows: catalogueRows } of catalogues) {
		const rootId = rootByPath.get(receipt.root)?.id ?? '';
		for (const line of catalogueRows) {
			const [severity, confidence, rule, summary, location, encodedPrinciples] = line.split('\t');
			if (!isSeverity(severity) || !rule || !location)
				throw new Error(`invalid findings row in ${receiptPath}`);
			const match = location.match(/^(.+?):(\d+)(?::\d+)?:(?:\s|$)/);
			const evidence = location.match(/\[([^\]]+)\]\s*$/)?.[1] ?? null;
			const absolute = match ? resolve(receipt.root, match[1] ?? '') : undefined;
			const record = absolute ? byPath.get(absolute) : undefined;
			const principles = PRINCIPLES.filter((principle) =>
				(encodedPrinciples ?? '').split(',').includes(principle)
			);
			rows.push({
				severity,
				confidence: confidence ?? '',
				rule,
				summary: summary ?? '',
				location,
				line: match ? Number(match[2]) : null,
				evidence,
				principles,
				file: record?.displayPath ?? (match ? `${rootId}/${match[1]}` : null),
				concept: record?.concept ?? 'unmapped'
			});
		}
	}
	const countBy = (key: 'rule' | 'concept'): Array<{ name: string; count: number }> =>
		[...rows.reduce((map, row) => map.set(row[key], (map.get(row[key]) ?? 0) + 1), new Map())]
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
	const totals = {
		error: rows.filter((row) => row.severity === 'error').length,
		warning: rows.filter((row) => row.severity === 'warning').length,
		hint: rows.filter((row) => row.severity === 'hint').length
	};
	const byPrinciple = PRINCIPLES.map((principle) => ({
		name: principle,
		count: rows.filter((row) => row.principles.includes(principle)).length
	}));
	return {
		catalogues: catalogues.map(({ receiptPath, receipt }) => ({
			root: rootByPath.get(receipt.root)?.id ?? '',
			receipt: receiptPath,
			sourceInventoryDigest: receipt.sourceInventoryDigest,
			ruleSetDigest: receipt.ruleSetDigest,
			catalogueDigest: receipt.catalogueDigest
		})),
		totals,
		byRule: countBy('rule'),
		byPrinciple,
		byConcept: countBy('concept'),
		findings: rows
	};
}
