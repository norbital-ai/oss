import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { SCANNER_VERSION } from './analysis/authenticate.js';
import type { Finding, Receipt, Severity } from './index.js';

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { error: 0, hint: 1 };
const CONFIDENCE_RANK = { high: 0, medium: 1 } as const;
const PRINCIPLES = [
	'simplicity',
	'straightforwardness',
	'modularity',
	'testability',
	'efficiency',
	'type-safety',
	'colocation',
	'no-bloat'
] as const;

const digest = (value: string | Buffer): string =>
	`sha256:${createHash('sha256').update(value).digest('hex')}`;

const principleKey = (principle: (typeof PRINCIPLES)[number]): string => {
	if (principle === 'no-bloat') return 'noBloat';
	if (principle === 'type-safety') return 'typeSafety';
	return principle;
};

function findingCounts(findings: ReadonlyArray<Finding>): Receipt['counts'] {
	const principles = Object.fromEntries(
		PRINCIPLES.map((principle) => [principleKey(principle), 0])
	);
	const counts = { error: 0, warning: 0, hint: 0, total: findings.length, principles };
	for (const finding of findings) {
		counts[finding.severity] += 1;
		for (const principle of PRINCIPLES)
			if (finding.principles.includes(principle)) {
				const key = principleKey(principle);
				principles[key] = (principles[key] ?? 0) + 1;
			}
	}
	return counts;
}

function catalogueBytes(findings: ReadonlyArray<Finding>): string {
	const sorted = [...findings].sort(
		(left, right) =>
			SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
			CONFIDENCE_RANK[left.confidence] - CONFIDENCE_RANK[right.confidence] ||
			left.rule.localeCompare(right.rule) ||
			left.location.localeCompare(right.location)
	);
	return (
		sorted
			.map((finding) =>
				[
					finding.severity,
					finding.confidence,
					finding.rule,
					finding.summary,
					finding.location,
					finding.principles.join(',')
				]
					.map((column) => column.replace(/[\t\r\n]/g, ' '))
					.join('\t')
			)
			.join('\n') + (sorted.length === 0 ? '' : '\n')
	);
}

function atomicWrite(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, contents);
	renameSync(temporary, path);
}

function configurationDirectories(root: string, file: string): ReadonlyArray<string> {
	const directories: string[] = [];
	let directory = dirname(join(root, file));
	while (directory === root || directory.startsWith(`${root}${sep}`)) {
		directories.push(directory);
		if (directory === root) break;
		directory = dirname(directory);
	}
	return directories;
}

function configurationPaths(root: string, file: string): ReadonlyArray<string> {
	return configurationDirectories(root, file).flatMap((directory) =>
		['package.json', 'tsconfig.json', 'jsconfig.json'].map((name) => join(directory, name))
	);
}

function sourceInventoryDigest(root: string, files: ReadonlyArray<string>): string {
	const inventory = new Set(files);
	if (existsSync(join(root, '.doctorignore'))) inventory.add('.doctorignore');
	for (const file of files) {
		for (const path of configurationPaths(root, file)) {
			if (existsSync(path)) inventory.add(relative(root, path).split(sep).join('/'));
		}
	}
	const records = [...inventory]
		.sort()
		.map((file) => `${file}\0${digest(readFileSync(join(root, file))).slice(7)}\n`)
		.join('');
	return digest(records);
}

type PublishEvidenceOptions = Readonly<{
	root: string;
	findings: ReadonlyArray<Finding>;
	authoredRuleSetDigest: string;
	allFiles?: ReadonlyArray<string> | undefined;
	selectedFileCount?: number | undefined;
	/** Whether the whole-repository pass ran; it is part of the neutral baseline, so effectively always. */
	graph?: boolean | undefined;
	/** Whether the type-aware tier had anything to build a program from. */
	typeAware?: boolean | undefined;
	scope?: 'all' | 'path' | undefined;
	includeTests?: boolean | undefined;
	existing?: Receipt | undefined;
}>;

export function publishEvidence(options: PublishEvidenceOptions): Receipt {
	const directory = join(options.root, '.norbital/diagnosis');
	const cataloguePath = join(directory, 'findings.tsv');
	const catalogue = catalogueBytes(options.findings);
	atomicWrite(cataloguePath, catalogue);

	const existing = options.existing;
	const receipt: Receipt = existing
		? {
				...existing,
				ruleSetDigest: digest(`${existing.ruleSetDigest}\n${options.authoredRuleSetDigest}`),
				catalogueDigest: digest(catalogue),
				counts: findingCounts(options.findings)
			}
		: {
				schemaVersion: 6,
				kind: 'repository-health-static-receipt',
				scannerVersion: SCANNER_VERSION,
				root: realpathSync(options.root),
				scope: options.scope ?? 'all',
				includeTests: options.includeTests ?? false,
				// Every tier records what it did honestly: `graph` is part of the neutral baseline,
				// and `typeAware` false means the selection held no file a program can contain.
				tiers: {
					syntactic: true,
					graph: options.graph ?? true,
					typeAware: options.typeAware ?? false
				},
				files: options.selectedFileCount ?? options.allFiles?.length ?? 0,
				findings: 'findings.tsv',
				sourceInventoryDigest: sourceInventoryDigest(options.root, options.allFiles ?? []),
				ruleSetDigest: options.authoredRuleSetDigest,
				catalogueDigest: digest(catalogue),
				counts: findingCounts(options.findings),
				complete: true
			};
	atomicWrite(join(directory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
	return receipt;
}
