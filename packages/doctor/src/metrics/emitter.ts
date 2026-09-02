/**
 * The per-root metrics table.
 *
 * Every column comes from the typed metric modules in this directory plus the shared cyclomatic
 * counter the merged analyzer uses (`analysis/complexity.ts`), so a number here and a number in a
 * consolidated report have one definition each. The table is additive evidence: it never feeds the
 * health composite directly, because a composite weight is a claim about priorities that deserves
 * its own reviewed change rather than a side effect of adding a measurement.
 *
 * Line counting is deliberately display-grade here — non-blank, non-comment-only lines — while the
 * authoritative LOC classification for scores stays in the analyzer's scanner-based counters. Two
 * LOC numbers with two documented definitions beat one silently wrong one.
 *
 * Output is byte-stable: rows sort by kind, then file, then line, then name; emitting twice yields
 * identical bytes. Nothing is written to disk — callers own persistence, exactly as they own the
 * catalogue.
 */
import { Effect } from 'effect';
import * as Result from 'effect/Result';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { complexityOf } from '../analysis/complexity.js';
import { svelteScript } from '../runner.js';
import {
	cognitiveComplexity,
	countSuppressions,
	halsteadVolume,
	lcomHendersonSellers,
	maintainabilityIndex,
	analyzeAssertions
} from './index.js';
import { isFunctionLike } from './cognitive.js';

/** Column order is the contract; consumers split on tabs and address by position. */
const HEADER = [
	'kind',
	'file',
	'line',
	'name',
	'cyclomatic',
	'nesting',
	'cognitive',
	'halstead_volume',
	'maintainability_index',
	'crap',
	'lcom'
].join('\t');

const KIND_ORDER: Readonly<Record<string, number>> = { class: 0, file: 1, function: 2, method: 3 };

type MetricsRow = Readonly<{
	readonly kind: 'class' | 'file' | 'function' | 'method';
	readonly file: string;
	readonly line: number;
	readonly name: string;
	readonly cyclomatic: number;
	readonly nesting: number;
	readonly cognitive: number;
	readonly halsteadVolume: number;
	readonly maintainabilityIndex: number;
	/** 0–1 coverage ratio behind the CRAP cell; absent means no data, which renders empty. */
	readonly crap: string;
	readonly lcom: string;
}>;

type MetricsSummary = Readonly<{
	readonly functions: number;
	readonly classes: number;
	readonly files: number;
	readonly meanCyclomatic: number;
	readonly p95Cyclomatic: number;
	readonly meanCognitive: number;
	readonly meanMaintainability: number;
	readonly suppressionsPerKloc: number;
	readonly assertionsPerTest: number | undefined;
	readonly zeroAssertionTests: ReadonlyArray<string>;
	readonly rows: number;
}>;

type EmitMetricsOptions = Readonly<{
	readonly root: string;
	/** Repository-relative source files; defaults are the caller's problem — this module measures what it is given. */
	readonly files: ReadonlyArray<string>;
	/**
	 * Coverage ratios keyed `file:line` (the declaration's start line). Istanbul reports carry
	 * statement maps; whoever builds the map owns the join.
	 */
	readonly coverage?: ReadonlyMap<string, number> | undefined;
	/** Test sources measured for assertion density, parsed by the caller. */
	readonly testSources?: ReadonlyArray<Readonly<{ file: string; sourceFile: ts.SourceFile }>>;
}>;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Non-blank lines that are not comment-only — good enough to rank files, documented as such. */
function displayLoc(source: string): number {
	let count = 0;
	for (const raw of source.split('\n')) {
		const line = raw.trim();
		if (line === '' || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*'))
			continue;
		count += 1;
	}
	return count;
}

/** A stable display name for any function-like, `(anonymous)` where none exists. */
function functionName(node: ts.FunctionLikeDeclaration): string {
	if (!node.name && ts.isVariableDeclaration(node.parent)) return node.parent.name.getText();
	if (node.name !== undefined) return node.name.getText().replace(/\s+/g, ' ');
	const parent = node.parent;
	if (ts.isPropertyAssignment(parent)) return parent.name.getText();
	if (ts.isVariableDeclaration(parent)) return parent.name.getText();
	return '(anonymous)';
}

function afterVariableStatement(
	node: ts.VariableStatement,
	file: string,
	sourceFile: ts.SourceFile,
	coverage: ReadonlyMap<string, number> | undefined,
	rows: Array<MetricsRow>,
	fileCyclomatic: { value: number }
): void {
	for (const declaration of node.declarationList.declarations) {
		const initializer = declaration.initializer;
		if (initializer === undefined) continue;
		if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
			rows.push(
				rowOf(
					'function',
					file,
					sourceFile.getLineAndCharacterOfPosition(initializer.getStart(sourceFile)).line + 1,
					declaration.name.getText(),
					initializer,
					coverage,
					undefined
				)
			);
			fileCyclomatic.value += complexityOf(initializer.body ?? initializer).cyclomatic;
		}
	}
}

function afterClassOf(
	node: ts.ClassDeclaration,
	name: ts.Identifier,
	file: string,
	sourceFile: ts.SourceFile,
	coverage: ReadonlyMap<string, number> | undefined,
	rows: Array<MetricsRow>,
	fileCyclomatic: { value: number }
): void {
	const methods = node.members.filter(
		(member): member is ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration =>
			ts.isMethodDeclaration(member) ||
			ts.isGetAccessorDeclaration(member) ||
			ts.isSetAccessorDeclaration(member)
	);
	let classComplexity = 0;
	for (const method of methods) {
		classComplexity += complexityOf(method.body ?? method).cyclomatic;
		rows.push(
			rowOf(
				'method',
				file,
				sourceFile.getLineAndCharacterOfPosition(method.getStart(sourceFile)).line + 1,
				functionName(method),
				method,
				coverage,
				undefined
			)
		);
	}
	rows.push(
		rowOf(
			'class',
			file,
			sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
			name.text,
			undefined,
			coverage,
			lcomHendersonSellers(node) ?? undefined
		)
	);
	fileCyclomatic.value += classComplexity;
}

function rowOf(
	kind: MetricsRow['kind'],
	file: string,
	line: number,
	name: string,
	fn: ts.FunctionLikeDeclaration | undefined,
	coverage: ReadonlyMap<string, number> | undefined,
	lcom: number | undefined
): MetricsRow {
	// Cognitive complexity measures the function; cyclomatic/Halstead measure its body, which for
	// expression-bodied arrows is the expression itself.
	const body = fn === undefined ? undefined : (fn.body ?? fn);
	const loc = displayLoc(fn?.body?.getText() ?? '');
	const complexity = body === undefined ? { cyclomatic: 0, nesting: 0 } : complexityOf(body);
	const volume = body === undefined ? 0 : halsteadVolume(body).volume;
	const cognitive = fn === undefined ? 0 : cognitiveComplexity(fn);
	const mi =
		body === undefined
			? 100
			: maintainabilityIndex({ volume, cyclomatic: complexity.cyclomatic, loc: Math.max(loc, 1) });
	const ratio = coverage?.get(`${file}:${line}`) ?? null;
	const crapCell =
		ratio === null ? '' : String(round2(complexity.cyclomatic ** 2 * (1 - ratio) ** 3 + ratio));
	return {
		kind,
		file,
		line,
		name,
		cyclomatic: complexity.cyclomatic,
		nesting: complexity.nesting,
		cognitive,
		halsteadVolume: round2(volume),
		maintainabilityIndex: round2(mi),
		crap: crapCell,
		lcom: lcom === undefined ? '' : String(round2(lcom))
	};
}

const renderRow = (row: MetricsRow): string =>
	[
		row.kind,
		row.file,
		row.line,
		row.name,
		row.cyclomatic,
		row.nesting,
		row.cognitive,
		row.halsteadVolume,
		row.maintainabilityIndex,
		row.crap,
		row.lcom
	].join('\t');

const percentile95 = (values: ReadonlyArray<number>): number => {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.ceil(sorted.length * 0.95) - 1;
	return sorted[Math.max(index, 0)]!;
};

/** Build the whole table and its summary from the given sources. */
export function buildMetrics(options: EmitMetricsOptions): { tsv: string; summary: MetricsSummary } {
	const rows: Array<MetricsRow> = [];
	const sources: Array<{ file: string; sourceFile: ts.SourceFile; raw: string }> = [];

	for (const file of options.files) {
		const absolute = join(options.root, file);
		const read = Effect.runSync(Effect.result(Effect.try(() => readFileSync(absolute, 'utf8'))));
		const raw = Result.getOrElse(read, () => undefined);
		if (raw === undefined) continue;
		// `.svelte` scripts parse like TS while LOC stays whole-file, matching every other consumer.
		const text = file.endsWith('.svelte') ? (svelteScript(raw) ?? '') : raw;
		const parsedFile = Effect.runSync(
			Effect.result(
				Effect.try(() =>
					ts.createSourceFile(
						file,
						text,
						ts.ScriptTarget.Latest,
						true,
						file.endsWith('.svelte') || file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
					)
				)
			)
		);
		const sourceFile = Result.getOrElse(parsedFile, () => undefined);
		if (sourceFile === undefined) continue;
		sources.push({ file, sourceFile, raw });
	}

	let classCount = 0;
	for (const { file, sourceFile, raw } of sources) {
		const fileCyclomatic = { value: 0 };
		const visit = (node: ts.Node): void => {
			if (ts.isClassDeclaration(node) && node.name !== undefined) {
				classCount += 1;
				// Pass the accumulator through the object: classes can move a lot of state without
				// nesting the caller's visit loop any deeper, so the walk stays terminal at three.
				afterClassOf(node, node.name, file, sourceFile, options.coverage, rows, fileCyclomatic);
			} else if (
				ts.isFunctionDeclaration(node) &&
				node.body !== undefined
			) {
				rows.push(
					rowOf(
						'function',
						file,
						sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
						functionName(node),
						node,
						options.coverage,
						undefined
					)
				);
				fileCyclomatic.value += complexityOf(node.body).cyclomatic;
			} else if (ts.isVariableStatement(node)) {
				afterVariableStatement(node, file, sourceFile, options.coverage, rows, fileCyclomatic);
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);

		rows.push({
			kind: 'file',
			file,
			line: 1,
			name: '-',
			cyclomatic: fileCyclomatic.value,
			nesting: 0,
			cognitive: 0,
			halsteadVolume: 0,
			maintainabilityIndex: 100,
			crap: '',
			lcom: ''
		});
	}

	rows.sort(
		(left, right) =>
			(KIND_ORDER[left.kind] ?? 9) - (KIND_ORDER[right.kind] ?? 9) ||
			left.file.localeCompare(right.file) ||
			left.line - right.line ||
			left.name.localeCompare(right.name)
	);

	const suppressions = sources.reduce(
		(total, { raw }) => total + countSuppressions(raw).total,
		0
	);
	const codeLoc = Math.max(
		sources.reduce((total, { raw }) => total + displayLoc(raw), 0),
		1
	);
	const assertions = options.testSources
		? options.testSources.reduce(
				(accumulated, { sourceFile }) => {
					const result = analyzeAssertions(sourceFile);
					return {
						assertions: accumulated.assertions + result.assertions,
						tests: accumulated.tests + result.testFunctions,
						zero: [...accumulated.zero, ...result.zeroAssertion]
					};
				},
				{ assertions: 0, tests: 0, zero: [] as Array<string> }
			)
		: undefined;

	const functions = rows.filter((row) => row.kind === 'function' || row.kind === 'method');
	const mean = (values: ReadonlyArray<number>): number =>
		values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

	return {
		tsv:
			`${HEADER}\n` +
			rows.map(renderRow).join('\n') +
			(rows.length === 0 ? '' : '\n'),
		summary: {
			functions: functions.length,
			classes: classCount,
			files: sources.length,
			meanCyclomatic: round2(mean(functions.map((row) => row.cyclomatic))),
			p95Cyclomatic: percentile95(functions.map((row) => row.cyclomatic)),
			meanCognitive: round2(mean(functions.map((row) => row.cognitive))),
			meanMaintainability: round2(mean(functions.map((row) => row.maintainabilityIndex))),
			suppressionsPerKloc: round2((suppressions / codeLoc) * 1000),
			assertionsPerTest:
				assertions === undefined || assertions.tests === 0
					? undefined
					: round2(assertions.assertions / assertions.tests),
			zeroAssertionTests: assertions?.zero ?? [],
			rows: rows.length
		}
	};
}
