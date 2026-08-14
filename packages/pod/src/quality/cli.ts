#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runQualityAudit, type QualityAuditOptions } from './audit.js';

function usage(): void {
	console.log(`Usage: pod quality [options]

Options:
  --root <path>                 Workspace to audit (default: current directory).
  --diagnosis-dir <path>        Report directory (default: <root>/.norbital/diagnosis/quality-audit).
  --show <query>                Query the latest findings without rescanning.
  --refresh                     Rescan before applying --show.
  --max-findings <count>        Findings returned in the bounded summary (default: 30).
  --format <human|json>         Summary output format (default: human).
  --help                        Show this help.`);
}

function positiveInteger(value: string | undefined, option: string): number {
	if (!/^\d+$/.test(value ?? '') || Number(value) < 1) {
		throw new Error(`${option} needs a positive integer`);
	}
	return Number(value);
}

function parseArgs(argv: readonly string[]): QualityAuditOptions {
	const options: QualityAuditOptions = {
		root: process.cwd(),
		diagnosisDir: undefined,
		show: undefined,
		refresh: false,
		maxFindings: 30,
		format: 'human'
	};
	for (let index = 0; index < argv.length; index += 1) {
		switch (argv[index]) {
			case '--root':
				options.root = argv[++index];
				if (!options.root) throw new Error('--root needs a path');
				break;
			case '--diagnosis-dir':
				options.diagnosisDir = argv[++index];
				if (!options.diagnosisDir) throw new Error('--diagnosis-dir needs a path');
				break;
			case '--show':
				options.show = argv[++index];
				if (!options.show) throw new Error('--show needs a query');
				break;
			case '--refresh':
				options.refresh = true;
				break;
			case '--max-findings':
				options.maxFindings = positiveInteger(argv[++index], '--max-findings');
				break;
			case '--format':
				options.format = argv[++index] as QualityAuditOptions['format'];
				if (options.format !== 'human' && options.format !== 'json') {
					throw new Error('--format needs human or json');
				}
				break;
			case '--help':
			case '-h':
				usage();
				process.exit(0);
			default:
				throw new Error(`unknown option: ${argv[index]}`);
		}
	}
	options.root = resolve(options.root);
	return options;
}

function renderHuman(report: {
	verdict: string;
	summary: { error: number; warning: number; hint: number; total: number };
	query?: string;
	findings: Array<{
		severity: string;
		source: string;
		category: string;
		summary: string;
		file: string | null;
		line: number | null;
	}>;
	omittedFindings?: number;
	diagnosisDir: string;
}): void {
	console.log(
		`quality audit: ${report.verdict} — ${report.summary.error} errors, ${report.summary.warning} warnings, ${report.summary.hint} hints`
	);
	if (report.query) console.log(`query: ${report.query} — ${report.summary.total} matches`);
	for (const finding of report.findings) {
		const location = finding.file
			? `${finding.file}${finding.line ? `:${finding.line}` : ''}`
			: '(workspace)';
		console.log(
			`  [${finding.severity} ${finding.source}/${finding.category}] ${finding.summary} — ${location}`
		);
	}
	if (report.omittedFindings) console.log(`  … ${report.omittedFindings} more findings`);
	console.log(`diagnosis: ${report.diagnosisDir}`);
}

export async function runQualityCli(
	args: readonly string[] = process.argv.slice(2)
): Promise<number> {
	let options: QualityAuditOptions | undefined;
	try {
		options = parseArgs(args);
		const result = await runQualityAudit(options);
		const bounded = result.bounded as Parameters<typeof renderHuman>[0];
		if (options.format === 'json') console.log(JSON.stringify(result.bounded, null, 2));
		else renderHuman(bounded);
		if (!options.show && result.verdict !== 'pass') return 1;
		return 0;
	} catch (error) {
		console.error(`quality-audit: ${error instanceof Error ? error.message : String(error)}`);
		if (!options) usage();
		return 2;
	}
}

if (process.argv[1] != null && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runQualityCli().then(
		(code) => {
			process.exitCode = code;
		},
		(error: unknown) => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 2;
		}
	);
}
