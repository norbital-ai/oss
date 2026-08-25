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
import { parseArgs } from 'node:util';

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
	const { positionals, values: options } = parseArgs({
		options: {
			root: { type: 'string', multiple: true },
			path: { type: 'string', multiple: true },
			out: { type: 'string' },
			format: { type: 'string' },
			'include-tests': { type: 'boolean' },
			json: { type: 'boolean' },
			help: { type: 'boolean' }
		},
		allowPositionals: true,
		strict: true
	});
	if (positionals.length > 1) throw new Error(`unexpected command argument "${positionals[1]}"`);
	const command = positionals[0] ?? 'audit';
	if (command === 'audit' && options.out !== undefined) throw new Error('--out is assess-only');
	if (command === 'audit' && options.format !== undefined)
		throw new Error('--format is assess-only');
	if (command === 'audit' && (options.root?.length ?? 0) > 1)
		throw new Error('--root may be repeated only for assess');
	const format = options.format;
	if (format !== undefined && !['json', 'markdown', 'both'].includes(format))
		throw new Error('--format must be json, markdown, or both');

	if (command === 'help' || options.help === true) {
		process.stdout.write(usage);
		return;
	}

	const shared = {
		includeTests: options['include-tests'] ?? false,
		paths: options.path ?? []
	};

	if (command === 'assess') {
		const roots = options.root ?? [];
		const result = await assess({
			...shared,
			roots: roots.length ? roots : undefined,
			out: options.out,
			format: options.format as 'json' | 'markdown' | 'both' | undefined
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

	const result = await audit({ ...shared, root: options.root?.[0] });
	if (options.json === true) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		const tiers = (['syntactic', 'graph', 'typeAware', 'semantic'] as const)
			.filter((tier) => result.receipt.tiers[tier])
			.map((tier) => (tier === 'typeAware' ? 'type-aware' : tier))
			.join(' + ');
		const summary = ORDER.map((severity) => `${result.counts[severity]} ${severity}`).join(', ');
		process.stdout.write(`norbital-doctor: ${summary} across ${result.receipt.files} files\n`);
		process.stdout.write(`tiers: ${tiers}\n`);
		if (result.packs.length > 0) process.stdout.write(`packs: ${result.packs.join(', ')}\n`);
		if (result.authoredFindings > 0)
			process.stdout.write(`authored rules contributed ${result.authoredFindings} finding(s)\n`);
		if (result.semantic.ran) {
			const spend = result.semantic.stats;
			const bill =
				spend === undefined
					? ''
					: ` · ${spend.filesEmbedded} embedded, ${spend.filesUnchanged} reused, ${spend.apiRequests} request(s)` +
						(spend.promptTokens === undefined ? '' : `, ${spend.promptTokens} tokens`) +
						(spend.costUsd === undefined ? '' : `, $${spend.costUsd.toFixed(4)}`) +
						` in ${Math.round(spend.durationMs)}ms`;
			process.stdout.write(
				`semantic: ${result.semantic.embedderId ?? 'unknown'} · ${result.semantic.clusterCount} clusters, ${result.semantic.singletonCount} singletons${bill}
`
			);
		} else {
			process.stdout.write('semantic: declined by configuration\n');
		}

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
