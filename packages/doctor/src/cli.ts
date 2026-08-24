#!/usr/bin/env node
/**
 * `norbital-doctor` — run the audit from a terminal or a CI job.
 *
 * Exit codes are the contract, and they are three-valued on purpose:
 *
 * - 0 the gate completed with no actionable debt
 * - 1 the analysis is valid and found actionable debt (not a crash)
 * - 2 the evidence is incomplete, stale, or invalid — do not read scores from this run
 *
 * Collapsing 1 and 2 would let a scan that never produced evidence read as a clean pass, which is
 * the failure this tool exists to prevent.
 */
import { assess, audit, type Severity } from './index.js';

const argv = process.argv.slice(2);
const command = argv[0]?.startsWith('-') === false ? argv[0] : 'audit';
const options = command === 'audit' && argv[0] !== 'audit' ? argv : argv.slice(1);
const flag = (name: string) => options.includes(`--${name}`);
const value = (name: string) => {
	const index = options.indexOf(`--${name}`);
	return index < 0 ? undefined : options[index + 1];
};
const values = (name: string) =>
	options.flatMap((argument, index) =>
		argument === `--${name}` ? [options[index + 1] ?? ''] : []
	);

const usage = [
	'norbital-doctor <command> [options]',
	'',
	'Commands:',
	'  audit    scan one repository and print its findings (default)',
	'  assess   scan every --root and emit one consolidated report',
	'',
	'Options:',
	'  --root <path>     repository to analyse; repeat for assess (default: cwd)',
	'  --include-tests   include test and e2e sources in scope',
	'  --path <path>     restrict the scan to a repository-relative path; repeatable',
	'  --out <path>      write the consolidated report here (assess only)',
	'  --format <fmt>    assess only: json, markdown, or both',
	'  --json            emit JSON instead of a summary',
	'',
	'Exit: 0 clean · 1 actionable debt · 2 evidence incomplete or invalid',
	''
].join('\n');

const ORDER: ReadonlyArray<Severity> = ['error', 'hint'];

async function main(): Promise<void> {
	const valueOptions = new Set(['--root', '--path', '--out', '--format']);
	const booleanOptions = new Set(['--include-tests', '--json', '--help']);
	for (let index = 0; index < options.length; index += 1) {
		const argument = options[index] ?? '';
		if (booleanOptions.has(argument)) continue;
		if (valueOptions.has(argument)) {
			const next = options[index + 1];
			if (next === undefined || next.startsWith('-')) throw new Error(`${argument} needs a value`);
			index += 1;
			continue;
		}
		throw new Error(`unknown argument "${argument}"`);
	}
	if (command === 'audit' && flag('out')) throw new Error('--out is assess-only');
	if (command === 'audit' && flag('format')) throw new Error('--format is assess-only');
	const format = value('format');
	if (format !== undefined && !['json', 'markdown', 'both'].includes(format))
		throw new Error('--format must be json, markdown, or both');

	if (command === 'help' || flag('help')) {
		process.stdout.write(usage);
		return;
	}

	const shared = {
		includeTests: flag('include-tests'),
		paths: values('path')
	};

	if (command === 'assess') {
		const roots = values('root');
		const result = await assess({
			...shared,
			roots: roots.length ? roots : undefined,
			out: value('out'),
			format: value('format') as 'json' | 'markdown' | 'both' | undefined
		});
		process.stdout.write(result.report);
		if (result.stderr) process.stderr.write(result.stderr);
		process.exitCode = result.status;
		return;
	}

	if (command !== 'audit') {
		process.stderr.write(`norbital-doctor: unknown command "${command}"\n\n${usage}`);
		process.exitCode = 2;
		return;
	}

	const result = await audit({ ...shared, root: value('root') });
	if (flag('json')) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		const tiers = (['syntactic', 'graph', 'typeAware'] as const)
			.filter((tier) => result.receipt.tiers[tier])
			.map((tier) => (tier === 'typeAware' ? 'type-aware' : tier))
			.join(' + ');
		const summary = ORDER.map((severity) => `${result.counts[severity]} ${severity}`).join(', ');
		process.stdout.write(`norbital-doctor: ${summary} across ${result.receipt.files} files\n`);
		process.stdout.write(`tiers: ${tiers}\n`);
		if (result.packs.length > 0) process.stdout.write(`packs: ${result.packs.join(', ')}\n`);
		if (result.authoredFindings > 0)
			process.stdout.write(`authored rules contributed ${result.authoredFindings} finding(s)\n`);
		if (!result.receipt.tiers.graph)
			process.stdout.write(
				'note: no built-in detector (base: none), so reachability, dead exports, and cycles are unevaluated\n'
			);

		for (const finding of result.findings
			.filter(({ severity }) => severity !== 'hint')
			.slice(0, 40))
			process.stdout.write(`  ${finding.severity} ${finding.rule}  ${finding.location}\n`);
		process.stdout.write(`catalogue: ${result.cataloguePath}\n`);
	}
	process.exitCode = result.counts.error > 0 ? 1 : 0;
}

await main().catch((error: unknown) => {
	process.stderr.write(
		`norbital-doctor: ${error instanceof Error ? error.message : String(error)}\n`
	);
	process.exitCode = 2;
});
