import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory containing scan.mjs and tenant/ (resolved from this module at runtime). */
const TOOL_ROOT = dirname(fileURLToPath(import.meta.url));

const ERROR_CATEGORIES = new Set([
	'unused_files',
	'unused_dependencies',
	'unused_dev_dependencies',
	'unused_optional_dependencies',
	'unlisted_dependencies',
	'unresolved_imports',
	'circular_dependencies',
	're_export_cycles',
	'boundary_violations',
	'policy_violations'
]);

const DEAD_CODE_FINDING_CATEGORIES = new Set([
	'unused_files',
	'unused_exports',
	'unused_types',
	'private_type_leaks',
	'unused_dependencies',
	'unused_dev_dependencies',
	'unused_optional_dependencies',
	'unused_enum_members',
	'unused_class_members',
	'unresolved_imports',
	'unlisted_dependencies',
	'duplicate_exports',
	'type_only_dependencies',
	'test_only_dependencies',
	'dev_dependencies_in_production',
	'circular_dependencies',
	're_export_cycles',
	'boundary_violations',
	'policy_violations',
	'stale_suppressions'
]);

export type QualityAuditOptions = {
	root: string;
	diagnosisDir?: string;
	show?: string;
	refresh?: boolean;
	maxFindings?: number;
	format?: 'human' | 'json';
};

export type QualityAuditResult = {
	verdict: string;
	summary: unknown;
	findings: unknown[];
	bounded: unknown;
};

type NormalizedOptions = {
	root: string;
	diagnosisDir: string;
	show?: string;
	refresh: boolean;
	maxFindings: number;
	format: 'human' | 'json';
};

type Finding = {
	source: string;
	category: string;
	ruleId: string | null;
	severity: string;
	confidence: string | null;
	summary: string;
	file: string | null;
	line: number | null;
	evidence: unknown;
};

type AuditReport = {
	schemaVersion: number;
	kind: string;
	generatedAt?: string;
	root: string;
	verdict: string;
	summary: ReturnType<typeof countFindings>;
	findings: Finding[];
	scanner: unknown;
	fallow: unknown;
};

type BoundedReport = {
	schemaVersion: number;
	kind: string;
	verdict: string;
	query?: string;
	summary: ReturnType<typeof countFindings>;
	findings: Finding[];
	omittedFindings: number;
	diagnosisDir: string;
	artifacts: Record<string, string>;
};

function normalizeOptions(options: QualityAuditOptions): NormalizedOptions {
	const root = resolve(options.root);
	return {
		root,
		diagnosisDir: options.diagnosisDir
			? isAbsolute(options.diagnosisDir)
				? options.diagnosisDir
				: resolve(root, options.diagnosisDir)
			: join(root, '.norbital/diagnosis/quality-audit'),
		show: options.show,
		refresh: options.refresh ?? false,
		maxFindings: options.maxFindings ?? 30,
		format: options.format ?? 'human'
	};
}

function run(
	command: string,
	args: string[],
	runOptions: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			cwd: runOptions.cwd,
			env: runOptions.env,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on('error', reject);
		child.on('close', (exitCode) => resolvePromise({ exitCode, stdout, stderr }));
	});
}

function loadFallow(): {
	detectDeadCode: (options: {
		root: string;
		configPath: string;
		noCache: boolean;
	}) => Promise<Record<string, unknown>>;
	detectDuplication: (options: {
		root: string;
		configPath: string;
		noCache: boolean;
	}) => Promise<{ clone_groups?: unknown[] }>;
	computeHealth: (options: {
		root: string;
		configPath: string;
		noCache: boolean;
	}) => Promise<{ findings?: unknown[] }>;
} {
	const require = createRequire(import.meta.url);
	return require('@fallow-cli/fallow-node');
}

async function atomicJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, '\t')}\n`);
	await rename(temporary, path);
}

function displayedPath(root: string, targetPath: string): string {
	const local = relative(root, targetPath);
	return local && !local.startsWith('..') ? local : targetPath;
}

function findingText(value: unknown): string {
	if (typeof value === 'string') return value;
	return JSON.stringify(value);
}

function findingFile(value: Record<string, unknown> | null | undefined): string | null {
	if (!value || typeof value !== 'object') return null;
	const importedFrom = value.imported_from as Array<{ path?: string }> | undefined;
	const locations = value.locations as Array<{ path?: string }> | undefined;
	const instances = value.instances as Array<{ file?: string }> | undefined;
	return (
		(value.path as string | undefined) ??
		(value.file as string | undefined) ??
		(value.from_path as string | undefined) ??
		importedFrom?.[0]?.path ??
		locations?.[0]?.path ??
		instances?.[0]?.file ??
		null
	);
}

function normalizeScanner(scanner: {
	findings?: Array<{
		ruleId?: string;
		severity?: string;
		confidence?: string;
		summary?: string;
		file?: string;
		line?: number;
		evidence?: unknown;
		text?: unknown;
		location?: unknown;
	}>;
}): Finding[] {
	return (Array.isArray(scanner.findings) ? scanner.findings : []).map((finding) => ({
		source: 'norbital',
		category: finding.ruleId ?? 'scanner',
		ruleId: finding.ruleId ?? null,
		severity: finding.severity ?? 'warning',
		confidence: finding.confidence ?? null,
		summary: finding.summary ?? 'Norbital scanner finding',
		file: finding.file ?? null,
		line: finding.line ?? null,
		evidence: finding.evidence ?? finding.text ?? finding.location ?? null
	}));
}

function normalizeFallow(
	deadCode: Record<string, unknown>,
	duplication: { clone_groups?: Array<Record<string, unknown>> },
	health: { findings?: Array<Record<string, unknown>> }
): Finding[] {
	const findings: Finding[] = [];
	for (const [category, values] of Object.entries(deadCode)) {
		if (!DEAD_CODE_FINDING_CATEGORIES.has(category) || !Array.isArray(values)) continue;
		for (const value of values) {
			const record = value as Record<string, unknown>;
			findings.push({
				source: 'fallow',
				category,
				ruleId: null,
				severity: ERROR_CATEGORIES.has(category) ? 'error' : 'warning',
				confidence: 'high',
				summary: category.replaceAll('_', ' '),
				file: findingFile(record),
				line: (record.line as number | undefined) ?? (record.start_line as number | undefined) ?? null,
				evidence: findingText(value)
			});
		}
	}
	for (const group of duplication.clone_groups ?? []) {
		const instances = group.instances as Array<{ file?: string; start_line?: number }> | undefined;
		findings.push({
			source: 'fallow',
			category: 'duplication',
			ruleId: null,
			severity: 'warning',
			confidence: 'high',
			summary: `duplicate code (${(group.line_count as number | undefined) ?? 0} lines, ${instances?.length ?? 0} instances)`,
			file: instances?.[0]?.file ?? null,
			line: instances?.[0]?.start_line ?? null,
			evidence: findingText(group)
		});
	}
	for (const finding of health.findings ?? []) {
		findings.push({
			source: 'fallow',
			category: 'health',
			ruleId: null,
			severity: finding.severity === 'error' ? 'error' : 'warning',
			confidence: 'high',
			summary: `${(finding.name as string | undefined) ?? 'function'} exceeds ${(finding.exceeded as string | undefined) ?? 'health threshold'}`,
			file: (finding.path as string | undefined) ?? null,
			line: (finding.line as number | undefined) ?? null,
			evidence: findingText(finding)
		});
	}
	return findings;
}

function countFindings(findings: Finding[]) {
	const counts = { error: 0, warning: 0, hint: 0 };
	for (const finding of findings) {
		if (finding.severity in counts) {
			counts[finding.severity as keyof typeof counts] += 1;
		}
	}
	return { ...counts, actionable: counts.error + counts.warning, total: findings.length };
}

function verdict(counts: ReturnType<typeof countFindings>): string {
	return counts.error > 0 ? 'fail' : counts.warning > 0 ? 'warn' : 'pass';
}

function matchesQuery(finding: Finding, query: string): boolean {
	const needle = query.toLowerCase();
	return [
		finding.source,
		finding.category,
		finding.ruleId,
		finding.severity,
		finding.confidence,
		finding.summary,
		finding.file
	].some((value) =>
		String(value ?? '')
			.toLowerCase()
			.includes(needle)
	);
}

function boundedFinding(finding: Finding): Finding {
	const evidence =
		typeof finding.evidence === 'string' && finding.evidence.length > 500
			? `${finding.evidence.slice(0, 500)}…`
			: finding.evidence;
	return { ...finding, evidence };
}

function boundedReport(report: AuditReport, options: NormalizedOptions): BoundedReport {
	const selected = options.show
		? report.findings.filter((finding) => matchesQuery(finding, options.show!))
		: report.findings;
	return {
		schemaVersion: 1,
		kind: options.show ? 'tenant-quality-audit-query' : 'tenant-quality-audit-summary',
		verdict: verdict(countFindings(selected)),
		query: options.show,
		summary: countFindings(selected),
		findings: selected.slice(0, options.maxFindings).map(boundedFinding),
		omittedFindings: Math.max(0, selected.length - options.maxFindings),
		diagnosisDir: displayedPath(options.root, options.diagnosisDir),
		artifacts: {
			summary: displayedPath(options.root, join(options.diagnosisDir, 'summary.json')),
			report: displayedPath(options.root, join(options.diagnosisDir, 'report.json')),
			findings: displayedPath(options.root, join(options.diagnosisDir, 'findings.jsonl')),
			scanner: displayedPath(options.root, join(options.diagnosisDir, 'scanner.json')),
			fallow: displayedPath(options.root, join(options.diagnosisDir, 'fallow.json'))
		}
	};
}

async function writeReports(
	report: AuditReport,
	bounded: BoundedReport,
	options: NormalizedOptions
): Promise<void> {
	await mkdir(options.diagnosisDir, { recursive: true });
	await Promise.all([
		atomicJson(join(options.diagnosisDir, 'summary.json'), bounded),
		atomicJson(join(options.diagnosisDir, 'report.json'), report),
		atomicJson(join(options.diagnosisDir, 'scanner.json'), report.scanner),
		atomicJson(join(options.diagnosisDir, 'fallow.json'), report.fallow),
		writeFile(
			join(options.diagnosisDir, 'findings.jsonl'),
			report.findings.map((finding) => JSON.stringify(finding)).join('\n') +
				(report.findings.length ? '\n' : '')
		)
	]);
}

async function fallowConfig(root: string, diagnosisDir: string): Promise<string> {
	const projectConfig = ['.fallowrc.jsonc', '.fallowrc.json', 'fallow.toml', '.fallow.toml']
		.map((name) => join(root, name))
		.find(existsSync);
	if (projectConfig) return projectConfig;

	const source = join(TOOL_ROOT, 'tenant/fallow.jsonc');
	const config = JSON.parse(await readFile(source, 'utf8')) as {
		rulePacks?: string[];
	};
	const runtimeDir = join(diagnosisDir, 'runtime');
	await mkdir(runtimeDir, { recursive: true });
	const rulePacks: string[] = [];
	for (const packPath of config.rulePacks ?? []) {
		const sourcePath = isAbsolute(packPath) ? packPath : resolve(TOOL_ROOT, packPath);
		const generatedPath = join(runtimeDir, `fallow.${rulePacks.length}.policy.jsonc`);
		await writeFile(generatedPath, await readFile(sourcePath));
		rulePacks.push(relative(root, generatedPath));
	}
	config.rulePacks = rulePacks;
	const generated = join(runtimeDir, 'fallow.config.json');
	await atomicJson(generated, config);
	return generated;
}

async function runAudit(
	options: NormalizedOptions
): Promise<{ report: AuditReport; bounded: BoundedReport }> {
	const configPath = await fallowConfig(options.root, options.diagnosisDir);
	const scannerScript = join(TOOL_ROOT, 'scan.mjs');
	const scannerPromise = run(process.execPath, [scannerScript, '--all', '--format', 'json'], {
		cwd: options.root,
		env: {
			...process.env,
			STUPIDITY_ROOT: options.root,
			STUPIDITY_CATALOG_DIR: join(options.diagnosisDir, 'scanner')
		}
	});
	const { detectDeadCode, detectDuplication, computeHealth } = loadFallow();
	const shared = { root: options.root, configPath, noCache: true };
	const [scannerResult, deadCode, duplication, health] = await Promise.all([
		scannerPromise,
		detectDeadCode(shared),
		detectDuplication(shared),
		computeHealth(shared)
	]);
	if ((scannerResult.exitCode ?? 1) > 1) {
		throw new Error(scannerResult.stderr || 'Norbital scanner failed');
	}
	let scanner: Parameters<typeof normalizeScanner>[0];
	try {
		scanner = JSON.parse(scannerResult.stdout);
	} catch (cause) {
		throw new Error(
			`Norbital scanner returned invalid JSON: ${scannerResult.stdout.slice(0, 500)}`,
			{ cause }
		);
	}
	const findings = [
		...normalizeScanner(scanner),
		...normalizeFallow(deadCode, duplication, health)
	].sort((left, right) => {
		const rank: Record<string, number> = { error: 0, warning: 1, hint: 2 };
		return (
			(rank[left.severity] ?? 3) - (rank[right.severity] ?? 3) ||
			left.source.localeCompare(right.source) ||
			left.category.localeCompare(right.category) ||
			String(left.file ?? '').localeCompare(String(right.file ?? '')) ||
			(left.line ?? 0) - (right.line ?? 0)
		);
	});
	const counts = countFindings(findings);
	const report: AuditReport = {
		schemaVersion: 1,
		kind: 'tenant-quality-audit',
		generatedAt: new Date().toISOString(),
		root: options.root,
		verdict: verdict(counts),
		summary: counts,
		findings,
		scanner,
		fallow: { deadCode, duplication, health }
	};
	const bounded = boundedReport(report, options);
	await writeReports(report, bounded, options);
	return { report, bounded };
}

async function latestReport(options: NormalizedOptions): Promise<AuditReport> {
	const reportPath = join(options.diagnosisDir, 'report.json');
	if (!existsSync(reportPath)) {
		throw new Error(`No quality diagnosis found at ${reportPath}; run the audit first`);
	}
	return JSON.parse(await readFile(reportPath, 'utf8')) as AuditReport;
}

export async function runQualityAudit(options: QualityAuditOptions): Promise<QualityAuditResult> {
	const normalized = normalizeOptions(options);
	const result =
		options.show && !options.refresh
			? { report: await latestReport(normalized) }
			: await runAudit(normalized);
	const bounded =
		'bounded' in result && result.bounded
			? result.bounded
			: boundedReport(result.report, normalized);
	return {
		verdict: bounded.verdict,
		summary: bounded.summary,
		findings: bounded.findings,
		bounded
	};
}
