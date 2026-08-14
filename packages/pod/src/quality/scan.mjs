#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
	readFileSync,
	mkdirSync,
	renameSync,
	writeFileSync,
	existsSync,
	unlinkSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const RULES = new Map(
	[
		['R1', 'error', 'high', 'any in a signature or annotation'],
		['R3a', 'warning', 'high', 'cast to Record<string, unknown>'],
		['R3b', 'error', 'high', 'unapproved double cast'],
		['R3c', 'hint', 'medium', 'blind named-type cast'],
		['R3e', 'warning', 'medium', 'single cast to unknown'],
		['R3f', 'error', 'high', 'explicit cast to any'],
		['R5b', 'warning', 'high', 'hand-rolled type predicate'],
		['R5c', 'hint', 'medium', 'multi-field duck typing'],
		['R5d', 'hint', 'medium', 'in-operator duck typing'],
		['R6a', 'error', 'high', 'JSON.parse followed by a cast'],
		['R6b', 'warning', 'medium', 'JSON.parse without visible validation'],
		['R7', 'warning', 'high', 'database typing collapsed to unknown'],
		['CLONE', 'error', 'high', 'JSON stringify/parse clone'],
		['AL1', 'hint', 'high', 'bare type alias'],
		['AL2', 'hint', 'high', 'primitive type alias'],
		['AL3', 'hint', 'high', 'loose-record type alias'],
		['AL4', 'warning', 'high', 'hand-written type beside a matching zod schema'],
		['AL5', 'warning', 'high', 'redeclared type shape; own one schema and infer'],
		['S1', 'warning', 'high', 'silent catch block'],
		['S3', 'hint', 'high', 'verbose null and undefined check'],
		['S5', 'hint', 'high', 'Array.from(new Set(...))'],
		['D1', 'warning', 'high', 'duplicate non-trivial function body'],
		['D2', 'warning', 'high', 'conditional has identical branches'],
		['STD1', 'warning', 'medium', 'local helper duplicates @norbital-ai/std'],
		['STD2', 'warning', 'high', 'hand-rolled timer promise duplicates std async helpers'],
		['Q1', 'warning', 'high', 'pass-through or get-or-throw wrapper function'],
		['Q2', 'warning', 'high', 'file shorter than 40 lines'],
		['E3', 'warning', 'high', 'env get-or-throw or re-validation wrapper'],
		['Q3', 'warning', 'high', 'one-off function is only referenced once'],
		['Q4', 'warning', 'high', 'function, class, or method is shorter than 10 lines'],
		['Q5', 'warning', 'high', 'function, class, or method has no documentation comment'],
		['P1', 'hint', 'high', 'god file over 500 lines'],
		['P9', 'hint', 'high', 'export-star barrel'],
		['A1', 'warning', 'medium', 'discarded timer requires cleanup review'],
		['A5', 'hint', 'high', 'catch only rethrows'],
		['A6', 'warning', 'medium', 'await inside a synchronous loop'],
		['E1', 'warning', 'high', 'environment-dependent behavior'],
		['E2', 'hint', 'high', 'feature flag declared in source'],
		['V1', 'warning', 'high', '$effect is last-resort external sync; prefer $derived or {@attach}'],
		['V14', 'warning', 'high', 'plain let/var in a rune module should be $state'],
		['V15', 'warning', 'high', 'computed binding in a rune module should be $derived'],
		['V16', 'error', 'high', 'Svelte 4 $: reactive statement'],
		['V17', 'error', 'high', 'Svelte 4 export let; use $props()'],
		['V3', 'error', 'high', 'Svelte 4 event directive'],
		['V4', 'error', 'high', 'store imported in .svelte'],
		['V5', 'error', 'high', 'async onMount cannot return cleanup'],
		['V6', 'warning', 'high', 'async IIFE in lifecycle code'],
		['V7', 'error', 'high', 'async $effect'],
		['V8', 'warning', 'medium', 'component owns too many independent state cells'],
		['V9', 'warning', 'high', 'watch writes state read by its own source'],
		['V10', 'warning', 'high', 'watch callbacks form a reactive cycle'],
		['V11', 'warning', 'medium', 'mounted flag mirrors lifecycle state'],
		['V12', 'warning', 'medium', 'onDestroy mutates component state'],
		['V13', 'warning', 'high', 'onMount resource has no lifecycle cleanup'],
		['UI1', 'warning', 'high', 'native select bypasses the shared UI controls'],
		['UI2', 'warning', 'high', 'hand-rolled tab semantics bypass shared Tabs'],
		['UI3', 'warning', 'medium', 'repeated native table bypasses a collection renderer'],
		['UI4', 'warning', 'high', 'browser-native dialog bypasses the application UI'],
		['UI5', 'warning', 'high', 'raw overflow scroll region bypasses the Scroll primitive'],
		['UI6', 'warning', 'high', 'raw flex/grid container bypasses the layout primitives'],
		['UI7', 'warning', 'medium', 'sibling margin bypasses the parent gap contract'],
		['UI8', 'warning', 'high', 'literal app inset classes bypass the inset tokens'],
		['UI9', 'warning', 'medium', 'hand-rolled height/overflow scroll chain bypasses Bound+Scroll'],
		['UI10', 'warning', 'high', 'layout/scroll classes on a layout primitive override its props'],
		['UI11', 'warning', 'medium', 'redundant wrapper element adds no layout or boundary'],
		['UI12', 'error', 'high', 'Tailwind arbitrary value built at runtime emits no CSS'],
		['UI13', 'warning', 'high', 'sibling spacing written on the child instead of the parent gap'],
		['UI14', 'warning', 'high', 'measure centred by hand instead of Center'],
		['UI15', 'warning', 'medium', 'fixed layout dimension on a primitive instead of Bound size'],
		['UI16', 'warning', 'high', 'nested scrollports trap wheel events (Scroll/matrix/form)'],
		['UI17', 'warning', 'high', 'template exposes uuid/system id to operators'],
		['UI17a', 'error', 'high', 'collection with uuid columns has no +representation.svelte'],
		['UI17b', 'error', 'high', 'custom-type renderer exposes a uuid field to operators'],
		['UI17c', 'error', 'high', 'recordLabel cannot resolve to a string'],
		['SCAN', 'error', 'high', 'source could not be parsed']
	].map(([id, severity, confidence, summary]) => [id, { id, severity, confidence, summary }])
);

const SEVERITY_RANK = { error: 0, warning: 1, hint: 2 };
const CONFIDENCE_RANK = { high: 0, medium: 1 };
const CANONICAL_STD_HELPERS = new Map(
	[
		'dedup',
		'deepDiff',
		'delay',
		'getErrorMessage',
		'humanize',
		'safeParse',
		'safeStringify',
		'treeFilterLeaves',
		'treeFind',
		'treeFlatten',
		'treeMap',
		'treeReduce',
		'treeWalk',
		'truncate',
		'tryCatch',
		'withAbortableOperation',
		'withTimeout'
	].map((name) => [name, `@norbital-ai/std#${name}`])
);
const BROWSER_DIALOGS = new Set(['alert', 'confirm', 'prompt']);
const MAX_INDEPENDENT_STATE_CELLS = 8;
const MIN_DECLARATION_LINES = 10;
const MIN_FILE_LINES = 40;
const ENTRY_POINT_NAMES = ['main', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const RUNE_CALLEES = new Set(['$state', '$derived', '$props', '$bindable', '$host', '$inspect']);
const RUNE_MEMBERS = new Set(['raw', 'by', 'snapshot', 'eager']);
const KNOWN_GLOBALS = new Set([
	'undefined',
	'NaN',
	'Infinity',
	'Math',
	'Number',
	'String',
	'Boolean',
	'Object',
	'Array',
	'Map',
	'Set',
	'Promise',
	'Date',
	'JSON',
	'Error',
	'Intl',
	'console',
	'document',
	'window',
	'crypto',
	'structuredClone',
	'URL',
	'Reflect'
]);
const MOUNTED_FLAG = /^(?:mounted|isMounted|hasMounted|didMount)$/i;
const LAYOUT_ELEMENT_NAMES = new Set([
	'div',
	'section',
	'main',
	'aside',
	'header',
	'footer',
	'nav',
	'form',
	'fieldset',
	'ul',
	'ol',
	'dl'
]);
const LAYOUT_CONTROL_NAMES = new Set([
	'button',
	'label',
	'a',
	'input',
	'select',
	'textarea',
	'option',
	'legend'
]);
const LAYOUT_TABLE_NAMES = new Set([
	'table',
	'thead',
	'tbody',
	'tfoot',
	'tr',
	'th',
	'td',
	'caption'
]);
const LAYOUT_MEDIA_NAMES = new Set(['img', 'picture', 'video', 'canvas', 'progress', 'svg']);
const RAW_SCROLL_REGION_PATTERN = /\boverflow(?:-[xy])?-(?:auto|scroll)\b/;
const RAW_CLIP_REGION_PATTERN = /\boverflow(?:-[xy])?-(?:hidden|clip)\b/;
/** Text truncation, media crops, explicit clip-paths, and sr-only are not clip wrappers. */
const CLIP_EXEMPT_HINT_PATTERN =
	/\b(?:truncate|line-clamp|text-ellipsis|overflow-ellipsis|whitespace-nowrap|aspect|object|sr-only|clip-path)/;
/** Fixed-size boxes with clipping are media thumbnails, not clip regions. */
const CLIP_EXEMPT_FIXED_SIZE = /\b(?:size-(?:[0-9]|\[)|h-(?:[0-9]|\[)|w-(?:[0-9]|\[)|max-h-\[)/;
const RAW_LAYOUT_FLEX_PATTERN = /\bflex(?:-col|-row)?\b|\bflex-1\b/;
const RAW_LAYOUT_GRID_PATTERN = /\bgrid\b(?!-)/;
const LAYOUT_COMPOSITION_HINT_PATTERN =
	/\b(?:gap|space-[xy]|justify-|items-|grid-cols-|grid-rows-|content-|place-|basis-|flex-col|flex-row|flex-1)-/;
/** Strong sibling-arrangement signals; weak alignment hints (items-/justify-*) alone describe a chip. */
const LAYOUT_SIBLING_HINT_PATTERN =
	/\b(?:gap-|space-[xy]-|grid-cols-|grid-rows-|content-|place-|basis-|flex-col|flex-row|flex-1)/;
const ELEMENT_SIZE_PATTERN = /\b(?:size-|h-|w-|min-h-|min-w-)\S+/;
const SIBLING_MARGIN_PATTERN = /\bspace-[xy]-[0-9]|m[tblr]-(?:[2-9]|1[0-9])(?:\.5)?(?:$|\s)/;
const LITERAL_INSET_PATTERN = /\bpx-4 py-2 sm:px-6\b|\bpx-4 sm:px-6\b|\bmx-4 sm:mx-6\b/;
const SCROLL_CHAIN_PATTERN = /\boverflow(?:-[xy])?-(?:auto|scroll|hidden)\b/;
const LAYOUT_PRIMITIVE_NAMES = new Set([
	'Stack',
	'Inline',
	'Cluster',
	'Grid',
	'Columns',
	'Column',
	'Split',
	'Cover',
	'Bound',
	'Scroll',
	'Center',
	'Frame'
]);
/** Primitives with a `gap` prop; gap classes on them bypass the prop. */
const LAYOUT_GAP_OWNERS = new Set([
	'Stack',
	'Inline',
	'Cluster',
	'Grid',
	'Columns',
	'Split',
	'Cover'
]);
/** Primitives with align/justify props; align or justify classes on them bypass the props. */
const LAYOUT_ALIGN_OWNERS = new Set(['Stack', 'Inline', 'Cluster']);
const PRIMITIVE_DISPLAY_OVERRIDE =
	/\b(?:flex|flex-col|flex-row|flex-wrap|flex-nowrap|grid)(?=\s|$)/;
const PRIMITIVE_OVERFLOW_OVERRIDE = /\boverflow(?:-[xy])?-(?:auto|scroll|hidden|clip|visible)\b/;
const PRIMITIVE_GAP_OVERRIDE = /\b(?:gap|space-[xy])-[^\s"'`]+/;
// `self-*` positions the primitive as an item in its parent; it does not override how the
// primitive aligns its own children, so it remains a legitimate caller-owned class.
const PRIMITIVE_ALIGN_OVERRIDE = /\b(?:items-|justify-|place-(?:items|content)-)[a-z-]+/;
const PRIMITIVE_GROWTH_OVERRIDE = /\b(?:flex-1|grow|shrink-0|h-full|h-screen|h-dvh|min-h-full)\b/;
const LAYOUT_GROWTH_OWNERS = new Set(['Stack', 'Inline', 'Cluster', 'Bound', 'Cover', 'Scroll']);
/**
 * Components that own a vertical scrollport. Nesting any of these under `Scroll` (or leaving
 * `MatrixRenderer` at its default `bounded={true}` inside another scroll owner) traps the wheel —
 * the classic "invisible scrollbar" stuck region. `*Form` wrappers that embed `CollectionForm`
 * are included by name suffix below.
 */
const VERTICAL_SCROLL_OWNERS = new Set([
	'Scroll',
	'CollectionForm',
	'CollectionTable',
	'CollectionKanban',
	'Tabs',
	'MatrixRenderer'
]);
const WRAPPER_SOUP_EXEMPT_CLASS = /^\s*(?:contents)?\s*$/;
/** Classes that give a wrapper a structural reason to exist; everything else is transferable to the child. */
const WRAPPER_STRUCTURAL_CLASS =
	/\b(?:flex|grid|overflow|absolute|fixed|sticky|relative|inset-|top-|left-|right-|bottom-|z-|h-|min-h-|max-h-|w-(?!full\b)|min-w-|max-w-|basis-|grow|shrink|contents|divide-|space-[xy]-|aspect-|object-|translate|rotate|scale|transform|transition|animate|pointer-events|container|overscroll|backdrop|isolate|order-|sr-only)\b/;
const RESOURCE_CALLS = new Set(['setInterval', 'setTimeout']);
const RESOURCE_CONSTRUCTORS = new Set([
	'IntersectionObserver',
	'MutationObserver',
	'ResizeObserver'
]);
const RESOURCE_CLEANUPS = new Map([
	['addEventListener', 'removeEventListener'],
	['IntersectionObserver', 'disconnect'],
	['MutationObserver', 'disconnect'],
	['ResizeObserver', 'disconnect'],
	['setInterval', 'clearInterval'],
	['setTimeout', 'clearTimeout']
]);
const MUTATING_METHODS = new Set([
	'add',
	'clear',
	'delete',
	'fill',
	'pop',
	'push',
	'reverse',
	'set',
	'shift',
	'sort',
	'splice',
	'unshift'
]);
function usage() {
	console.log(`Usage: bash .agents/skills/stupidity-scanner/scan.sh [options]

Options:
  --show <rule|severity|confidence|all>  Inspect the latest catalogue without rescanning.
  --refresh                              Rescan before applying --show.
  --all                                  Scan every production source file instead of changed files.
  --path <file-or-directory>             Scan a repository-relative path; repeat as needed.
  --format <human|json>                  Output format (default: human).
  --limit <count>                        Detail rows to show (default: 20).
  --summary-limit <count>                Decision-brief groups (default: 8).
  --help                                 Show this help.`);
}

function positiveInteger(value, option) {
	if (!/^\d+$/.test(value) || Number(value) < 1) {
		throw new Error(`${option} needs a positive integer`);
	}
	return Number(value);
}

function parseArgs(argv) {
	const options = {
		show: null,
		refresh: false,
		all: false,
		paths: [],
		format: 'human',
		limit: 20,
		summaryLimit: 8
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		switch (argument) {
			case '--show':
				options.show = argv[++index];
				if (!options.show) throw new Error('--show needs a value');
				break;
			case '--refresh':
				options.refresh = true;
				break;
			case '--all':
				options.all = true;
				break;
			case '--path': {
				const path = argv[++index];
				if (!path) throw new Error('--path needs a value');
				options.paths.push(path.replace(/^\.\//, '').replace(/\/$/, ''));
				break;
			}
			case '--format':
				options.format = argv[++index];
				if (!['human', 'json'].includes(options.format))
					throw new Error('--format needs human or json');
				break;
			case '--limit':
				options.limit = positiveInteger(argv[++index] ?? '', '--limit');
				break;
			case '--summary-limit':
				options.summaryLimit = positiveInteger(argv[++index] ?? '', '--summary-limit');
				break;
			case '--help':
			case '-h':
				usage();
				process.exit(0);
			default:
				throw new Error(`unknown option: ${argument}`);
		}
	}
	return options;
}

function gitRoot() {
	if (process.env.STUPIDITY_ROOT) return resolve(process.env.STUPIDITY_ROOT);
	try {
		return execFileSync('git', ['rev-parse', '--show-toplevel'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
	} catch {
		return process.cwd();
	}
}

function cataloguePath(root) {
	const configured = process.env.STUPIDITY_CATALOG_DIR ?? '.tmp/stupidity-scanner';
	return join(isAbsolute(configured) ? configured : join(root, configured), 'findings.tsv');
}

function readCatalogue(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [severity, confidence, rule, summary, location] = line.split('\t');
			return { severity, confidence, rule, summary, location };
		});
}

function hasActionable(findings) {
	return findings.some(({ severity }) => severity === 'error' || severity === 'warning');
}

function selectedFindings(findings, selector) {
	if (!selector || selector === 'all') return findings;
	return findings.filter(
		(finding) =>
			finding.rule === selector || finding.severity === selector || finding.confidence === selector
	);
}

function renderJson(findings, path, scope, selector = null) {
	const selected = selectedFindings(findings, selector);
	const counts = { error: 0, warning: 0, hint: 0 };
	for (const finding of selected) counts[finding.severity] += 1;
	const verdict = counts.error ? 'fail' : counts.warning ? 'warn' : 'pass';
	console.log(
		JSON.stringify(
			{
				schemaVersion: 1,
				kind: 'stupidity-scan',
				verdict,
				scope,
				selector,
				summary: { ...counts, actionable: counts.error + counts.warning },
				findings: selected.map((finding) => ({
					ruleId: finding.rule,
					severity: finding.severity,
					confidence: finding.confidence,
					summary: finding.summary,
					file: finding.file ?? null,
					line: finding.line ?? null,
					text: finding.text ?? null,
					evidence: finding.evidence ?? null,
					location: finding.location
				})),
				catalogue: relative(process.cwd(), path) || path
			},
			null,
			2
		)
	);
}

function renderDetails(findings, selector, limit, path) {
	const matches = findings.filter(
		(finding) =>
			selector === 'all' ||
			finding.rule === selector ||
			finding.severity === selector ||
			finding.confidence === selector
	);
	if (selector === 'Q3') {
		matches.sort((a, b) => {
			const aLines = Number(a.location.match(/lines=(\d+)/)?.[1] ?? Number.MAX_SAFE_INTEGER);
			const bLines = Number(b.location.match(/lines=(\d+)/)?.[1] ?? Number.MAX_SAFE_INTEGER);
			const aReferences = Number(
				a.location.match(/references=(\d+)/)?.[1] ?? Number.MAX_SAFE_INTEGER
			);
			const bReferences = Number(
				b.location.match(/references=(\d+)/)?.[1] ?? Number.MAX_SAFE_INTEGER
			);
			return aLines - bLines || aReferences - bReferences || a.location.localeCompare(b.location);
		});
	}
	let displayed = matches;
	if (!RULES.has(selector) && matches.length > limit) {
		const byRule = new Map();
		for (const finding of matches) {
			const group = byRule.get(finding.rule) ?? [];
			group.push(finding);
			byRule.set(finding.rule, group);
		}
		displayed = [];
		for (let index = 0; displayed.length < limit; index += 1) {
			let added = false;
			for (const group of byRule.values()) {
				if (group[index]) {
					displayed.push(group[index]);
					added = true;
					if (displayed.length === limit) break;
				}
			}
			if (!added) break;
		}
	}
	console.log(`stupidity details: ${matches.length} match ${selector} (showing at most ${limit})`);
	for (const finding of displayed.slice(0, limit)) {
		console.log(`  [${finding.severity}/${finding.confidence} ${finding.rule}] ${finding.summary}`);
		console.log(`    ${finding.location}`);
	}
	if (matches.length > limit) console.log(`  … ${matches.length - limit} more matches catalogued`);
	console.log(`catalogue: ${relative(process.cwd(), path) || path}`);
}

function renderSummary(findings, limit, path, scope) {
	const counts = { error: 0, warning: 0, hint: 0 };
	const groups = new Map();
	for (const finding of findings) {
		counts[finding.severity] += 1;
		const key = [finding.severity, finding.confidence, finding.rule, finding.summary].join('\t');
		groups.set(key, (groups.get(key) ?? 0) + 1);
	}
	const actionable = counts.error + counts.warning;
	const groupRows = [...groups].map(([key, count]) => {
		const [severity, confidence, rule, summary] = key.split('\t');
		return { severity, confidence, rule, summary, count };
	});
	const actionableGroups = groupRows
		.filter(({ severity }) => severity !== 'hint')
		.sort(
			(a, b) =>
				SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
				CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
				b.count - a.count ||
				a.rule.localeCompare(b.rule)
		);
	const hintGroups = groupRows.length - actionableGroups.length;

	console.log(
		`stupidity scan: ${actionable} actionable — ${counts.error} errors, ${counts.warning} warnings; ${counts.hint} hints catalogued`
	);
	console.log(`scope: ${scope.label} — ${scope.files} source files`);
	if (actionableGroups.length) {
		console.log(
			`decision brief (showing at most ${limit} of ${actionableGroups.length} actionable groups):`
		);
		for (const group of actionableGroups.slice(0, limit)) {
			console.log(
				`  ${group.severity.padEnd(7)} ${group.confidence.padEnd(6)} ${group.rule.padEnd(6)} ${String(group.count).padStart(5)}  ${group.summary}`
			);
		}
		if (actionableGroups.length > limit) {
			console.log(`  … ${actionableGroups.length - limit} more actionable groups catalogued`);
		}
	} else {
		console.log('decision brief: no errors or warnings');
	}
	console.log(`  ${hintGroups} hint groups omitted from the decision brief`);
	console.log(`catalogue: ${relative(process.cwd(), path) || path}`);
	if (counts.error) {
		console.log(`next:      bash .agents/skills/stupidity-scanner/scan.sh --show error --limit 20`);
	} else if (counts.warning) {
		console.log(
			`next:      bash .agents/skills/stupidity-scanner/scan.sh --show warning --limit 20`
		);
	}
	console.log(
		`explore:   bash .agents/skills/stupidity-scanner/scan.sh --show <rule|severity|confidence|all> --limit 20`
	);
}

function isGitRepository(root) {
	try {
		execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
			cwd: root,
			stdio: 'ignore'
		});
		return true;
	} catch {
		return false;
	}
}

function repositorySourceFiles(root) {
	let discovered;
	if (isGitRepository(root)) {
		const tracked = execFileSync('git', ['ls-files', '-z', '--', '*.ts', '*.tsx', '*.svelte'], {
			cwd: root,
			encoding: 'utf8'
		});
		const untracked = execFileSync(
			'git',
			['ls-files', '--others', '--exclude-standard', '-z', '--', '*.ts', '*.tsx', '*.svelte'],
			{ cwd: root, encoding: 'utf8' }
		);
		discovered = `${tracked}${untracked}`.split('\0');
	} else {
		discovered = execFileSync(
			'rg',
			['--files', '-0', '-g', '*.ts', '-g', '*.tsx', '-g', '*.svelte'],
			{ cwd: root, encoding: 'utf8' }
		).split('\0');
	}
	return [...new Set(discovered)]
		.filter(Boolean)
		.filter((file) => !isExcluded(file) && existsSync(join(root, file)));
}

function changedFiles(root) {
	if (!isGitRepository(root)) return null;
	let changed = '';
	try {
		changed = execFileSync(
			'git',
			['diff', '--name-only', '--diff-filter=ACMR', '-z', 'HEAD', '--'],
			{
				cwd: root,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'ignore']
			}
		);
	} catch {
		// An unborn repository has no HEAD; staged files are handled by --all in scanner tests.
	}
	const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
		cwd: root,
		encoding: 'utf8'
	});
	return new Set(`${changed}${untracked}`.split('\0').filter(Boolean));
}

function selectScope(root, options) {
	const allFiles = repositorySourceFiles(root);
	if (options.paths.length) {
		const files = allFiles.filter((file) =>
			options.paths.some((path) => file === path || file.startsWith(`${path}/`))
		);
		return { files, allFiles, label: `path ${options.paths.join(', ')}` };
	}
	if (options.all) return { files: allFiles, allFiles, label: 'all' };
	const changed = changedFiles(root);
	if (!changed) return { files: allFiles, allFiles, label: 'workspace (no git metadata)' };
	return { files: allFiles.filter((file) => changed.has(file)), allFiles, label: 'changed' };
}

function isExcluded(file) {
	return (
		file.endsWith('.d.ts') ||
		/(^|\/)(node_modules|build|dist|coverage|generated|\.generated|\.svelte-kit(?:-e2e)?|\.tmp|\.data|\.agents|\.opencode)(\/|$)/.test(
			file
		) ||
		/(^|\/)(test|tests|e2e|__tests__)(\/|$)/.test(file) ||
		/\.(test|spec)\.[^.]+$/.test(file)
	);
}

/** SvelteKit / Kit env files that must exist as their own path. Do not pad them. */
function isFrameworkBoundFile(file) {
	const base = file.split('/').pop() ?? '';
	if (
		base === 'hooks.server.ts' ||
		base === 'hooks.client.ts' ||
		base === 'hooks.ts' ||
		base === 'env.ts' ||
		base === 'app.html'
	)
		return true;
	if (/^\+(page|layout|error|server)(\.[a-z]+)*\.(ts|js|svelte)$/.test(base)) return true;
	return /(^|\/)params\/[^/]+\.(ts|js)$/.test(file);
}

function recordThinFile(collector, file, source, position = 0) {
	if (isFrameworkBoundFile(file)) return;
	const lines = source.split('\n').length;
	if (lines < MIN_FILE_LINES) collector.add('Q2', file, source, position, `${lines} lines`);
}

const ENV_VAR_NAME = /^(SECRET_|PUBLIC_|NORBITAL_)/;

function tsIsProcessEnv(node) {
	return (
		ts.isPropertyAccessExpression(node) &&
		ts.isIdentifier(node.expression) &&
		node.expression.text === 'process' &&
		node.name.text === 'env'
	);
}

function tsIsEnvRoot(node) {
	if (tsIsProcessEnv(node)) return true;
	return ts.isIdentifier(node) && /^(coreEnv|privateEnv|env)$/.test(node.text);
}

function tsIsEnvVarAccess(node) {
	if (ts.isPropertyAccessExpression(node) && ENV_VAR_NAME.test(node.name.text)) {
		return tsIsEnvRoot(node.expression);
	}
	if (
		ts.isElementAccessExpression(node) &&
		ts.isStringLiteral(node.argumentExpression) &&
		ENV_VAR_NAME.test(node.argumentExpression.text)
	) {
		return tsIsEnvRoot(node.expression);
	}
	return false;
}

function tsContainsEnvVarAccess(node) {
	if (tsIsEnvVarAccess(node)) return true;
	return node.forEachChild((child) => tsContainsEnvVarAccess(child) || undefined) === true;
}

function tsIsThrowIife(node) {
	if (!ts.isCallExpression(node) || node.arguments.length) return false;
	const callee = ts.isParenthesizedExpression(node.expression)
		? node.expression.expression
		: node.expression;
	if (!ts.isArrowFunction(callee) && !ts.isFunctionExpression(callee)) return false;
	const { body } = callee;
	if (ts.isThrowStatement(body)) return true;
	return (
		ts.isBlock(body) && body.statements.some((statement) => ts.isThrowStatement(statement))
	);
}

function tsIsThrowThen(node) {
	return (
		ts.isThrowStatement(node) ||
		(ts.isBlock(node) &&
			node.statements.length === 1 &&
			ts.isThrowStatement(node.statements[0]))
	);
}

function tsEnvAssignedName(statement) {
	if (!ts.isVariableStatement(statement)) return null;
	const [variable] = statement.declarationList.declarations;
	if (
		!variable ||
		!ts.isIdentifier(variable.name) ||
		!variable.initializer ||
		!tsContainsEnvVarAccess(variable.initializer)
	)
		return null;
	return variable.name.text;
}

function recordTsEnvRethrow(collector, file, source, sourceFile, node) {
	if (
		ts.isBinaryExpression(node) &&
		node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
		tsIsThrowIife(node.right) &&
		tsContainsEnvVarAccess(node.left)
	) {
		collector.add('E3', file, source, node.getStart(sourceFile));
		return;
	}
	if (
		ts.isIfStatement(node) &&
		!node.elseStatement &&
		tsIsThrowThen(node.thenStatement)
	) {
		if (tsContainsEnvVarAccess(node.expression)) {
			collector.add('E3', file, source, node.getStart(sourceFile));
			return;
		}
		const parent = node.parent;
		if (ts.isBlock(parent) && ts.isPrefixUnaryExpression(node.expression)) {
			const operand = node.expression.operand;
			const name = ts.isIdentifier(operand)
				? operand.text
				: ts.isPropertyAccessExpression(operand) && ts.isIdentifier(operand.expression)
					? operand.expression.text
					: null;
			if (name) {
				const index = parent.statements.indexOf(node);
				const previous = index > 0 ? parent.statements[index - 1] : null;
				if (previous && tsEnvAssignedName(previous) === name)
					collector.add('E3', file, source, node.getStart(sourceFile));
			}
		}
	}
}

function lineInfo(source, position) {
	const before = source.slice(0, Math.max(0, position));
	const line = before.split('\n').length;
	const lines = source.split('\n');
	return { line, text: (lines[line - 1] ?? '').trim().replaceAll('\t', ' ').slice(0, 240), lines };
}

function ignoredAt(source, position, rule) {
	const { line, lines } = lineInfo(source, position);
	const context = [lines[line - 2] ?? '', lines[line - 1] ?? ''].join('\n');
	return (
		context.includes('fallow:ignore') ||
		context.includes('stupidity:ignore') ||
		context.includes(`stupidity:allow ${rule}`) ||
		(rule === 'R3b' && context.includes('stupidity: boundary-cast'))
	);
}

function createFindingCollector() {
	const findings = [];
	const keys = new Set();
	return {
		findings,
		add(ruleId, file, source, position, evidence = '') {
			const rule = RULES.get(ruleId);
			if (!rule) throw new Error(`unknown scanner rule: ${ruleId}`);
			if (ignoredAt(source, position, ruleId)) return;
			const { line, text } = lineInfo(source, position);
			const safeEvidence = evidence.replaceAll(/\s+/g, ' ').trim();
			const location =
				`${file}:${line}: ${text}${safeEvidence ? ` [${safeEvidence}]` : ''}`.replaceAll('\t', ' ');
			const key = `${ruleId}\t${file}\t${line}`;
			if (keys.has(key)) return;
			keys.add(key);
			findings.push({
				severity: rule.severity,
				confidence: rule.confidence,
				rule: rule.id,
				summary: rule.summary,
				location,
				file,
				line,
				text,
				evidence: safeEvidence || null
			});
		}
	};
}

function tsText(node, sourceFile) {
	return node.getText(sourceFile);
}

function isTsAny(node) {
	return node?.kind === ts.SyntaxKind.AnyKeyword;
}

function isTsUnknown(node) {
	return node?.kind === ts.SyntaxKind.UnknownKeyword;
}

function isTsAnyInSignature(node) {
	for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
		if (ts.isConditionalTypeNode(current) || ts.isTypeParameterDeclaration(current)) return false;
	}
	for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
		if (
			ts.isParameter(current) ||
			ts.isPropertySignature(current) ||
			ts.isPropertyDeclaration(current) ||
			ts.isVariableDeclaration(current) ||
			ts.isFunctionTypeNode(current) ||
			ts.isConstructorTypeNode(current) ||
			(ts.isFunctionLike(current) && current.type)
		) {
			return true;
		}
		if (ts.isTypeAliasDeclaration(current)) return false;
	}
	return false;
}

function isTsJsonParse(node) {
	return (
		ts.isCallExpression(node) &&
		ts.isPropertyAccessExpression(node.expression) &&
		node.expression.expression.getText() === 'JSON' &&
		node.expression.name.text === 'parse'
	);
}

function isTsJsonStringify(node) {
	return (
		ts.isCallExpression(node) &&
		ts.isPropertyAccessExpression(node.expression) &&
		node.expression.expression.getText() === 'JSON' &&
		node.expression.name.text === 'stringify'
	);
}

function isTsValidatedJsonParse(node) {
	const parent = node.parent;
	return (
		ts.isCallExpression(parent) &&
		parent.arguments.includes(node) &&
		ts.isPropertyAccessExpression(parent.expression) &&
		['parse', 'safeParse'].includes(parent.expression.name.text)
	);
}

function isTsRecordUnknown(type) {
	return (
		ts.isTypeReferenceNode(type) &&
		type.typeName.getText() === 'Record' &&
		type.typeArguments?.length === 2 &&
		type.typeArguments[0].kind === ts.SyntaxKind.StringKeyword &&
		isTsUnknown(type.typeArguments[1])
	);
}

function isNamedTsType(type, sourceFile) {
	if (!ts.isTypeReferenceNode(type)) return false;
	const name = type.typeName.getText(sourceFile);
	return (
		/^[A-Z]/.test(name) &&
		![
			'Partial',
			'Readonly',
			'Required',
			'Pick',
			'Omit',
			'Awaited',
			'ReturnType',
			'Parameters'
		].includes(name)
	);
}

function hasTsExportModifier(node) {
	return Boolean(ts.getModifiers(node)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword));
}

function isTsExportedCandidate(node) {
	if (ts.isFunctionDeclaration(node)) return hasTsExportModifier(node);
	if (ts.isVariableDeclaration(node)) return hasTsExportModifier(node.parent.parent);
	return false;
}

function isTsValueReference(node) {
	if (!ts.isIdentifier(node)) return false;
	const parent = node.parent;
	if (!parent) return false;
	if (
		(parent.name === node &&
			(ts.isFunctionDeclaration(parent) ||
				ts.isFunctionExpression(parent) ||
				ts.isVariableDeclaration(parent) ||
				ts.isParameter(parent) ||
				ts.isClassDeclaration(parent) ||
				ts.isMethodDeclaration(parent) ||
				ts.isPropertyDeclaration(parent) ||
				ts.isTypeAliasDeclaration(parent) ||
				ts.isInterfaceDeclaration(parent))) ||
		ts.isImportSpecifier(parent) ||
		ts.isImportClause(parent) ||
		ts.isNamespaceImport(parent) ||
		ts.isExportSpecifier(parent) ||
		(ts.isPropertyAssignment(parent) && parent.name === node) ||
		(ts.isPropertySignature(parent) && parent.name === node) ||
		ts.isTypeReferenceNode(parent) ||
		ts.isQualifiedName(parent) ||
		ts.isLiteralTypeNode(parent)
	) {
		return false;
	}
	return true;
}

function incrementReference(map, name, amount = 1) {
	map.set(name, (map.get(name) ?? 0) + amount);
}

function isTsFunctionLikeCandidate(node) {
	return (
		(ts.isFunctionDeclaration(node) && node.name && node.body) ||
		(ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			(ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))
	);
}

function tsCandidateParts(node) {
	if (ts.isFunctionDeclaration(node)) {
		return { name: node.name.text, nameNode: node.name, functionNode: node, body: node.body };
	}
	return {
		name: node.name.text,
		nameNode: node.name,
		functionNode: node.initializer,
		body: node.initializer.body
	};
}

function tsBodyReferencesName(body, name) {
	let found = false;
	function visit(node) {
		if (found) return;
		if (ts.isIdentifier(node) && node.text === name && isTsValueReference(node)) {
			found = true;
			return;
		}
		ts.forEachChild(node, visit);
	}
	visit(body);
	return found;
}

function tsContainsAwait(node, root = true) {
	let found = false;
	function visit(current, isRoot) {
		if (found) return;
		if (!isRoot && (ts.isFunctionLike(current) || isTsLoop(current))) return;
		if (ts.isAwaitExpression(current)) {
			found = true;
			return;
		}
		ts.forEachChild(current, (child) => visit(child, false));
	}
	visit(node, root);
	return found;
}

function isTsLoop(node) {
	return (
		ts.isForStatement(node) ||
		ts.isForInStatement(node) ||
		ts.isForOfStatement(node) ||
		ts.isWhileStatement(node) ||
		ts.isDoStatement(node)
	);
}

function sameTsExpression(left, right, sourceFile) {
	return left.getText(sourceFile) === right.getText(sourceFile);
}

function tsNullishComparison(node) {
	if (!ts.isBinaryExpression(node)) return null;
	if (
		![ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(
			node.operatorToken.kind
		)
	)
		return null;
	if (node.right.kind === ts.SyntaxKind.NullKeyword)
		return { expression: node.left, kind: 'null', operator: node.operatorToken.kind };
	if (ts.isIdentifier(node.right) && node.right.text === 'undefined')
		return { expression: node.left, kind: 'undefined', operator: node.operatorToken.kind };
	return null;
}

function tsContainsOperator(node, kind) {
	let found = false;
	function visit(current) {
		if (found) return;
		if (ts.isBinaryExpression(current) && current.operatorToken.kind === kind) found = true;
		else ts.forEachChild(current, visit);
	}
	visit(node);
	return found;
}

function tsHasPropertyEquality(node) {
	let found = false;
	function visit(current) {
		if (found) return;
		if (
			ts.isBinaryExpression(current) &&
			[ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
				current.operatorToken.kind
			) &&
			(ts.isPropertyAccessExpression(current.left) || ts.isElementAccessExpression(current.left))
		) {
			found = true;
			return;
		}
		ts.forEachChild(current, visit);
	}
	visit(node);
	return found;
}

function tsSingleForwardedCall(candidate) {
	const { functionNode, body } = candidate;
	const parameterNames = functionNode.parameters.map(({ name }) =>
		ts.isIdentifier(name) ? name.text : null
	);
	if (parameterNames.some((name) => name == null)) return false;
	let call = null;
	if (ts.isArrowFunction(functionNode) && !ts.isBlock(body) && ts.isCallExpression(body))
		call = body;
	if (ts.isBlock(body) && body.statements.length === 1) {
		const [statement] = body.statements;
		if (
			ts.isReturnStatement(statement) &&
			statement.expression &&
			ts.isCallExpression(statement.expression)
		)
			call = statement.expression;
		if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression))
			call = statement.expression;
	}
	if (!call || call.arguments.length !== parameterNames.length) return false;
	return call.arguments.every(
		(argument, index) => ts.isIdentifier(argument) && argument.text === parameterNames[index]
	);
}

function tsGetOrThrowWrapper(candidate) {
	const { body } = candidate;
	if (!body || !ts.isBlock(body)) return false;
	const statements = body.statements.filter((statement) => !ts.isEmptyStatement(statement));
	if (statements.length !== 3) return false;
	const [declaration, guard, ret] = statements;
	if (!ts.isVariableStatement(declaration)) return false;
	const [variable] = declaration.declarationList.declarations;
	if (!variable || !ts.isIdentifier(variable.name) || !variable.initializer) return false;
	if (!ts.isCallExpression(variable.initializer) && !ts.isPropertyAccessExpression(variable.initializer))
		return false;
	const name = variable.name.text;
	if (!ts.isIfStatement(guard) || guard.elseStatement) return false;
	const then = guard.thenStatement;
	const throws =
		ts.isThrowStatement(then) ||
		(ts.isBlock(then) && then.statements.length === 1 && ts.isThrowStatement(then.statements[0]));
	if (!throws) return false;
	return (
		ts.isReturnStatement(ret) &&
		Boolean(ret.expression) &&
		ts.isIdentifier(ret.expression) &&
		ret.expression.text === name
	);
}

function tsThinWrapper(candidate) {
	return tsSingleForwardedCall(candidate) || tsGetOrThrowWrapper(candidate);
}

function tokenFingerprint(source) {
	const scanner = ts.createScanner(
		ts.ScriptTarget.Latest,
		true,
		ts.LanguageVariant.Standard,
		source
	);
	const tokens = [];
	for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
		tokens.push(`${token}:${scanner.getTokenText()}`);
	}
	return { fingerprint: tokens.join('|'), tokens: tokens.length };
}

const ZOD_SCHEMA_METHODS = new Set([
	'array',
	'boolean',
	'discriminatedUnion',
	'enum',
	'intersection',
	'literal',
	'number',
	'object',
	'record',
	'string',
	'tuple',
	'union'
]);
const ZOD_INFER_NAMES = new Set(['infer', 'input', 'output']);
const TS_KEYWORD_SHAPE = new Map([
	[ts.SyntaxKind.StringKeyword, 'string'],
	[ts.SyntaxKind.NumberKeyword, 'number'],
	[ts.SyntaxKind.BooleanKeyword, 'boolean'],
	[ts.SyntaxKind.NullKeyword, 'null'],
	[ts.SyntaxKind.UndefinedKeyword, 'undefined'],
	[ts.SyntaxKind.VoidKeyword, 'void'],
	[ts.SyntaxKind.NeverKeyword, 'never'],
	[ts.SyntaxKind.UnknownKeyword, 'unknown'],
	[ts.SyntaxKind.AnyKeyword, 'any'],
	[ts.SyntaxKind.BigIntKeyword, 'bigint']
]);

function typeNameFromSchemaName(schemaName) {
	const stripped = schemaName.replace(/(?:_s|S)chema$/, '').replace(/Schema$/, '');
	if (stripped === schemaName) return /^[A-Z]/.test(schemaName) ? schemaName : null;
	return `${stripped.charAt(0).toUpperCase()}${stripped.slice(1)}`;
}

function isTsZodSchemaExpression(node) {
	let current = node;
	while (current) {
		if (ts.isCallExpression(current)) {
			const callee = current.expression;
			if (ts.isPropertyAccessExpression(callee) && ZOD_SCHEMA_METHODS.has(callee.name.text)) {
				return true;
			}
			current = ts.isPropertyAccessExpression(callee) ? callee.expression : null;
			continue;
		}
		if (ts.isPropertyAccessExpression(current)) {
			current = current.expression;
			continue;
		}
		break;
	}
	return false;
}

function isTsZodInferType(node) {
	if (!ts.isTypeReferenceNode(node) || !ts.isQualifiedName(node.typeName)) return false;
	return (
		ts.isIdentifier(node.typeName.left) &&
		node.typeName.left.text === 'z' &&
		ZOD_INFER_NAMES.has(node.typeName.right.text)
	);
}

function collectTsZodSchemaTypeNames(sourceFile) {
	const names = new Map();
	function visit(node) {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			isTsZodSchemaExpression(node.initializer)
		) {
			const typeName = typeNameFromSchemaName(node.name.text);
			if (typeName) names.set(typeName, node.name.text);
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return names;
}

function tsTypeShape(node, sourceFile) {
	if (!node) return '?';
	if (ts.isParenthesizedTypeNode(node)) return tsTypeShape(node.type, sourceFile);
	if (ts.isLiteralTypeNode(node)) return `L:${node.literal.getText(sourceFile)}`;
	const keyword = TS_KEYWORD_SHAPE.get(node.kind);
	if (keyword) return keyword;
	if (ts.isArrayTypeNode(node)) return `A:${tsTypeShape(node.elementType, sourceFile)}`;
	if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
		return tsTypeShape(node.type, sourceFile);
	}
	if (ts.isUnionTypeNode(node)) {
		return `U:${node.types.map((type) => tsTypeShape(type, sourceFile)).sort().join('|')}`;
	}
	if (ts.isIntersectionTypeNode(node)) {
		return `I:${node.types.map((type) => tsTypeShape(type, sourceFile)).sort().join('&')}`;
	}
	if (ts.isTypeLiteralNode(node)) return tsMemberShape(node.members, sourceFile);
	if (ts.isTypeReferenceNode(node)) {
		if (isTsZodInferType(node)) return 'INFER';
		const name = node.typeName.getText(sourceFile);
		const args = node.typeArguments?.map((type) => tsTypeShape(type, sourceFile)).join(',') ?? '';
		return args ? `R:${name}<${args}>` : `R:${name}`;
	}
	return null;
}

function tsMemberShape(members, sourceFile) {
	const fields = [];
	for (const member of members) {
		if (!ts.isPropertySignature(member) || !member.name) continue;
		const type = member.type ? tsTypeShape(member.type, sourceFile) : '?';
		if (type == null) return null;
		fields.push(`${member.name.getText(sourceFile)}${member.questionToken ? '?' : ''}:${type}`);
	}
	return `{${fields.sort().join(';')}}`;
}

function tsTypeCandidateParts(node, sourceFile) {
	if (node.typeParameters?.length) return null;
	if (ts.isTypeAliasDeclaration(node)) {
		if (isTsZodInferType(node.type)) return null;
		const shape = tsTypeShape(node.type, sourceFile);
		if (!shape || shape === 'INFER') return null;
		const literalUnion =
			ts.isUnionTypeNode(node.type) && node.type.types.every((type) => ts.isLiteralTypeNode(type));
		const objectMembers = ts.isTypeLiteralNode(node.type)
			? node.type.members.filter((member) => ts.isPropertySignature(member)).length
			: 0;
		return {
			name: node.name.text,
			shape,
			literalUnion,
			objectMembers,
			position: node.getStart(sourceFile)
		};
	}
	if (ts.isInterfaceDeclaration(node)) {
		if (node.heritageClauses?.length) return null;
		const shape = tsMemberShape(node.members, sourceFile);
		if (!shape) return null;
		return {
			name: node.name.text,
			shape,
			literalUnion: false,
			objectMembers: node.members.filter((member) => ts.isPropertySignature(member)).length,
			position: node.getStart(sourceFile)
		};
	}
	return null;
}

function isAl5Eligible(candidate) {
	if (candidate.literalUnion) return candidate.shape.startsWith('U:') && candidate.shape.includes('|');
	return candidate.objectMembers >= 3;
}

function collectTsTypeCandidates(file, source, sourceFile) {
	const candidates = [];
	function visit(node) {
		const parts = tsTypeCandidateParts(node, sourceFile);
		if (parts && (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node))) {
			const exported = hasTsExportModifier(node);
			candidates.push({ ...parts, file, source, exported });
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return candidates;
}

function recordTypeDeclaration(collector, shared, file, source, node, sourceFile, schemaNames) {
	const parts = tsTypeCandidateParts(node, sourceFile);
	if (!parts) return;
	if (hasTsExportModifier(node) && isAl5Eligible(parts)) {
		shared.typeCandidates.push({ ...parts, file, source, exported: true });
	}
	const inferredAlias = ts.isTypeAliasDeclaration(node) && isTsZodInferType(node.type);
	if (!inferredAlias && schemaNames.has(parts.name)) {
		collector.add(
			'AL4',
			file,
			source,
			parts.position,
			`type=${parts.name} schema=${schemaNames.get(parts.name)}`
		);
	}
}

function isTsEffectCall(node) {
	if (!ts.isCallExpression(node)) return null;
	const expression = node.expression;
	if (ts.isIdentifier(expression) && expression.text === '$effect') return 'effect';
	if (
		ts.isPropertyAccessExpression(expression) &&
		ts.isIdentifier(expression.expression) &&
		expression.expression.text === '$effect'
	) {
		const name = expression.name.text;
		return name === 'pre' || name === 'root' ? name : null;
	}
	return null;
}

function recordEffectCall(collector, file, source, position, callback, kind) {
	const asyncCallback =
		callback &&
		ts.isFunctionLike(callback) &&
		callback.modifiers?.some(({ kind: modifier }) => modifier === ts.SyntaxKind.AsyncKeyword);
	if (asyncCallback) collector.add('V7', file, source, position, `kind=${kind}`);
	else collector.add('V1', file, source, position, `kind=${kind}`);
}

function sameLogic(left, right) {
	return tokenFingerprint(left).fingerprint === tokenFingerprint(right).fingerprint;
}

function tsContainsCall(node, predicate) {
	let found = false;
	function visit(current) {
		if (found) return;
		if (ts.isCallExpression(current) && predicate(current)) {
			found = true;
			return;
		}
		ts.forEachChild(current, visit);
	}
	visit(node);
	return found;
}

function isTsTimerPromise(node, sourceFile) {
	return (
		ts.isNewExpression(node) &&
		node.expression.getText(sourceFile) === 'Promise' &&
		Boolean(
			node.arguments?.some((argument) =>
				tsContainsCall(
					argument,
					(call) => ts.isIdentifier(call.expression) && call.expression.text === 'setTimeout'
				)
			)
		)
	);
}

function tsBrowserDialogName(node) {
	if (!ts.isCallExpression(node)) return null;
	if (ts.isIdentifier(node.expression) && BROWSER_DIALOGS.has(node.expression.text))
		return node.expression.text;
	if (
		ts.isPropertyAccessExpression(node.expression) &&
		node.expression.expression.getText() === 'window' &&
		BROWSER_DIALOGS.has(node.expression.name.text)
	) {
		return node.expression.name.text;
	}
	return null;
}

function reactivePathsOverlap(left, right) {
	return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

function matchingReactivePath(path, statePaths) {
	if (!path) return null;
	return [...statePaths]
		.filter((statePath) => path === statePath || path.startsWith(`${statePath}.`))
		.sort((left, right) => right.length - left.length)[0]
		? path
		: null;
}

function intersectReactivePaths(leftPaths, rightPaths) {
	const matches = [];
	for (const left of leftPaths) {
		for (const right of rightPaths) {
			if (reactivePathsOverlap(left, right)) matches.push([left, right]);
		}
	}
	return matches;
}

function finalizeReactiveAnalysis(collector, file, source, analysis) {
	if (analysis.stateCells.length > MAX_INDEPENDENT_STATE_CELLS) {
		collector.add(
			'V8',
			file,
			source,
			analysis.stateCells[MAX_INDEPENDENT_STATE_CELLS].position,
			`count=${analysis.stateCells.length} limit=${MAX_INDEPENDENT_STATE_CELLS}`
		);
	}

	for (const watch of analysis.watches) {
		const direct = intersectReactivePaths(watch.reads, watch.writes)[0];
		if (direct) {
			collector.add('V9', file, source, watch.position, `path=${direct[0]}`);
		}
	}

	for (let leftIndex = 0; leftIndex < analysis.watches.length; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < analysis.watches.length; rightIndex += 1) {
			const left = analysis.watches[leftIndex];
			const right = analysis.watches[rightIndex];
			const leftToRight = intersectReactivePaths(left.writes, right.reads)[0];
			const rightToLeft = intersectReactivePaths(right.writes, left.reads)[0];
			if (!leftToRight || !rightToLeft) continue;
			collector.add(
				'V10',
				file,
				source,
				right.position,
				`cycle=${leftToRight[0]}->${leftToRight[1]}->${rightToLeft[0]}`
			);
		}
	}

	for (const mount of analysis.mounts) {
		for (const path of mount.mountedWrites) {
			collector.add('V11', file, source, mount.position, `state=${path}`);
		}
		const lifecycleCleanups = new Set(analysis.destroys.flatMap(({ cleanups }) => [...cleanups]));
		const missingResources = [...mount.resources].filter(
			(resource) => !lifecycleCleanups.has(RESOURCE_CLEANUPS.get(resource))
		);
		if (missingResources.length && !mount.returnsCleanup) {
			collector.add(
				'V13',
				file,
				source,
				mount.position,
				`resource=${missingResources.sort().join('|')}`
			);
		}
	}

	for (const destroy of analysis.destroys) {
		if (destroy.writes.size) {
			collector.add(
				'V12',
				file,
				source,
				destroy.position,
				`state=${[...destroy.writes].sort().join('|')}`
			);
		}
	}
}

function tsAccessPath(node) {
	if (!node) return null;
	if (ts.isIdentifier(node)) return node.text;
	if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
	if (ts.isPropertyAccessExpression(node)) {
		const object = tsAccessPath(node.expression);
		return object ? `${object}.${node.name.text}` : null;
	}
	if (
		ts.isElementAccessExpression(node) &&
		node.argumentExpression &&
		(ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression))
	) {
		const object = tsAccessPath(node.expression);
		return object ? `${object}.${node.argumentExpression.text}` : null;
	}
	return null;
}

function isTsStateCall(node) {
	if (!ts.isCallExpression(node)) return false;
	if (ts.isIdentifier(node.expression)) return node.expression.text === '$state';
	return (
		ts.isPropertyAccessExpression(node.expression) &&
		ts.isIdentifier(node.expression.expression) &&
		node.expression.expression.text === '$state' &&
		node.expression.name.text === 'raw'
	);
}

function isTsRuneCall(node) {
	if (!node || !ts.isCallExpression(node)) return false;
	const expression = node.expression;
	if (ts.isIdentifier(expression)) return RUNE_CALLEES.has(expression.text);
	return (
		ts.isPropertyAccessExpression(expression) &&
		ts.isIdentifier(expression.expression) &&
		RUNE_CALLEES.has(expression.expression.text) &&
		RUNE_MEMBERS.has(expression.name.text)
	);
}

function isEstreeRuneCall(node) {
	if (node?.type !== 'CallExpression') return false;
	if (node.callee?.type === 'Identifier') return RUNE_CALLEES.has(node.callee.name);
	return (
		node.callee?.type === 'MemberExpression' &&
		node.callee.object?.type === 'Identifier' &&
		RUNE_CALLEES.has(node.callee.object.name) &&
		RUNE_MEMBERS.has(estreeMemberName(node.callee))
	);
}

function isSvelteRuneModule(file) {
	return file.endsWith('.svelte') || file.endsWith('.svelte.ts') || file.endsWith('.svelte.js');
}

function isSvelteInstanceFile(file) {
	return file.endsWith('.svelte');
}

function isTsPureComputed(node) {
	if (!node) return false;
	if (
		ts.isIdentifier(node) ||
		ts.isLiteralExpression(node) ||
		node.kind === ts.SyntaxKind.TrueKeyword ||
		node.kind === ts.SyntaxKind.FalseKeyword ||
		node.kind === ts.SyntaxKind.NullKeyword
	) {
		return true;
	}
	if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
		return isTsPureComputed(node.expression);
	}
	if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
		return isTsPureComputed(node.operand);
	}
	if (ts.isBinaryExpression(node)) return isTsPureComputed(node.left) && isTsPureComputed(node.right);
	if (ts.isConditionalExpression(node)) {
		return (
			isTsPureComputed(node.condition) &&
			isTsPureComputed(node.whenTrue) &&
			isTsPureComputed(node.whenFalse)
		);
	}
	if (ts.isPropertyAccessExpression(node)) return isTsPureComputed(node.expression);
	if (ts.isElementAccessExpression(node)) {
		return isTsPureComputed(node.expression) && isTsPureComputed(node.argumentExpression);
	}
	if (ts.isTemplateExpression(node)) {
		return node.templateSpans.every((span) => isTsPureComputed(span.expression));
	}
	if (ts.isNoSubstitutionTemplateLiteral(node)) return true;
	return false;
}

function isEstreePureComputed(node) {
	if (!node) return false;
	switch (node.type) {
		case 'Literal':
		case 'Identifier':
			return true;
		case 'TemplateLiteral':
			return (node.expressions ?? []).every(isEstreePureComputed);
		case 'UnaryExpression':
		case 'UpdateExpression':
			return isEstreePureComputed(node.argument);
		case 'BinaryExpression':
		case 'LogicalExpression':
			return isEstreePureComputed(node.left) && isEstreePureComputed(node.right);
		case 'ConditionalExpression':
			return (
				isEstreePureComputed(node.test) &&
				isEstreePureComputed(node.consequent) &&
				isEstreePureComputed(node.alternate)
			);
		case 'MemberExpression':
			return (
				isEstreePureComputed(node.object) &&
				(!node.computed || isEstreePureComputed(node.property))
			);
		case 'ChainExpression':
			return isEstreePureComputed(node.expression);
		case 'TSAsExpression':
		case 'TSTypeAssertion':
		case 'TSNonNullExpression':
			return isEstreePureComputed(node.expression);
		default:
			return false;
	}
}

function tsHasDocumentation(node, sourceFile) {
	if (ts.getJSDocCommentsAndTags(node).length > 0) return true;
	const ranges = ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart());
	return Boolean(
		ranges?.some((range) => sourceFile.text.slice(range.pos, range.pos + 3) === '/**')
	);
}

function tsDocumentedDeclaration(node, sourceFile) {
	if (tsHasDocumentation(node, sourceFile)) return true;
	if (node.parent && tsHasDocumentation(node.parent, sourceFile)) return true;
	if (
		node.parent?.parent &&
		ts.isVariableStatement(node.parent.parent) &&
		tsHasDocumentation(node.parent.parent, sourceFile)
	) {
		return true;
	}
	return false;
}

function tsDeclarationLineCount(node, sourceFile) {
	const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
	const end = sourceFile.getLineAndCharacterOfPosition(node.end).line;
	return end - start + 1;
}

function tsCallableName(node) {
	if (ts.isConstructorDeclaration(node)) return 'constructor';
	if (ts.isClassDeclaration(node)) return node.name?.text ?? '<class>';
	if (ts.isFunctionDeclaration(node)) return node.name?.text ?? '<default>';
	if (
		ts.isMethodDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	) {
		return ts.isIdentifier(node.name) ? node.name.text : '<method>';
	}
	if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
	return '<anonymous>';
}

function isTsQualityDeclaration(node) {
	if (ts.isClassDeclaration(node)) return true;
	if (ts.isFunctionDeclaration(node)) return Boolean(node.body);
	if (ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
		return Boolean(node.body);
	if (ts.isMethodDeclaration(node)) return Boolean(node.body);
	return (
		ts.isVariableDeclaration(node) &&
		ts.isIdentifier(node.name) &&
		Boolean(node.initializer) &&
		(ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
	);
}

function recordTsQuality(collector, file, source, sourceFile, node) {
	if (!isTsQualityDeclaration(node)) return;
	const name = tsCallableName(node);
	const lines = tsDeclarationLineCount(node, sourceFile);
	const position = node.getStart(sourceFile);
	if (lines < MIN_DECLARATION_LINES)
		collector.add('Q4', file, source, position, `name=${name} lines=${lines}`);
	if (!tsDocumentedDeclaration(node, sourceFile))
		collector.add('Q5', file, source, position, `name=${name}`);
}

function tsInitializerReadsLocals(node, sourceFile) {
	if (!node) return false;
	let found = false;
	function visit(current) {
		if (found) return;
		if (ts.isIdentifier(current) && !KNOWN_GLOBALS.has(current.text) && isTsValueReference(current)) {
			found = true;
			return;
		}
		ts.forEachChild(current, visit);
	}
	visit(node);
	return found;
}

function recordTsRuneHygiene(collector, file, source, sourceFile, node, reassigned) {
	if (!isSvelteInstanceFile(file) || !ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name))
		return;
	if (tsHasFunctionAncestor(node)) return;
	if (
		node.initializer &&
		(ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
	)
		return;
	if (isTsRuneCall(node.initializer)) return;
	const statement = node.parent?.parent;
	if (!statement || !ts.isVariableStatement(statement)) return;
	const kind = statement.declarationList.flags;
	const isConst = Boolean(kind & ts.NodeFlags.Const);
	const isLet = Boolean(kind & ts.NodeFlags.Let) || !isConst;
	const name = node.name.text;
	const mutated = reassigned.has(name);
	const computed =
		isTsPureComputed(node.initializer) && tsInitializerReadsLocals(node.initializer, sourceFile);
	if (isConst && !computed) return;
	if (!mutated && computed) {
		collector.add('V15', file, source, node.name.getStart(sourceFile), `name=${name} prefer=$derived`);
		return;
	}
	if (isLet)
		collector.add('V14', file, source, node.name.getStart(sourceFile), `name=${name} prefer=$state`);
}

function estreeHasDocumentation(node, source) {
	const start = node.start;
	if (typeof start !== 'number') return false;
	return /\/\*\*[\s\S]*\*\/\s*$/.test(source.slice(Math.max(0, start - 600), start));
}

function estreeDeclarationLines(node, source) {
	return lineInfo(source, node.end).line - lineInfo(source, node.start).line + 1;
}

function estreeCallableName(node) {
	if (node.type === 'ClassDeclaration') return node.id?.name ?? '<class>';
	if (node.type === 'FunctionDeclaration') return node.id?.name ?? '<default>';
	if (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') {
		if (node.kind === 'constructor') return 'constructor';
		if (node.key?.type === 'Identifier') return node.key.name;
		return '<method>';
	}
	if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') return node.id.name;
	return '<anonymous>';
}

function recordEstreeQuality(collector, file, source, node) {
	const name = estreeCallableName(node);
	const lines = estreeDeclarationLines(node, source);
	if (lines < MIN_DECLARATION_LINES)
		collector.add('Q4', file, source, node.start, `name=${name} lines=${lines}`);
	if (!estreeHasDocumentation(node, source))
		collector.add('Q5', file, source, node.start, `name=${name}`);
}

function estreeInitializerReadsLocals(node) {
	if (!node) return false;
	let found = false;
	walkEstree(node, (current, parent) => {
		if (found) return;
		if (isEstreeValueReference(current, parent) && !KNOWN_GLOBALS.has(current.name)) found = true;
	});
	return found;
}

function recordEstreeRuneHygiene(collector, file, source, node, parent, ancestors, reassigned) {
	if (node.type === 'LabeledStatement' && node.label?.name === '$') {
		collector.add('V16', file, source, node.start);
		return;
	}
	if (
		node.type === 'ExportNamedDeclaration' &&
		node.declaration?.type === 'VariableDeclaration' &&
		node.declaration.kind === 'let'
	) {
		collector.add('V17', file, source, node.start);
		return;
	}
	if (!isSvelteInstanceFile(file) || node.type !== 'VariableDeclarator' || node.id?.type !== 'Identifier')
		return;
	if (
		ancestors.some(({ type }) =>
			[
				'FunctionDeclaration',
				'FunctionExpression',
				'ArrowFunctionExpression',
				'ClassDeclaration',
				'ClassBody',
				'ConstTag'
			].includes(type)
		)
	)
		return;
	if (['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init?.type)) return;
	if (isEstreeRuneCall(node.init)) return;
	const declaration = [parent, ...ancestors].find((candidate) => candidate?.type === 'VariableDeclaration');
	if (!declaration) return;
	const name = node.id.name;
	const mutated = reassigned.has(name);
	const computed = isEstreePureComputed(node.init) && estreeInitializerReadsLocals(node.init);
	if (declaration.kind === 'const' && !computed) return;
	if (!mutated && computed) {
		collector.add('V15', file, source, node.id.start, `name=${name} prefer=$derived`);
		return;
	}
	if (declaration.kind === 'let' || declaration.kind === 'var') {
		collector.add('V14', file, source, node.id.start, `name=${name} prefer=$state`);
	}
}

function tsHasFunctionAncestor(node) {
	for (let parent = node.parent; parent; parent = parent.parent) {
		if (ts.isFunctionLike(parent)) return true;
		if (ts.isSourceFile(parent)) return false;
	}
	return false;
}

function tsStateCell(node, sourceFile) {
	if (!node.initializer || !isTsStateCall(node.initializer) || tsHasFunctionAncestor(node))
		return null;
	if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
		return {
			name: node.name.text,
			position: node.name.getStart(sourceFile),
			initiallyFalse: node.initializer.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword
		};
	}
	if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
		return {
			name: `this.${node.name.text}`,
			position: node.name.getStart(sourceFile),
			initiallyFalse: node.initializer.arguments[0]?.kind === ts.SyntaxKind.FalseKeyword
		};
	}
	return null;
}

function tsWalkFunctionBody(root, callback) {
	function visit(node, isRoot) {
		if (!isRoot && ts.isFunctionLike(node)) return;
		callback(node);
		ts.forEachChild(node, (child) => visit(child, false));
	}
	visit(root, true);
}

function tsReactiveReads(root, statePaths) {
	const reads = new Set();
	function visit(node) {
		if (
			(ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
			node.parent.expression === node
		)
			return ts.forEachChild(node, visit);
		const path = matchingReactivePath(tsAccessPath(node), statePaths);
		if (path) reads.add(path);
		ts.forEachChild(node, visit);
	}
	visit(root);
	return reads;
}

function tsReactiveWrites(root, statePaths) {
	const writes = new Set();
	tsWalkFunctionBody(root, (node) => {
		let target = null;
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
			node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
		) {
			target = node.left;
		} else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
			if ([ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator))
				target = node.operand;
		} else if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			MUTATING_METHODS.has(node.expression.name.text)
		) {
			target = node.expression.expression;
		}
		const path = matchingReactivePath(tsAccessPath(target), statePaths);
		if (path) writes.add(path);
	});
	return writes;
}

function tsReturnsCleanup(callback) {
	if (!ts.isBlock(callback.body)) return ts.isFunctionLike(callback.body);
	let found = false;
	tsWalkFunctionBody(callback.body, (node) => {
		if (ts.isReturnStatement(node) && node.expression && ts.isFunctionLike(node.expression))
			found = true;
	});
	return found;
}

function tsLifecycleResources(callback) {
	const resources = new Set();
	tsWalkFunctionBody(callback.body, (node) => {
		if (ts.isCallExpression(node)) {
			if (ts.isIdentifier(node.expression) && RESOURCE_CALLS.has(node.expression.text))
				resources.add(node.expression.text);
			if (
				ts.isPropertyAccessExpression(node.expression) &&
				node.expression.name.text === 'addEventListener'
			)
				resources.add('addEventListener');
		}
		if (
			ts.isNewExpression(node) &&
			ts.isIdentifier(node.expression) &&
			RESOURCE_CONSTRUCTORS.has(node.expression.text)
		)
			resources.add(node.expression.text);
	});
	return resources;
}

function tsMountedWrites(callback, mountedPaths) {
	const writes = new Set();
	function visit(node) {
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			node.right.kind === ts.SyntaxKind.TrueKeyword
		) {
			const path = matchingReactivePath(tsAccessPath(node.left), mountedPaths);
			if (path) writes.add(path);
		}
		ts.forEachChild(node, visit);
	}
	visit(callback.body);
	return writes;
}

function tsLifecycleCleanups(callback) {
	const cleanups = new Set();
	tsWalkFunctionBody(callback.body, (node) => {
		if (!ts.isCallExpression(node)) return;
		if (ts.isIdentifier(node.expression)) cleanups.add(node.expression.text);
		if (ts.isPropertyAccessExpression(node.expression)) cleanups.add(node.expression.name.text);
	});
	return cleanups;
}

function analyzeTsReactivity(sourceFile) {
	const stateCells = [];
	const statePaths = new Set();
	function collectState(node) {
		if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
			const cell = tsStateCell(node, sourceFile);
			if (cell) {
				stateCells.push(cell);
				statePaths.add(cell.name);
			}
		}
		ts.forEachChild(node, collectState);
	}
	collectState(sourceFile);

	const mountedPaths = new Set(
		stateCells
			.filter(
				({ name, initiallyFalse }) => initiallyFalse && MOUNTED_FLAG.test(name.split('.').at(-1))
			)
			.map(({ name }) => name)
	);
	const watches = [];
	const mounts = [];
	const destroys = [];
	function collectLifecycle(node) {
		if (ts.isCallExpression(node)) {
			const name = ts.isIdentifier(node.expression)
				? node.expression.text
				: ts.isPropertyAccessExpression(node.expression) &&
					  ts.isIdentifier(node.expression.expression) &&
					  node.expression.expression.text === 'watch' &&
					  node.expression.name.text === 'pre'
					? 'watch'
					: null;
			const callback = node.arguments[1];
			if (name === 'watch' && node.arguments[0] && callback && ts.isFunctionLike(callback)) {
				watches.push({
					position: node.getStart(sourceFile),
					reads: tsReactiveReads(node.arguments[0], statePaths),
					writes: tsReactiveWrites(callback.body, statePaths)
				});
			}
			const lifecycleCallback = node.arguments[0];
			if (lifecycleCallback && ts.isFunctionLike(lifecycleCallback)) {
				if (name === 'onMount') {
					mounts.push({
						position: node.getStart(sourceFile),
						mountedWrites: tsMountedWrites(lifecycleCallback, mountedPaths),
						resources: tsLifecycleResources(lifecycleCallback),
						returnsCleanup: tsReturnsCleanup(lifecycleCallback)
					});
				}
				if (name === 'onDestroy') {
					destroys.push({
						position: node.getStart(sourceFile),
						writes: tsReactiveWrites(lifecycleCallback.body, statePaths),
						cleanups: tsLifecycleCleanups(lifecycleCallback)
					});
				}
			}
		}
		ts.forEachChild(node, collectLifecycle);
	}
	collectLifecycle(sourceFile);
	return { stateCells, statePaths, watches, mounts, destroys };
}

function tsDuplicateCandidate(candidate) {
	const bodyText = candidate.body.getText(candidate.sourceFile);
	const { fingerprint, tokens } = tokenFingerprint(bodyText);
	const startLine = candidate.sourceFile.getLineAndCharacterOfPosition(
		candidate.body.getStart(candidate.sourceFile)
	).line;
	const endLine = candidate.sourceFile.getLineAndCharacterOfPosition(candidate.body.end).line;
	return {
		file: candidate.file,
		source: candidate.source,
		name: candidate.name,
		position: candidate.nameNode.getStart(candidate.sourceFile),
		line:
			candidate.sourceFile.getLineAndCharacterOfPosition(
				candidate.nameNode.getStart(candidate.sourceFile)
			).line + 1,
		fingerprint,
		tokens,
		lines: endLine - startLine + 1
	};
}

function scanTypeScript(record, collector, shared) {
	const { file, source, sourceFile } = record;
	const lines = source.split('\n').length;
	if (lines > 500) collector.add('P1', file, source, 0, `${lines} lines`);
	recordThinFile(collector, file, source);
	if (sourceFile.parseDiagnostics.length) {
		collector.add(
			'SCAN',
			file,
			source,
			sourceFile.parseDiagnostics[0].start ?? 0,
			sourceFile.parseDiagnostics[0].messageText.toString()
		);
	}
	finalizeReactiveAnalysis(collector, file, source, analyzeTsReactivity(sourceFile));
	const modelSurface = collectionModelSurface(record);
	if (modelSurface) shared.collectionModels.push(modelSurface);

	const fileReferences = new Map();
	shared.referencesByFile.set(file, fileReferences);
	const reassignedFunctions = new Set();
	shared.reassignedFunctionsByFile.set(file, reassignedFunctions);
	const schemaNames = collectTsZodSchemaTypeNames(sourceFile);

	function visit(node) {
		recordTsEnvRethrow(collector, file, source, sourceFile, node);
		if (ts.isIdentifier(node) && isTsValueReference(node)) {
			incrementReference(fileReferences, node.text);
		}
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
			node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
			ts.isIdentifier(node.left)
		) {
			reassignedFunctions.add(node.left.text);
		}
		if (isTsQualityDeclaration(node)) {
			recordTsQuality(collector, file, source, sourceFile, node);
		}
		if (isTsFunctionLikeCandidate(node)) {
			const candidate = {
				...tsCandidateParts(node),
				file,
				source,
				sourceFile,
				exported: isTsExportedCandidate(node)
			};
			shared.functionCandidates.push(candidate);
			if (tsThinWrapper(candidate))
				collector.add(
					'Q1',
					file,
					source,
					candidate.nameNode.getStart(sourceFile),
					`name=${candidate.name}`
				);
			if (candidate.functionNode.type && ts.isTypePredicateNode(candidate.functionNode.type)) {
				collector.add('R5b', file, source, candidate.functionNode.type.getStart(sourceFile));
			}
			shared.duplicateCandidates.push(tsDuplicateCandidate(candidate));
			const canonicalHelper = CANONICAL_STD_HELPERS.get(candidate.name);
			if (canonicalHelper) {
				collector.add(
					'STD1',
					file,
					source,
					candidate.nameNode.getStart(sourceFile),
					`name=${candidate.name} prefer=${canonicalHelper}`
				);
			}
		}
		if (
			node.kind === ts.SyntaxKind.AnyKeyword &&
			!(ts.isAsExpression(node.parent) || ts.isTypeAssertionExpression(node.parent)) &&
			isTsAnyInSignature(node)
		) {
			collector.add('R1', file, source, node.getStart(sourceFile));
		}
		if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
			const type = node.type;
			if (
				(ts.isAsExpression(node.expression) || ts.isTypeAssertionExpression(node.expression)) &&
				isTsUnknown(node.expression.type)
			) {
				collector.add('R3b', file, source, node.expression.type.getStart(sourceFile));
			} else if (isTsAny(type)) collector.add('R3f', file, source, type.getStart(sourceFile));
			else if (isTsUnknown(type)) {
				if (!(ts.isAsExpression(node.parent) && node.parent.expression === node))
					collector.add('R3e', file, source, type.getStart(sourceFile));
			} else if (isTsRecordUnknown(type))
				collector.add('R3a', file, source, type.getStart(sourceFile));
			else if (isTsJsonParse(node.expression))
				collector.add('R6a', file, source, type.getStart(sourceFile));
			else if (isNamedTsType(type, sourceFile))
				collector.add(
					'R3c',
					file,
					source,
					type.getStart(sourceFile),
					`type=${tsText(type, sourceFile)}`
				);
		}
		if (ts.isCallExpression(node)) {
			const browserDialog = tsBrowserDialogName(node);
			if (browserDialog)
				collector.add('UI4', file, source, node.getStart(sourceFile), `api=${browserDialog}`);
			if (isTsJsonParse(node)) {
				if (node.arguments[0] && isTsJsonStringify(node.arguments[0]))
					collector.add('CLONE', file, source, node.getStart(sourceFile));
				else if (!(
					ts.isAsExpression(node.parent) ||
					ts.isTypeAssertionExpression(node.parent) ||
					isTsValidatedJsonParse(node)
				)) {
					collector.add('R6b', file, source, node.getStart(sourceFile));
				}
			}
			if (
				ts.isIdentifier(node.expression) &&
				['setTimeout', 'setInterval'].includes(node.expression.text) &&
				ts.isExpressionStatement(node.parent)
			) {
				collector.add('A1', file, source, node.getStart(sourceFile));
			}
			if (
				ts.isPropertyAccessExpression(node.expression) &&
				node.expression.expression.getText(sourceFile) === 'Array' &&
				node.expression.name.text === 'from' &&
				node.arguments[0] &&
				ts.isNewExpression(node.arguments[0]) &&
				node.arguments[0].expression.getText(sourceFile) === 'Set'
			) {
				collector.add('S5', file, source, node.getStart(sourceFile));
			}
			const effectKind = isTsEffectCall(node);
			if (effectKind) {
				recordEffectCall(
					collector,
					file,
					source,
					node.getStart(sourceFile),
					node.arguments[0],
					effectKind
				);
			}
			if (ts.isIdentifier(node.expression) && node.expression.text === 'onMount') {
				const callback = node.arguments[0];
				if (
					callback &&
					ts.isFunctionLike(callback) &&
					callback.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.AsyncKeyword)
				) {
					collector.add('V5', file, source, node.getStart(sourceFile));
				}
			}
		}
		if (isTsTimerPromise(node, sourceFile)) {
			collector.add(
				'STD2',
				file,
				source,
				node.getStart(sourceFile),
				'prefer=@norbital-ai/std#delay|withTimeout'
			);
		}
		if (ts.isCatchClause(node)) {
			if (
				!node.block.statements.length &&
				!/teardown[^\n]*ignore|stupidity:ignore/i.test(node.block.getText(sourceFile))
			) {
				collector.add('S1', file, source, node.getStart(sourceFile));
			}
			if (node.block.statements.length === 1 && ts.isThrowStatement(node.block.statements[0]))
				collector.add('A5', file, source, node.getStart(sourceFile));
		}
		if (
			isTsLoop(node) &&
			!(ts.isForOfStatement(node) && node.awaitModifier) &&
			tsContainsAwait(node.statement)
		) {
			collector.add('A6', file, source, node.getStart(sourceFile));
		}
		if (ts.isExportDeclaration(node) && !node.exportClause)
			collector.add('P9', file, source, node.getStart(sourceFile));
		if (ts.isTypeAliasDeclaration(node)) {
			recordTypeDeclaration(collector, shared, file, source, node, sourceFile, schemaNames);
			if (ts.isTypeReferenceNode(node.type) && !node.type.typeArguments?.length)
				collector.add('AL1', file, source, node.getStart(sourceFile));
			if (
				[
					ts.SyntaxKind.StringKeyword,
					ts.SyntaxKind.NumberKeyword,
					ts.SyntaxKind.BooleanKeyword,
					ts.SyntaxKind.UnknownKeyword
				].includes(node.type.kind)
			) {
				collector.add('AL2', file, source, node.getStart(sourceFile));
			}
			if (isTsRecordUnknown(node.type))
				collector.add('AL3', file, source, node.getStart(sourceFile));
		}
		if (ts.isInterfaceDeclaration(node)) {
			recordTypeDeclaration(collector, shared, file, source, node, sourceFile, schemaNames);
		}
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
		) {
			const left = tsNullishComparison(node.left);
			const right = tsNullishComparison(node.right);
			if (
				left &&
				right &&
				left.kind !== right.kind &&
				left.operator === right.operator &&
				sameTsExpression(left.expression, right.expression, sourceFile)
			) {
				collector.add('S3', file, source, node.getStart(sourceFile));
			}
			if (tsHasPropertyEquality(node.left) && tsHasPropertyEquality(node.right))
				collector.add('R5c', file, source, node.getStart(sourceFile));
			if (tsContainsOperator(node, ts.SyntaxKind.InKeyword))
				collector.add('R5d', file, source, node.getStart(sourceFile));
		}
		if (
			ts.isIfStatement(node) &&
			node.elseStatement &&
			sameLogic(node.thenStatement.getText(sourceFile), node.elseStatement.getText(sourceFile))
		) {
			collector.add('D2', file, source, node.getStart(sourceFile), 'kind=if');
		}
		if (
			ts.isConditionalExpression(node) &&
			sameLogic(node.whenTrue.getText(sourceFile), node.whenFalse.getText(sourceFile))
		) {
			collector.add('D2', file, source, node.getStart(sourceFile), 'kind=ternary');
		}
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			/^(ENABLE|DISABLE|USE|SKIP)_[A-Z_]+$/.test(node.name.text)
		) {
			collector.add('E2', file, source, node.name.getStart(sourceFile));
		}
		if (ts.isPropertyAccessExpression(node)) {
			const text = node.getText(sourceFile);
			if (/^(import\.meta\.env\.(DEV|PROD|MODE)|process\.env\.NODE_ENV)$/.test(text))
				collector.add('E1', file, source, node.getStart(sourceFile));
		}
		if (
			ts.isAsExpression(node) &&
			ts.isArrayTypeNode(node.type) &&
			isTsUnknown(node.type.elementType) &&
			/rows$/.test(node.expression.getText(sourceFile))
		) {
			collector.add('R7', file, source, node.getStart(sourceFile));
		}
		if (
			ts.isTypeParameterDeclaration(node) &&
			node.default &&
			isTsUnknown(node.default) &&
			node.name.text === 'T'
		) {
			collector.add('R7', file, source, node.getStart(sourceFile));
		}
		if (
			ts.isVoidExpression(node) &&
			ts.isCallExpression(node.expression) &&
			ts.isParenthesizedExpression(node.expression.expression) &&
			ts.isArrowFunction(node.expression.expression.expression) &&
			node.expression.expression.expression.modifiers?.some(
				({ kind }) => kind === ts.SyntaxKind.AsyncKeyword
			)
		) {
			collector.add('V6', file, source, node.getStart(sourceFile));
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	if (isSvelteRuneModule(file)) {
		function visitRuneHygiene(node) {
			recordTsRuneHygiene(collector, file, source, sourceFile, node, reassignedFunctions);
			ts.forEachChild(node, visitRuneHygiene);
		}
		visitRuneHygiene(sourceFile);
	}
}

function estreeChildren(node) {
	const children = [];
	for (const [key, value] of Object.entries(node)) {
		if (
			['loc', 'comments', 'leadingComments', 'trailingComments', 'tokens', 'metadata'].includes(key)
		)
			continue;
		if (Array.isArray(value)) {
			for (const item of value)
				if (item && typeof item === 'object' && typeof item.type === 'string') children.push(item);
		} else if (value && typeof value === 'object' && typeof value.type === 'string')
			children.push(value);
	}
	return children;
}

function walkEstree(root, callback) {
	if (!root) return;
	function visit(node, parent, ancestors) {
		callback(node, parent, ancestors);
		for (const child of estreeChildren(node)) visit(child, node, [...ancestors, node]);
	}
	visit(root, null, []);
}

function estreeMemberName(node) {
	if (node?.type !== 'MemberExpression') return null;
	if (!node.computed && node.property?.type === 'Identifier') return node.property.name;
	if (node.computed && node.property?.type === 'Literal') return node.property.value;
	return null;
}

function estreeEffectKind(callee) {
	if (callee?.type === 'Identifier' && callee.name === '$effect') return 'effect';
	if (
		callee?.type === 'MemberExpression' &&
		callee.object?.type === 'Identifier' &&
		callee.object.name === '$effect'
	) {
		const name = estreeMemberName(callee);
		return name === 'pre' || name === 'root' ? name : null;
	}
	return null;
}

function estreeInlineLayoutFindings(node, collector, file, source) {
	if (node.type !== 'RegularElement') return;
	if (LAYOUT_TABLE_NAMES.has(node.name) || LAYOUT_MEDIA_NAMES.has(node.name)) return;
	if (estreeIsControlElement(node)) return;
	const style = estreeStaticAttribute(node, 'style');
	if (!style) return;
	if (/\bdisplay\s*:\s*(?:inline-)?(?:flex|grid)\b/i.test(style)) {
		collector.add('UI6', file, source, node.start, `tag=${node.name} style=${style}`);
	} else if (/\bgrid-template-(?:columns|rows)\s*:/i.test(style)) {
		collector.add('UI6', file, source, node.start, `tag=${node.name} style=${style}`);
	}
	if (/\boverflow(?:-(?:x|y))?\s*:\s*(?:auto|scroll)\b/i.test(style)) {
		collector.add('UI5', file, source, node.start, `tag=${node.name} style=${style}`);
	}
}

function isEstreeJsonCall(node, method) {
	return (
		node?.type === 'CallExpression' &&
		node.callee?.type === 'MemberExpression' &&
		node.callee.object?.type === 'Identifier' &&
		node.callee.object.name === 'JSON' &&
		estreeMemberName(node.callee) === method
	);
}

function estreeTypeName(type) {
	if (type?.type !== 'TSTypeReference') return null;
	if (type.typeName?.type === 'Identifier') return type.typeName.name;
	return null;
}

function isEstreeRecordUnknown(type) {
	return (
		estreeTypeName(type) === 'Record' &&
		type.typeParameters?.params?.length === 2 &&
		type.typeParameters.params[0].type === 'TSStringKeyword' &&
		type.typeParameters.params[1].type === 'TSUnknownKeyword'
	);
}

function isEstreeValueReference(node, parent) {
	if (node.type !== 'Identifier' || !parent) return false;
	if (
		(parent.id === node &&
			[
				'FunctionDeclaration',
				'FunctionExpression',
				'VariableDeclarator',
				'ClassDeclaration'
			].includes(parent.type)) ||
		(parent.key === node &&
			!parent.computed &&
			['Property', 'PropertyDefinition', 'MethodDefinition'].includes(parent.type)) ||
		[
			'ImportSpecifier',
			'ImportDefaultSpecifier',
			'ImportNamespaceSpecifier',
			'ExportSpecifier',
			'TSTypeReference',
			'TSQualifiedName'
		].includes(parent.type) ||
		(parent.params?.includes(node) ?? false)
	) {
		return false;
	}
	return true;
}

function isEstreeLoop(node) {
	return [
		'ForStatement',
		'ForInStatement',
		'ForOfStatement',
		'WhileStatement',
		'DoWhileStatement'
	].includes(node.type);
}

function estreeContainsAwait(root) {
	let found = false;
	function visit(node, isRoot) {
		if (found) return;
		if (
			!isRoot &&
			(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(
				node.type
			) ||
				isEstreeLoop(node))
		)
			return;
		if (node.type === 'AwaitExpression') {
			found = true;
			return;
		}
		for (const child of estreeChildren(node)) visit(child, false);
	}
	visit(root, true);
	return found;
}

function estreeContains(root, predicate) {
	let found = false;
	function visit(node) {
		if (found) return;
		if (predicate(node)) {
			found = true;
			return;
		}
		for (const child of estreeChildren(node)) visit(child);
	}
	for (const child of estreeChildren(root)) visit(child);
	return found;
}

function estreeStaticAttribute(node, name) {
	const attribute = node.attributes?.find(
		(candidate) => candidate.type === 'Attribute' && candidate.name === name
	);
	if (!attribute || !Array.isArray(attribute.value) || attribute.value.length !== 1) return null;
	return attribute.value[0]?.type === 'Text' ? attribute.value[0].data : null;
}

/**
 * Resolve a boolean-ish attribute for layout contracts.
 *
 * - `null` — attribute absent
 * - `true` / `false` — statically known (`bounded`, `bounded="true"`, `bounded={true|false}`)
 * - `undefined` — present but dynamic (`bounded={someFlag}`); do not guess
 */
function estreeBooleanAttribute(node, name) {
	const attribute = node.attributes?.find(
		(candidate) => candidate.type === 'Attribute' && candidate.name === name
	);
	if (!attribute) return null;
	if (attribute.value === true || attribute.value == null) return true;
	const parts = estreeAttributeParts(attribute);
	if (!parts || parts.length !== 1) return undefined;
	const part = parts[0];
	if (part.type === 'Text') {
		if (part.data === 'true') return true;
		if (part.data === 'false') return false;
		return undefined;
	}
	if (part.type === 'ExpressionTag') {
		const expression = part.expression;
		if (expression?.type === 'Literal' && typeof expression.value === 'boolean') {
			return expression.value;
		}
	}
	return undefined;
}

function matrixYieldsVerticalScroll(node) {
	return estreeBooleanAttribute(node, 'bounded') === false;
}

function isVerticalScrollOwnerComponent(node) {
	if (node?.type !== 'Component') return false;
	if (node.name === 'Tabs') {
		// List-only tabs (`showContent={false}`) are chrome, not a scrollport.
		return estreeBooleanAttribute(node, 'showContent') !== false;
	}
	if (VERTICAL_SCROLL_OWNERS.has(node.name)) {
		if (node.name === 'MatrixRenderer') return !matrixYieldsVerticalScroll(node);
		return true;
	}
	// Template wrappers like `JobForm` embed `CollectionForm` and therefore own scroll.
	return /Form$/.test(node.name) && node.name !== 'Field';
}

/**
 * Nested scrollports on the same axis trap the wheel — often with no visible scrollbar.
 *
 * Catches:
 * 1. `<Scroll>` wrapping another scroll owner (`CollectionForm`, `*Form`, `CollectionTable`,
 *    `Tabs`, nested `Scroll`, or a bounded `MatrixRenderer`).
 * 2. `MatrixRenderer` without an explicit `bounded` prop (default `true` owns scroll and will
 *    trap inside forms/sheets). Call sites must write `bounded={false}` to yield, or
 *    `bounded={true}` when they deliberately own a Bound height.
 */
function estreeScrollTrapFindings(node, collector, file, source) {
	if (node.type !== 'Component') return;

	if (node.name === 'MatrixRenderer') {
		// The matrix implementation itself wires CollectionGrid; do not self-flag.
		if (/(^|\/)matrix\.renderer\.svelte$/.test(file)) return;
		const bounded = estreeBooleanAttribute(node, 'bounded');
		// Explicit true/false is an ownership decision. Dynamic expressions are unknowable here.
		if (bounded === false || bounded === true || bounded === undefined) return;
		collector.add(
			'UI16',
			file,
			source,
			node.start,
			'MatrixRenderer missing bounded={false|true}; default owns scroll and traps parents'
		);
		return;
	}

	if (node.name !== 'Scroll') return;
	let nested = null;
	function visit(candidate, isRoot) {
		if (nested) return;
		if (!isRoot && isVerticalScrollOwnerComponent(candidate)) {
			nested = candidate.name;
			return;
		}
		for (const child of estreeChildren(candidate)) visit(child, false);
	}
	for (const child of estreeChildren(node)) visit(child, false);
	if (!nested) return;
	collector.add(
		'UI16',
		file,
		source,
		node.start,
		`Scroll nests ${nested} — never nest two vertical scrollports`
	);
}

/**
 * System uuids must not reach operators. Templates resolve relations to human labels.
 *
 * Detects:
 * - `Column`/`Field` named `norbital_id`
 * - `label="… Id"` on an `*_id` field (humanize already produces this — forbid it)
 * - bare `Field name="*_id"` without an explicit human `label`
 * - `labels.get(…) ?? value` style fallbacks that paint the uuid when the map misses
 */
const UUID_LABEL_FALLBACK_PATTERN =
	/\.get\s*\(\s*(?:String\s*\(\s*value\s*\)|value)\s*\)\s*\?\?\s*(?:value|String\s*\(\s*value\s*\))/g;

function isUiPackageSource(file) {
	return /(^|\/)packages\/ui\//.test(file);
}

function estreeUuidExposureFindings(node, collector, file, source) {
	if (isUiPackageSource(file)) return;
	if (node.type !== 'Component') return;
	if (node.name !== 'Column' && node.name !== 'Field') return;

	const fieldName = estreeStaticAttribute(node, 'name');
	const label = estreeStaticAttribute(node, 'label');
	if (fieldName === 'norbital_id') {
		collector.add(
			'UI17',
			file,
			source,
			node.start,
			`${node.name} name=norbital_id — system keys are not operator-facing`
		);
	}
	if (fieldName && /_id$/.test(fieldName) && label && /\bId\b/.test(label)) {
		collector.add(
			'UI17',
			file,
			source,
			node.start,
			`${node.name} label="${label}" on ${fieldName} — use the entity name, not “… Id”`
		);
	}
	if (node.name === 'Field' && fieldName && /_id$/.test(fieldName)) {
		const hasRenderer = (node.attributes ?? []).some(
			(attribute) => attribute.type === 'Attribute' && attribute.name === 'renderer'
		);
		if (!hasRenderer) {
			collector.add(
				'UI17',
				file,
				source,
				node.start,
				`Field name=${fieldName} needs RelationshipRenderer (or custom) — bare uuid fields paint the id`
			);
		}
	}
}

function uuidLabelFallbackFindings(source, collector, file) {
	if (isUiPackageSource(file) || !file.endsWith('.svelte')) return;
	const scannable = source
		.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
		.replace(/\/\/[^\n]*/g, (comment) => ' '.repeat(comment.length))
		.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
	UUID_LABEL_FALLBACK_PATTERN.lastIndex = 0;
	for (const match of scannable.matchAll(UUID_LABEL_FALLBACK_PATTERN)) {
		collector.add(
			'UI17',
			file,
			source,
			match.index ?? 0,
			'label map falls back to raw value — use “—” when unresolved'
		);
	}
}

/*
 * ── UI17a/b/c — the uuid surfaces no `.svelte` node can show ──────────────────
 *
 * UI17 inspects `<Column>` and `<Field>` nodes, so it can only see a uuid a template *authored*.
 * Three whole classes of uuid exposure never appear as a component node at all:
 *
 * - the auto `CollectionForm` a collection falls back to when it has no `+representation.svelte`
 *   paints one editable text box per uuid FK, and there is no source node to flag (UI17a);
 * - a `custom()` column is one JSONB value, so the uuids inside it are typed into raw `<Input>`s or
 *   interpolated into summary strings by the custom-type renderer (UI17b);
 * - `recordLabel` is a string array in `+model.ts`, and a label whose every term is empty falls back
 *   to joining every scalar column — which is how a record-detail title comes to be two uuids
 *   (UI17c). Coercion is not the fault: `resolveRecordLabel` renders dates, numbers and booleans
 *   and drops null terms. Naming a column with no text in it — an id, or a JSONB object — is.
 *
 * All three are errors: each one paints an id an operator cannot act on, and none of them can be
 * found by reading the template.
 */

/**
 * Column builders whose value can never become label text.
 *
 * A `custom()` or `json()` column is one JSONB object, and an object is not a title: no coercion
 * turns `{"kind":"PAID"}` into something worth printing, so `labelTermText` drops it.
 *
 * Scalars are deliberately NOT listed. `resolveRecordLabel` in `@norbital-ai/platform-utils`
 * evaluates the compiled label term by term and coerces each one — a `Date` renders ISO, numbers
 * and booleans stringify, a null term is left out and the survivors join. So a `date()`, an
 * `integer()` or a nullable column in a multi-field label is correct as written, and composing the
 * same title in SQL instead is both a duplicate of that coercion and, with `to_char`, a generated
 * expression PostgreSQL rejects as not immutable.
 */
const OPAQUE_COLUMN_BUILDERS = new Set(['custom', 'json', 'jsonb']);
/** Builders whose value IS a system id — forbidden in a label whatever its JavaScript type. */
const ID_COLUMN_BUILDERS = new Set(['uuid', 'file']);
const COLLECTION_MODEL_PATTERN = /(?:^|\/)src\/collections\/([^/]+)\/\+model\.ts$/;
const CUSTOM_TYPE_RENDERER_PATTERN = /(?:^|\/)src\/custom-types\/([^/]+)\/\+renderer\.svelte$/;

/** The builder a column declaration starts from, plus the chained modifier names. */
function tsColumnBuilder(expression) {
	let node = expression;
	const chain = [];
	while (node && ts.isCallExpression(node)) {
		if (ts.isIdentifier(node.expression)) return { builder: node.expression.text, chain };
		if (ts.isPropertyAccessExpression(node.expression)) {
			chain.push(node.expression.name.text);
			node = node.expression.expression;
			continue;
		}
		return null;
	}
	return null;
}

function tsPropertyName(property) {
	if (!ts.isPropertyAssignment(property)) return null;
	if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
		return property.name.text;
	return null;
}

/**
 * The columns and record label of a `+model.ts`.
 *
 * Read from the `defineModel(columns, metadata)` call rather than by importing it: the scanner
 * never executes workspace source, and the declaration is entirely static.
 */
function collectionModelSurface(record) {
	const match = COLLECTION_MODEL_PATTERN.exec(record.file);
	if (!match) return null;
	let call = null;
	const findCall = (node) => {
		if (call) return;
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === 'defineModel'
		) {
			call = node;
			return;
		}
		ts.forEachChild(node, findCall);
	};
	findCall(record.sourceFile);
	if (!call) return null;

	const [columnsArgument, metadataArgument] = call.arguments;
	const columns = new Map();
	if (columnsArgument && ts.isObjectLiteralExpression(columnsArgument)) {
		for (const property of columnsArgument.properties) {
			const name = tsPropertyName(property);
			if (!name) continue;
			const parsed = tsColumnBuilder(property.initializer);
			if (!parsed) continue;
			columns.set(name, {
				builder: parsed.builder,
				nullable: !parsed.chain.includes('notNull'),
				position: property.getStart(record.sourceFile)
			});
		}
	}

	let recordLabel = null;
	let recordLabelPosition = call.getStart(record.sourceFile);
	if (metadataArgument && ts.isObjectLiteralExpression(metadataArgument)) {
		for (const property of metadataArgument.properties) {
			if (tsPropertyName(property) !== 'recordLabel') continue;
			recordLabelPosition = property.getStart(record.sourceFile);
			const initializer = property.initializer;
			if (ts.isStringLiteral(initializer)) recordLabel = [initializer.text];
			else if (ts.isArrayLiteralExpression(initializer))
				recordLabel = initializer.elements
					.filter((element) => ts.isStringLiteral(element))
					.map((element) => element.text);
		}
	}

	return {
		file: record.file,
		source: record.source,
		collection: match[1],
		directory: dirname(record.file),
		columns,
		recordLabel,
		recordLabelPosition
	};
}

/** `z.uuid()`, including through `nullable`/`optional`/`check` wrappers — but never through an object. */
function isDirectZodUuid(node) {
	if (!node || !ts.isCallExpression(node)) return false;
	if (!ts.isPropertyAccessExpression(node.expression)) return false;
	const method = node.expression.name.text;
	if (method === 'uuid') return true;
	if (method === 'check') return isDirectZodUuid(node.expression.expression);
	if (['nullable', 'optional', 'readonly'].includes(method))
		return isDirectZodUuid(node.arguments[0]);
	return false;
}

/** Field names a custom type declares as uuids, from its `+definition.ts`. */
function customTypeUuidFields(directory, shared) {
	const cached = shared.customTypeUuidFields.get(directory);
	if (cached) return cached;
	const relative = `${directory}/+definition.ts`;
	const absolute = join(shared.root, relative);
	const fields = new Set();
	if (existsSync(absolute)) {
		const sourceFile = ts.createSourceFile(
			relative,
			readFileSync(absolute, 'utf8'),
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS
		);
		const visit = (node) => {
			const name = tsPropertyName(node);
			if (name && isDirectZodUuid(node.initializer)) fields.add(name);
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	shared.customTypeUuidFields.set(directory, fields);
	return fields;
}

function referencesField(text, field) {
	return new RegExp(`(?:^|[^\\w$])${field}(?:[^\\w$]|$)`).test(text);
}

/**
 * UI17b, edit half: a uuid field typed into a raw `<Input>`.
 *
 * The operator is being asked to know a uuid by heart. The fix is the same option set a column FK
 * would have got — an inline `Combobox` (or `RelationshipRenderer`/`DataRenderer`) over the target
 * collection, labelled `code · name`.
 */
function estreeCustomTypeUuidFindings(node, collector, file, source, uuidFields) {
	if (uuidFields.size === 0) return;
	if (node.type !== 'Component' && node.type !== 'RegularElement') return;
	if (node.name !== 'Input' && node.name !== 'input' && node.name !== 'textarea') return;
	/*
	 * Only what the control is *bound* to counts. A handler that carries an id through an edit —
	 * `population_contribution_id: current?.…?.population_contribution_id ?? null` inside the
	 * neighbouring field's `oninput` — preserves the value rather than showing it, and reading the
	 * whole element would call that an exposure.
	 */
	const bound = (node.attributes ?? []).filter(
		(attribute) =>
			(attribute.type === 'Attribute' && ['value', 'defaultValue'].includes(attribute.name)) ||
			(attribute.type === 'BindDirective' && attribute.name === 'value')
	);
	if (bound.length === 0) return;
	const text = bound.map((attribute) => source.slice(attribute.start, attribute.end)).join('\n');
	for (const field of uuidFields) {
		if (!referencesField(text, field)) continue;
		collector.add(
			'UI17b',
			file,
			source,
			node.start,
			`${field} is typed into a raw <${node.name}> — offer the record through a picker, never its uuid`
		);
	}
}

/**
 * UI17b, display half: a uuid field interpolated into a summary string.
 *
 * `payslip_line_component` printed `single-use entry · 130b9e77-…` on every payslip breakdown row
 * this way. The template literal is in the script, so no markup node carries the id.
 */
/**
 * UI17b, blob half: a variant carrying uuids edited as raw JSON.
 *
 * A `JSON.stringify` bound to a textarea or code editor paints every id in the value at once, and
 * no field name appears in any bound attribute — the two checks above cannot see it. This is what
 * put `{days, kind, …, certificate_file}` on the leave request panel. A variant is a form: give it
 * one control per field, and a picker for every id.
 */
function customTypeJsonEditorFindings(source, collector, file, uuidFields) {
	if (uuidFields.size === 0) return;
	if (!/<textarea|CodeEditor/.test(source)) return;
	const serialized = source.indexOf('JSON.stringify(');
	if (serialized === -1) return;
	collector.add(
		'UI17b',
		file,
		source,
		serialized,
		`the value is edited as raw JSON, which paints ${[...uuidFields].join(', ')} — one control per field, and a picker for each id`
	);
}

function customTypeUuidDisplayFindings(source, collector, file, uuidFields) {
	if (uuidFields.size === 0) return;
	for (const match of source.matchAll(/`[^`]*`/g)) {
		const literal = match[0];
		if (!literal.includes('${')) continue;
		for (const field of uuidFields) {
			if (!referencesField(literal, field)) continue;
			collector.add(
				'UI17b',
				file,
				source,
				match.index ?? 0,
				`${field} is interpolated into display text — print what the id names, or nothing`
			);
		}
	}
}

/**
 * UI17a and UI17c, which are answered by the model rather than by any template.
 *
 * Deferred to a finalize pass because both need the whole scope: whether a sibling
 * `+representation.svelte` exists at all, and which columns a label names.
 */
function finalizeUuidSurfaces(collector, shared, scope) {
	const present = new Set(scope.allFiles);
	for (const model of shared.collectionModels) {
		const idColumns = [...model.columns].filter(([, column]) =>
			ID_COLUMN_BUILDERS.has(column.builder)
		);
		if (idColumns.length > 0 && !present.has(`${model.directory}/+representation.svelte`)) {
			collector.add(
				'UI17a',
				model.file,
				model.source,
				idColumns[0][1].position,
				`${model.collection} declares ${idColumns.map(([name]) => name).join(', ')} and has no +representation.svelte — ` +
					'the auto CollectionForm paints every one of them as an editable uuid'
			);
		}

		if (!model.recordLabel || model.recordLabel.length === 0) continue;
		/*
		 * One finding per label, not per term. The collector keys a finding by file and line, so a
		 * label with two dead terms reported only whichever was checked first, and a reader fixing
		 * that one would be told the same label is still broken. Each dead term states its own reason.
		 *
		 * Only terms that can never produce text count. Coercion is `resolveRecordLabel`'s job and it
		 * does it — the fault is naming something there is no text in, not naming a non-string.
		 */
		const faults = [];
		for (const field of model.recordLabel) {
			const column = model.columns.get(field);
			if (!column) {
				faults.push(`${field} is not a column of ${model.collection}`);
				continue;
			}
			if (ID_COLUMN_BUILDERS.has(column.builder)) {
				faults.push(
					`${field} is a ${column.builder}() system id, and a record title is never an id`
				);
				continue;
			}
			if (OPAQUE_COLUMN_BUILDERS.has(column.builder))
				faults.push(`${field} is a ${column.builder}() object, which has no text to print`);
		}
		if (faults.length === 0) continue;
		/*
		 * A label keeps working as long as ONE term survives, so say which of the two happened. The
		 * fix for either is to name a column that holds text — never to compose the title in SQL: a
		 * `generatedAlwaysAs` over `to_char(...)` is not immutable and PostgreSQL refuses the column.
		 */
		const allDead = faults.length === model.recordLabel.length;
		collector.add(
			'UI17c',
			model.file,
			model.source,
			model.recordLabelPosition,
			`${faults.join('; ')} — ${
				allDead
					? 'no term can produce text, so the label resolves to nothing and the title falls back to joining every scalar column, uuids included'
					: 'the term contributes nothing and the title is silently shorter than it reads'
			}`
		);
	}
}

/** Static `class="..."` value when the class attribute has no expressions. */
function estreeClassAttribute(node) {
	return node.attributes?.find(
		(candidate) => candidate.type === 'Attribute' && candidate.name === 'class'
	);
}

/**
 * `Attribute.value` is an array only when the attribute mixes text and expressions.
 *
 * A lone `class={cn(...)}` parses to the bare `ExpressionTag`, and `class="x"` to a single `Text`.
 * Every reader here that guarded on `Array.isArray` therefore silently skipped exactly the form
 * that matters most — the layout rules were only ever seeing quoted literals.
 */
function estreeAttributeParts(attribute) {
	if (!attribute) return null;
	if (attribute.value === true) return [];
	return Array.isArray(attribute.value) ? attribute.value : [attribute.value];
}

/**
 * The class exactly as written, or `null` when any part of it is an expression.
 *
 * Only rules that reason about the *whole* class may use this — `UI11` asks whether a wrapper
 * carries nothing but `contents`, and a class it cannot fully read might carry anything.
 */
function estreeStaticClass(node) {
	const parts = estreeAttributeParts(estreeClassAttribute(node));
	if (!parts) return null;
	if (parts.some((part) => part.type !== 'Text')) return null;
	return parts.map((part) => part.data).join(' ');
}

/**
 * Every class name that is statically knowable, including through expressions.
 *
 * `estreeStaticClass` gives up the moment a class attribute holds an expression, and in a Svelte
 * codebase that is most of them — `class={cn('flex-1', x)}`, `class="border {tone}"`, and
 * `class={open ? 'items-center' : 'items-start'}` were all invisible to every layout rule. That is
 * not a conservative default: a class does the same thing to the layout whether it arrives through
 * a literal or through `cn`, so skipping expressions did not avoid false positives, it just meant
 * the rules ran on a small and arbitrary subset of the code.
 *
 * Collecting the string literals reachable inside the expression is sound for rules that ask "does
 * this class list contain X": a name has to appear as a literal somewhere to reach the DOM, and a
 * name that appears in only one branch of a conditional is still a name the element can carry.
 * Classes composed at runtime are not knowable here at all — `UI12` is what rejects those.
 */
function estreeKnownClasses(node) {
	const parts = estreeAttributeParts(estreeClassAttribute(node));
	if (!parts) return null;
	const found = [];
	const visitExpression = (expression) => {
		if (!expression || typeof expression !== 'object') return;
		switch (expression.type) {
			case 'Literal':
				if (typeof expression.value === 'string') found.push(expression.value);
				return;
			case 'TemplateLiteral':
				for (const quasi of expression.quasis) found.push(quasi.value.cooked ?? '');
				for (const part of expression.expressions) visitExpression(part);
				return;
			case 'ConditionalExpression':
				visitExpression(expression.consequent);
				visitExpression(expression.alternate);
				return;
			case 'LogicalExpression':
				visitExpression(expression.left);
				visitExpression(expression.right);
				return;
			case 'CallExpression':
				// `cn(...)`, `clsx(...)`, `twMerge(...)` and friends — the arguments are the classes.
				for (const argument of expression.arguments) visitExpression(argument);
				return;
			case 'ArrayExpression':
				for (const element of expression.elements) visitExpression(element);
				return;
			case 'ObjectExpression':
				// `{ 'items-center': isCentred }` — the key is the class.
				for (const property of expression.properties) {
					if (property.type !== 'Property') continue;
					if (property.key?.type === 'Literal' && typeof property.key.value === 'string') {
						found.push(property.key.value);
					} else if (property.key?.type === 'Identifier' && !property.computed) {
						found.push(property.key.name);
					}
				}
				return;
			default:
		}
	};
	for (const part of parts) {
		if (part.type === 'Text') found.push(part.data);
		else if (part.type === 'ExpressionTag') visitExpression(part.expression);
	}
	const classes = found.join(' ').trim();
	return classes === '' ? null : classes;
}

function estreeIsControlElement(node) {
	return LAYOUT_CONTROL_NAMES.has(node.name);
}

/** Layout or scroll classes applied to a layout primitive bypass its named props. */
function estreePrimitiveClassFindings(node, classValue, collector, file, source) {
	const overrides = [];
	if (PRIMITIVE_DISPLAY_OVERRIDE.test(classValue)) overrides.push('display');
	if (PRIMITIVE_OVERFLOW_OVERRIDE.test(classValue)) overrides.push('overflow');
	if (LAYOUT_GAP_OWNERS.has(node.name) && PRIMITIVE_GAP_OVERRIDE.test(classValue))
		overrides.push('gap');
	if (LAYOUT_ALIGN_OWNERS.has(node.name) && PRIMITIVE_ALIGN_OVERRIDE.test(classValue))
		overrides.push('align');
	// `flex-1`/`h-full` on a primitive that has `grow`/`fill` props is the same override in class
	// form — and it is how a layout ends up depending on a parent's flex context rather than saying
	// what it wants.
	if (PRIMITIVE_GROWTH_OVERRIDE.test(classValue) && LAYOUT_GROWTH_OWNERS.has(node.name)) {
		overrides.push('growth');
	}
	// Redundant fill classes: block-level primitives own width (Center is the exception:
	// its max-width measure needs its own w-full), and Cover/Bound/Scroll own height.
	const ownsHeight = ['Cover', 'Bound', 'Scroll'].includes(node.name);
	if (
		(/(?<!max-)(?<!min-)\bw-full\b/.test(classValue) && node.name !== 'Center') ||
		(/\bh-full\b/.test(classValue) && ownsHeight)
	) {
		overrides.push('size');
	}
	if (overrides.length === 0) return;
	collector.add(
		'UI10',
		file,
		source,
		node.start,
		`tag=${node.name} overrides=${overrides.join('+')} class=${classValue}`
	);
}

/**
 * Spacing between siblings belongs to the parent, never to the children.
 *
 * This is the oldest rule in the every-layout canon and the reason `Stack` exists at all: a child
 * that carries its own `mb-4` has an opinion about what follows it, so it cannot be reordered,
 * reused, or conditionally rendered without leaving a gap behind or doubling one up. The parent owns
 * the rhythm; `gap` is where it is written. `space-y-*` is the same mistake spelled as a utility —
 * it is the owl selector done by hand, and it silently fights the `gap` the primitive already set.
 */
const CHILD_AXIS_MARGIN_PATTERN = {
	block: /(?:^|\s)-?m(?:[tby])?-(?!0(?:\s|$)|auto\b)[\w.[\]/-]+/,
	inline: /(?:^|\s)-?m(?:[lrxe]|s)?-(?!0(?:\s|$)|auto\b)[\w.[\]/-]+/
};
const HAND_ROLLED_OWL = /\bspace-[xy]-(?!0(?:\s|$))[\w.[\]/-]+/;
/** Primitives whose main axis is vertical; everything else in `LAYOUT_GAP_OWNERS` runs inline. */
const BLOCK_AXIS_OWNERS = new Set(['Stack', 'Cover']);

function estreeSiblingSpacingFindings(node, collector, file, source) {
	const axis = BLOCK_AXIS_OWNERS.has(node.name) ? 'block' : 'inline';
	const pattern = CHILD_AXIS_MARGIN_PATTERN[axis];
	const children = node.fragment?.nodes ?? node.children ?? [];
	for (const child of children) {
		if (child.type !== 'RegularElement' && child.type !== 'Component') continue;
		const classes = estreeKnownClasses(child);
		if (!classes) continue;
		const margin = pattern.test(classes);
		const owl = HAND_ROLLED_OWL.test(classes);
		if (!margin && !owl) continue;
		// `UI7` already reports the coarse case on any element; this rule exists for the margins it
		// lets through — a child of a primitive that already owns `gap` has no business carrying any.
		if (margin && !owl && SIBLING_MARGIN_PATTERN.test(classes)) continue;
		collector.add(
			'UI13',
			file,
			source,
			child.start,
			`parent=${node.name} axis=${axis} child=${child.name} class=${classes}`
		);
	}
}

/**
 * Centring a measure is `max-inline-size` plus auto margins — not a flex alignment.
 *
 * `Stack align="center"` shrink-wraps its children to their content width, so a caller who wants a
 * readable column ends up writing `w-full max-w-3xl` on the child to undo the shrink-wrap, and now
 * three declarations describe one intent. `Center` is the primitive for this, and unlike the flex
 * spelling it keeps the element full-width until the measure is reached.
 *
 * A fixed layout dimension is the other magic number every-layout warns about: `h-[32rem]` is a
 * guess about content that will be wrong at the first long label. `Bound` names the sizes that are
 * deliberate so the rest can stay intrinsic.
 */
const HAND_ROLLED_CENTER = /\bmx-auto\b/;
const MEASURE_CLASS = /\bmax-w-(?:\[[^\]]+\]|\w+)\b/;
// `max-h-*` bounds a scrollable/viewport-relative region without forcing its height. The `h-[` part
// starts at a word boundary after the hyphen, so keep the negative lookbehind explicit or max-height
// constraints are misreported as fixed dimensions.
const FIXED_LAYOUT_DIMENSION =
	/(?<!max-)\b(?:min-)?h-\[[^\]]+\]|\bh-screen\b|\bh-dvh\b|(?<!min-)(?<!max-)\bw-\[[^\]]+\]/;

function estreeMeasureFindings(node, classValue, collector, file, source) {
	if (
		node.name !== 'Center' &&
		HAND_ROLLED_CENTER.test(classValue) &&
		MEASURE_CLASS.test(classValue)
	) {
		collector.add('UI14', file, source, node.start, `tag=${node.name} class=${classValue}`);
	}
	if (LAYOUT_PRIMITIVE_NAMES.has(node.name) && FIXED_LAYOUT_DIMENSION.test(classValue)) {
		collector.add('UI15', file, source, node.start, `tag=${node.name} class=${classValue}`);
	}
}

/**
 * A wrapper element is soup when it carries no layout, boundary, or hook: exactly one
 * element child, no non-whitespace text, no attributes beyond an empty/`contents` class.
 */
function estreeWrapperSoupFindings(node, classValue, collector, file, source) {
	const meaningfulAttributes = (node.attributes ?? []).some(
		(attribute) =>
			attribute.type !== 'Attribute' ||
			(!['class', 'style'].includes(attribute.name) &&
				!attribute.name.startsWith('aria-') &&
				!attribute.name.startsWith('data-') &&
				!attribute.name.startsWith('on'))
	);
	if (meaningfulAttributes) return;
	if (!WRAPPER_SOUP_EXEMPT_CLASS.test(classValue) && WRAPPER_STRUCTURAL_CLASS.test(classValue))
		return;
	let elementChildren = 0;
	let hasText = false;
	let hasBlock = false;
	const children = node.fragment?.nodes ?? node.children ?? [];
	for (const child of children) {
		if (child.type === 'Text') {
			if (child.data.trim() !== '') hasText = true;
		} else if (
			[
				'RegularElement',
				'InlineComponent',
				'Component',
				'SvelteElement',
				'SvelteComponent'
			].includes(child.type)
		) {
			elementChildren += 1;
		} else if (child.type !== 'Comment') {
			hasBlock = true;
		}
	}
	if (elementChildren === 1 && !hasText && !hasBlock) {
		collector.add('UI11', file, source, node.start, `tag=${node.name} class=${classValue}`);
	}
}

/**
 * A Tailwind arbitrary value whose contents are interpolated at runtime.
 *
 * Tailwind generates CSS by scanning source text, so `[grid-template-rows:${rows}]` names a rule
 * that was never emitted — the element simply has no such style. Nothing throws and nothing logs;
 * the layout silently falls back to the browser default, which is why this is an error rather than
 * a warning. Interpolate through `style` instead, or enumerate the literal class variants.
 */
const RUNTIME_ARBITRARY_VALUE_PATTERN = /\[[a-z-]+:[^\]]*\$\{/g;

/**
 * Tailwind arbitrary values assembled at runtime, found over raw source.
 *
 * This cannot ride on the estree class checks: `estreeStaticClass` returns null the moment any part
 * of a class attribute is an expression, and an interpolated arbitrary value is only ever reachable
 * through an expression. A rule wired there would never fire — which is worse than no rule, because
 * a green scan then reads as evidence.
 */
function runtimeArbitraryValueFindings(source, collector, file) {
	// Blanked rather than removed, so reported offsets still point at the real line. Documentation
	// that describes this anti-pattern — including this rule's own explanation in the layout
	// reference — must not be reported as a violation of it.
	const scannable = source
		.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
		.replace(/\/\/[^\n]*/g, (comment) => ' '.repeat(comment.length))
		.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
	RUNTIME_ARBITRARY_VALUE_PATTERN.lastIndex = 0;
	for (const match of scannable.matchAll(RUNTIME_ARBITRARY_VALUE_PATTERN)) {
		collector.add('UI12', file, source, match.index ?? 0, `value=${match[0]}`);
	}
}

function estreeLayoutLawFindings(node, classValue, collector, file, source) {
	if (LAYOUT_TABLE_NAMES.has(node.name) || LAYOUT_MEDIA_NAMES.has(node.name)) return;
	const hasFlex = RAW_LAYOUT_FLEX_PATTERN.test(classValue);
	const hasGrid = RAW_LAYOUT_GRID_PATTERN.test(classValue);
	const isContainer = LAYOUT_ELEMENT_NAMES.has(node.name);
	const isControl = estreeIsControlElement(node);
	const hasScroll = SCROLL_CHAIN_PATTERN.test(classValue);
	const hasSizeChain = /\b(?:h-full|flex-1|min-h-0|max-h-full)\b/.test(classValue);
	if (hasScroll && hasFlex && hasSizeChain) {
		collector.add('UI9', file, source, node.start, `tag=${node.name} class=${classValue}`);
	} else if (hasScroll && RAW_SCROLL_REGION_PATTERN.test(classValue)) {
		collector.add('UI5', file, source, node.start, `tag=${node.name} class=${classValue}`);
	}
	// Raw clip wrappers: a layout element that clips is a `Bound clip`/`Frame` region.
	// Text truncation, media crops, thumbnails, and sr-only are exempt.
	if (
		isContainer &&
		RAW_CLIP_REGION_PATTERN.test(classValue) &&
		!CLIP_EXEMPT_HINT_PATTERN.test(classValue) &&
		!CLIP_EXEMPT_FIXED_SIZE.test(classValue)
	) {
		collector.add('UI5', file, source, node.start, `clip tag=${node.name} class=${classValue}`);
	}
	if ((hasFlex || hasGrid) && LAYOUT_COMPOSITION_HINT_PATTERN.test(classValue)) {
		const isChip = ELEMENT_SIZE_PATTERN.test(classValue);
		const hintsSiblings =
			LAYOUT_SIBLING_HINT_PATTERN.test(classValue) ||
			(!isChip && LAYOUT_COMPOSITION_HINT_PATTERN.test(classValue));
		if ((isContainer || !isControl) && hintsSiblings) {
			collector.add('UI6', file, source, node.start, `tag=${node.name} class=${classValue}`);
		}
	}
	const margin = SIBLING_MARGIN_PATTERN.exec(classValue);
	if (margin) {
		collector.add('UI7', file, source, node.start, `tag=${node.name} margin=${margin[0]}`);
	}
	if (LITERAL_INSET_PATTERN.test(classValue)) {
		collector.add('UI8', file, source, node.start, `tag=${node.name} class=${classValue}`);
	}
}

function estreeBrowserDialogName(node) {
	if (node.type !== 'CallExpression') return null;
	if (node.callee?.type === 'Identifier' && BROWSER_DIALOGS.has(node.callee.name))
		return node.callee.name;
	if (
		node.callee?.type === 'MemberExpression' &&
		node.callee.object?.type === 'Identifier' &&
		node.callee.object.name === 'window'
	) {
		const name = estreeMemberName(node.callee);
		return BROWSER_DIALOGS.has(name) ? name : null;
	}
	return null;
}

function isEstreeTimerPromise(node) {
	return (
		node.type === 'NewExpression' &&
		node.callee?.type === 'Identifier' &&
		node.callee.name === 'Promise' &&
		node.arguments?.some((argument) =>
			estreeContains(
				argument,
				(candidate) =>
					candidate.type === 'CallExpression' &&
					candidate.callee?.type === 'Identifier' &&
					candidate.callee.name === 'setTimeout'
			)
		)
	);
}

function estreeAccessPath(node) {
	if (!node) return null;
	if (node.type === 'Identifier') return node.name;
	if (node.type === 'ThisExpression') return 'this';
	if (node.type === 'MemberExpression') {
		const object = estreeAccessPath(node.object);
		const member = estreeMemberName(node);
		return object && member != null ? `${object}.${member}` : null;
	}
	return null;
}

function isEstreeStateCall(node) {
	if (node?.type !== 'CallExpression') return false;
	if (node.callee?.type === 'Identifier') return node.callee.name === '$state';
	return (
		node.callee?.type === 'MemberExpression' &&
		node.callee.object?.type === 'Identifier' &&
		node.callee.object.name === '$state' &&
		estreeMemberName(node.callee) === 'raw'
	);
}

function estreeWalkFunctionBody(root, callback) {
	function visit(node, isRoot) {
		if (
			!isRoot &&
			['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)
		)
			return;
		callback(node);
		for (const child of estreeChildren(node)) visit(child, false);
	}
	visit(root, true);
}

function estreeReactiveReads(root, statePaths) {
	const reads = new Set();
	walkEstree(root, (node, parent) => {
		if (parent?.type === 'MemberExpression' && parent.object === node) return;
		const path = matchingReactivePath(estreeAccessPath(node), statePaths);
		if (path) reads.add(path);
	});
	return reads;
}

function estreeReactiveWrites(root, statePaths) {
	const writes = new Set();
	estreeWalkFunctionBody(root, (node) => {
		let target = null;
		if (node.type === 'AssignmentExpression') target = node.left;
		else if (node.type === 'UpdateExpression') target = node.argument;
		else if (
			node.type === 'CallExpression' &&
			node.callee?.type === 'MemberExpression' &&
			MUTATING_METHODS.has(estreeMemberName(node.callee))
		) {
			target = node.callee.object;
		}
		const path = matchingReactivePath(estreeAccessPath(target), statePaths);
		if (path) writes.add(path);
	});
	return writes;
}

function estreeReturnsCleanup(callback) {
	if (callback.body?.type !== 'BlockStatement') {
		return ['FunctionExpression', 'ArrowFunctionExpression'].includes(callback.body?.type);
	}
	let found = false;
	estreeWalkFunctionBody(callback.body, (node) => {
		if (
			node.type === 'ReturnStatement' &&
			['FunctionExpression', 'ArrowFunctionExpression'].includes(node.argument?.type)
		)
			found = true;
	});
	return found;
}

function estreeLifecycleResources(callback) {
	const resources = new Set();
	estreeWalkFunctionBody(callback.body, (node) => {
		if (node.type === 'CallExpression') {
			if (node.callee?.type === 'Identifier' && RESOURCE_CALLS.has(node.callee.name))
				resources.add(node.callee.name);
			if (
				node.callee?.type === 'MemberExpression' &&
				estreeMemberName(node.callee) === 'addEventListener'
			)
				resources.add('addEventListener');
		}
		if (
			node.type === 'NewExpression' &&
			node.callee?.type === 'Identifier' &&
			RESOURCE_CONSTRUCTORS.has(node.callee.name)
		)
			resources.add(node.callee.name);
	});
	return resources;
}

function estreeMountedWrites(callback, mountedPaths) {
	const writes = new Set();
	walkEstree(callback.body, (node) => {
		if (
			node.type === 'AssignmentExpression' &&
			node.operator === '=' &&
			node.right?.value === true
		) {
			const path = matchingReactivePath(estreeAccessPath(node.left), mountedPaths);
			if (path) writes.add(path);
		}
	});
	return writes;
}

function estreeLifecycleCleanups(callback) {
	const cleanups = new Set();
	estreeWalkFunctionBody(callback.body, (node) => {
		if (node.type !== 'CallExpression') return;
		if (node.callee?.type === 'Identifier') cleanups.add(node.callee.name);
		if (node.callee?.type === 'MemberExpression') cleanups.add(estreeMemberName(node.callee));
	});
	return cleanups;
}

function estreeLifecycleName(callee) {
	if (callee?.type === 'Identifier') return callee.name;
	if (
		callee?.type === 'MemberExpression' &&
		callee.object?.type === 'Identifier' &&
		callee.object.name === 'watch' &&
		estreeMemberName(callee) === 'pre'
	)
		return 'watch';
	return null;
}

function analyzeEstreeReactivity(root) {
	const stateCells = [];
	const statePaths = new Set();
	walkEstree(root, (node, _parent, ancestors) => {
		if (
			ancestors.some(({ type }) =>
				['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(type)
			)
		)
			return;
		let name = null;
		let initializer = null;
		let position = node.start;
		if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
			name = node.id.name;
			initializer = node.init;
			position = node.id.start;
		}
		if (node.type === 'PropertyDefinition' && node.key?.type === 'Identifier') {
			name = `this.${node.key.name}`;
			initializer = node.value;
			position = node.key.start;
		}
		if (!name || !isEstreeStateCall(initializer)) return;
		const cell = {
			name,
			position,
			initiallyFalse: initializer.arguments?.[0]?.value === false
		};
		stateCells.push(cell);
		statePaths.add(name);
	});

	const mountedPaths = new Set(
		stateCells
			.filter(
				({ name, initiallyFalse }) => initiallyFalse && MOUNTED_FLAG.test(name.split('.').at(-1))
			)
			.map(({ name }) => name)
	);
	const watches = [];
	const mounts = [];
	const destroys = [];
	walkEstree(root, (node) => {
		if (node.type !== 'CallExpression') return;
		const name = estreeLifecycleName(node.callee);
		if (
			name === 'watch' &&
			node.arguments?.[0] &&
			['FunctionExpression', 'ArrowFunctionExpression'].includes(node.arguments?.[1]?.type)
		) {
			watches.push({
				position: node.start,
				reads: estreeReactiveReads(node.arguments[0], statePaths),
				writes: estreeReactiveWrites(node.arguments[1].body, statePaths)
			});
		}
		const callback = node.arguments?.[0];
		if (!['FunctionExpression', 'ArrowFunctionExpression'].includes(callback?.type)) return;
		if (name === 'onMount') {
			mounts.push({
				position: node.start,
				mountedWrites: estreeMountedWrites(callback, mountedPaths),
				resources: estreeLifecycleResources(callback),
				returnsCleanup: estreeReturnsCleanup(callback)
			});
		}
		if (name === 'onDestroy') {
			destroys.push({
				position: node.start,
				writes: estreeReactiveWrites(callback.body, statePaths),
				cleanups: estreeLifecycleCleanups(callback)
			});
		}
	});
	return { stateCells, statePaths, watches, mounts, destroys };
}

function scanSvelte(record, compiler, collector, shared) {
	const { file, source } = record;
	const lines = source.split('\n').length;
	if (lines > 500) collector.add('P1', file, source, 0, `${lines} lines`);
	recordThinFile(collector, file, source);
	runtimeArbitraryValueFindings(source, collector, file);
	uuidLabelFallbackFindings(source, collector, file);
	const customTypeUuids = CUSTOM_TYPE_RENDERER_PATTERN.test(file)
		? customTypeUuidFields(dirname(file), shared)
		: new Set();
	customTypeUuidDisplayFindings(source, collector, file, customTypeUuids);
	customTypeJsonEditorFindings(source, collector, file, customTypeUuids);
	let ast;
	try {
		ast = compiler.parse(source, { modern: true, filename: file });
	} catch (error) {
		collector.add('SCAN', file, source, error.position?.[0] ?? 0, error.message.split('\n')[0]);
		return;
	}
	if (ast.instance)
		finalizeReactiveAnalysis(collector, file, source, analyzeEstreeReactivity(ast.instance));
	const roots = [ast.instance, ast.module, ast.fragment].filter(Boolean);
	const references = new Map();
	shared.referencesByFile.set(file, references);
	const reassignedFunctions = new Set();
	const candidates = [];
	for (const root of roots) {
		walkEstree(root, (node) => {
			if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier')
				reassignedFunctions.add(node.left.name);
			if (node.type === 'UpdateExpression' && node.argument?.type === 'Identifier')
				reassignedFunctions.add(node.argument.name);
		});
	}
	for (const root of roots) {
		walkEstree(root, (node, parent, ancestors) => {
			if (isEstreeValueReference(node, parent)) {
				incrementReference(references, node.name);
			}
			if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier')
				reassignedFunctions.add(node.left.name);
			if (
				node.type === 'FunctionDeclaration' &&
				node.id &&
				node.body &&
				!ancestors.some(({ type }) => type.startsWith('Export'))
			) {
				candidates.push({ name: node.id.name, node, nameNode: node.id, body: node.body });
			}
			if (
				node.type === 'VariableDeclarator' &&
				node.id?.type === 'Identifier' &&
				['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init?.type) &&
				!ancestors.some(({ type }) => type.startsWith('Export'))
			) {
				candidates.push({
					name: node.id.name,
					node: node.init,
					nameNode: node.id,
					body: node.init.body
				});
			}
			if (
				(node.type === 'FunctionDeclaration' && node.body) ||
				node.type === 'ClassDeclaration' ||
				((node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') &&
					['FunctionExpression', 'ArrowFunctionExpression'].includes(node.value?.type))
			) {
				recordEstreeQuality(collector, file, source, node);
			}
			if (
				node.type === 'VariableDeclarator' &&
				node.id?.type === 'Identifier' &&
				['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init?.type)
			) {
				recordEstreeQuality(collector, file, source, node);
			}
			if (
				node.type === 'TSAnyKeyword' &&
				parent?.type !== 'TSAsExpression' &&
				parent?.type !== 'TSTypeAssertion'
			) {
				collector.add('R1', file, source, node.start);
			}
			if (node.type === 'TSAsExpression' || node.type === 'TSTypeAssertion') {
				const type = node.typeAnnotation;
				if (
					['TSAsExpression', 'TSTypeAssertion'].includes(node.expression?.type) &&
					node.expression.typeAnnotation?.type === 'TSUnknownKeyword'
				) {
					collector.add('R3b', file, source, node.expression.typeAnnotation.start);
				} else if (type?.type === 'TSAnyKeyword') collector.add('R3f', file, source, type.start);
				else if (type?.type === 'TSUnknownKeyword') {
					if (!(parent?.type === 'TSAsExpression' && parent.expression === node))
						collector.add('R3e', file, source, type.start);
				} else if (isEstreeRecordUnknown(type)) collector.add('R3a', file, source, type.start);
				else if (isEstreeJsonCall(node.expression, 'parse'))
					collector.add('R6a', file, source, type.start);
				else {
					const name = estreeTypeName(type);
					if (name && /^[A-Z]/.test(name))
						collector.add('R3c', file, source, type.start, `type=${name}`);
				}
			}
			if (node.type === 'CallExpression') {
				const browserDialog = estreeBrowserDialogName(node);
				if (browserDialog) collector.add('UI4', file, source, node.start, `api=${browserDialog}`);
				if (isEstreeJsonCall(node, 'parse')) {
					if (isEstreeJsonCall(node.arguments?.[0], 'stringify'))
						collector.add('CLONE', file, source, node.start);
					else {
						const validated =
							parent?.type === 'CallExpression' &&
							parent.arguments?.includes(node) &&
							['parse', 'safeParse'].includes(estreeMemberName(parent.callee));
						if (!validated && !['TSAsExpression', 'TSTypeAssertion'].includes(parent?.type))
							collector.add('R6b', file, source, node.start);
					}
				}
				if (
					node.callee?.type === 'Identifier' &&
					['setTimeout', 'setInterval'].includes(node.callee.name) &&
					parent?.type === 'ExpressionStatement'
				) {
					collector.add('A1', file, source, node.start);
				}
				const effectKind = estreeEffectKind(node.callee);
				if (effectKind) {
					if (node.arguments?.[0]?.async) {
						collector.add('V7', file, source, node.start, `kind=${effectKind}`);
					} else collector.add('V1', file, source, node.start, `kind=${effectKind}`);
				}
				if (
					node.callee?.type === 'Identifier' &&
					node.callee.name === 'onMount' &&
					node.arguments?.[0]?.async
				) {
					collector.add('V5', file, source, node.start);
				}
			}
			if (isEstreeTimerPromise(node)) {
				collector.add(
					'STD2',
					file,
					source,
					node.start,
					'prefer=@norbital-ai/std#delay|withTimeout'
				);
			}
			if (
				node.type === 'IfStatement' &&
				node.alternate &&
				sameLogic(
					source.slice(node.consequent.start, node.consequent.end),
					source.slice(node.alternate.start, node.alternate.end)
				)
			) {
				collector.add('D2', file, source, node.start, 'kind=if');
			}
			if (
				node.type === 'ConditionalExpression' &&
				sameLogic(
					source.slice(node.consequent.start, node.consequent.end),
					source.slice(node.alternate.start, node.alternate.end)
				)
			) {
				collector.add('D2', file, source, node.start, 'kind=ternary');
			}
			if (node.type === 'RegularElement') {
				const staticClass = estreeStaticClass(node);
				const knownClasses = estreeKnownClasses(node);
				if (knownClasses) {
					estreeLayoutLawFindings(node, knownClasses, collector, file, source);
					estreeMeasureFindings(node, knownClasses, collector, file, source);
				}
				estreeInlineLayoutFindings(node, collector, file, source);
				if (node.name === 'div') {
					const classAttribute = (node.attributes ?? []).some(
						(attribute) => attribute.type === 'Attribute' && attribute.name === 'class'
					);
					// Expression classes are invisible to the static scan: never call a class-less
					// wrapper soup when the element actually carries a dynamic class.
					if (staticClass !== null || !classAttribute) {
						estreeWrapperSoupFindings(node, staticClass ?? '', collector, file, source);
					}
				}
				if (node.name === 'select') {
					collector.add('UI1', file, source, node.start, 'prefer=@norbital-ai/ui/combobox|select');
				}
				const role = estreeStaticAttribute(node, 'role');
				const navContainsTabButton =
					node.name === 'nav' &&
					estreeContains(
						node,
						(candidate) =>
							candidate.type === 'RegularElement' &&
							candidate.name === 'button' &&
							(estreeStaticAttribute(candidate, 'role') === 'tab' ||
								candidate.attributes?.some(
									(attribute) =>
										attribute.type === 'Attribute' && attribute.name === 'aria-selected'
								))
					);
				if (role === 'tablist' || navContainsTabButton) {
					collector.add('UI2', file, source, node.start, 'prefer=@norbital-ai/ui/tabs');
				}
				if (
					node.name === 'table' &&
					estreeContains(node, (candidate) => candidate.type === 'EachBlock')
				) {
					collector.add(
						'UI3',
						file,
						source,
						node.start,
						'prefer=CollectionTable|specialized matrix renderer'
					);
				}
			}
			if (node.type === 'Component' && LAYOUT_PRIMITIVE_NAMES.has(node.name)) {
				const knownClasses = estreeKnownClasses(node);
				if (knownClasses) {
					estreePrimitiveClassFindings(node, knownClasses, collector, file, source);
					estreeMeasureFindings(node, knownClasses, collector, file, source);
				}
			}
			if (node.type === 'Component') {
				estreeScrollTrapFindings(node, collector, file, source);
				estreeUuidExposureFindings(node, collector, file, source);
			}
			estreeCustomTypeUuidFindings(node, collector, file, source, customTypeUuids);
			if (
				(node.type === 'Component' || node.type === 'RegularElement') &&
				LAYOUT_GAP_OWNERS.has(node.name)
			) {
				estreeSiblingSpacingFindings(node, collector, file, source);
			}
			if (node.type === 'CatchClause') {
				if (
					!node.body?.body?.length &&
					!/teardown[^\n]*ignore|stupidity:ignore/i.test(
						source.slice(node.body.start, node.body.end)
					)
				) {
					collector.add('S1', file, source, node.start);
				}
				if (node.body?.body?.length === 1 && node.body.body[0].type === 'ThrowStatement')
					collector.add('A5', file, source, node.start);
			}
			if (isEstreeLoop(node) && !node.await && estreeContainsAwait(node.body))
				collector.add('A6', file, source, node.start);
			if (node.type === 'ExportAllDeclaration') collector.add('P9', file, source, node.start);
			if (node.type === 'ImportDeclaration' && node.source?.value === 'svelte/store')
				collector.add('V4', file, source, node.start);
			if (node.type === 'OnDirective') collector.add('V3', file, source, node.start);
			recordEstreeRuneHygiene(collector, file, source, node, parent, ancestors, reassignedFunctions);
			if (
				node.type === 'UnaryExpression' &&
				node.operator === 'void' &&
				node.argument?.type === 'CallExpression' &&
				node.argument.callee?.type === 'ArrowFunctionExpression' &&
				node.argument.callee.async
			) {
				collector.add('V6', file, source, node.start);
			}
		});
	}
	for (const candidate of candidates) {
		const bodyText = source.slice(candidate.body.start, candidate.body.end);
		const { fingerprint, tokens } = tokenFingerprint(bodyText);
		const startLine = lineInfo(source, candidate.body.start).line;
		const endLine = lineInfo(source, candidate.body.end).line;
		shared.duplicateCandidates.push({
			file,
			source,
			name: candidate.name,
			position: candidate.nameNode.start,
			line: lineInfo(source, candidate.nameNode.start).line,
			fingerprint,
			tokens,
			lines: endLine - startLine + 1
		});
		const canonicalHelper = CANONICAL_STD_HELPERS.get(candidate.name);
		if (canonicalHelper) {
			collector.add(
				'STD1',
				file,
				source,
				candidate.nameNode.start,
				`name=${candidate.name} prefer=${canonicalHelper}`
			);
		}
		if (ENTRY_POINT_NAMES.includes(candidate.name))
			continue;
		if (reassignedFunctions.has(candidate.name)) continue;
		const uses = references.get(candidate.name) ?? 0;
		let recursive = false;
		walkEstree(candidate.body, (node, parent) => {
			if (isEstreeValueReference(node, parent) && node.name === candidate.name) recursive = true;
		});
		if (!recursive && uses === 1) {
			const startLine = lineInfo(source, candidate.body.start).line;
			const endLine = lineInfo(source, candidate.body.end).line;
			collector.add(
				'Q3',
				file,
				source,
				candidate.nameNode.start,
				`name=${candidate.name} references=${uses} lines=${endLine - startLine + 1}`
			);
		}
	}
}

async function loadSvelteCompiler(root) {
	for (const packageJson of [
		join(root, 'apps/core/package.json'),
		join(root, 'packages/pod/package.json'),
		join(root, 'package.json')
	]) {
		if (!existsSync(packageJson)) continue;
		try {
			const require = createRequire(packageJson);
			const module = await import(pathToFileURL(require.resolve('svelte/compiler')));
			return module.default ?? module;
		} catch {
			// Try the next workspace package.
		}
	}
	throw new Error('svelte/compiler is required to scan .svelte files');
}

function collectTypeScriptDuplicateCandidates(file, source) {
	const sourceFile = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	);
	const candidates = [];
	function visit(node) {
		if (isTsFunctionLikeCandidate(node)) {
			const candidate = {
				...tsCandidateParts(node),
				file,
				source,
				sourceFile
			};
			candidates.push(tsDuplicateCandidate(candidate));
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return candidates;
}

function collectSvelteDuplicateCandidates(file, source, compiler) {
	let ast;
	try {
		ast = compiler.parse(source, { modern: true, filename: file });
	} catch {
		return [];
	}
	const candidates = [];
	for (const root of [ast.instance, ast.module].filter(Boolean)) {
		walkEstree(root, (node) => {
			let candidate = null;
			if (node.type === 'FunctionDeclaration' && node.id && node.body) {
				candidate = { name: node.id.name, nameNode: node.id, body: node.body };
			}
			if (
				node.type === 'VariableDeclarator' &&
				node.id?.type === 'Identifier' &&
				['ArrowFunctionExpression', 'FunctionExpression'].includes(node.init?.type)
			) {
				candidate = { name: node.id.name, nameNode: node.id, body: node.init.body };
			}
			if (!candidate) return;
			const bodyText = source.slice(candidate.body.start, candidate.body.end);
			const { fingerprint, tokens } = tokenFingerprint(bodyText);
			const startLine = lineInfo(source, candidate.body.start).line;
			const endLine = lineInfo(source, candidate.body.end).line;
			candidates.push({
				file,
				source,
				name: candidate.name,
				position: candidate.nameNode.start,
				line: lineInfo(source, candidate.nameNode.start).line,
				fingerprint,
				tokens,
				lines: endLine - startLine + 1
			});
		});
	}
	return candidates;
}

function finalizeDuplicateFunctions(collector, selectedCandidates, root, scope, compiler) {
	const eligibleSelected = selectedCandidates.filter(
		(candidate) =>
			candidate.tokens >= 24 && candidate.lines >= 4 && !candidate.file.includes('/_vendor/')
	);
	if (!eligibleSelected.length) return;

	const selectedLanguages = new Set(
		eligibleSelected.map(({ file }) => (file.endsWith('.svelte') ? 'svelte' : 'typescript'))
	);
	const repositoryCandidates =
		scope.files.length === scope.allFiles.length
			? selectedCandidates
			: scope.allFiles.flatMap((file) => {
					if (file.includes('/_vendor/')) return [];
					const isSvelte = file.endsWith('.svelte');
					if (isSvelte && !selectedLanguages.has('svelte')) return [];
					if (!isSvelte && !selectedLanguages.has('typescript')) return [];
					const absolute = join(root, file);
					if (!existsSync(absolute)) return [];
					const source = readFileSync(absolute, 'utf8');
					return isSvelte
						? collectSvelteDuplicateCandidates(file, source, compiler)
						: collectTypeScriptDuplicateCandidates(file, source);
				});
	const occurrences = new Map();
	for (const candidate of repositoryCandidates) {
		if (candidate.tokens < 24 || candidate.lines < 4) continue;
		const group = occurrences.get(candidate.fingerprint) ?? [];
		const key = `${candidate.file}:${candidate.line}`;
		if (!group.some((existing) => `${existing.file}:${existing.line}` === key))
			group.push(candidate);
		occurrences.set(candidate.fingerprint, group);
	}

	for (const candidate of eligibleSelected) {
		const duplicate = occurrences
			.get(candidate.fingerprint)
			?.find((other) => other.file !== candidate.file || other.line !== candidate.line);
		if (!duplicate) continue;
		collector.add(
			'D1',
			candidate.file,
			candidate.source,
			candidate.position,
			`name=${candidate.name} duplicate=${duplicate.file}:${duplicate.line} tokens=${candidate.tokens}`
		);
	}
}

function finalizeDuplicateTypes(collector, shared, root, scope) {
	const selected = shared.typeCandidates.filter((candidate) => isAl5Eligible(candidate));
	if (!selected.length) return;
	const repositoryCandidates =
		scope.files.length === scope.allFiles.length
			? selected
			: [
					...selected,
					...scope.allFiles.flatMap((file) => {
						if (file.includes('/_vendor/') || file.endsWith('.svelte')) return [];
						if (scope.files.includes(file)) return [];
						const absolute = join(root, file);
						if (!existsSync(absolute)) return [];
						const source = readFileSync(absolute, 'utf8');
						const sourceFile = ts.createSourceFile(
							file,
							source,
							ts.ScriptTarget.Latest,
							true,
							file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
						);
						return collectTsTypeCandidates(file, source, sourceFile).filter(
							(candidate) => candidate.exported && isAl5Eligible(candidate)
						);
					})
				];
	const occurrences = new Map();
	for (const candidate of repositoryCandidates) {
		const group = occurrences.get(candidate.shape) ?? [];
		const key = `${candidate.file}:${candidate.name}`;
		if (!group.some((existing) => `${existing.file}:${existing.name}` === key)) group.push(candidate);
		occurrences.set(candidate.shape, group);
	}
	for (const candidate of selected) {
		const duplicate = occurrences
			.get(candidate.shape)
			?.find((other) => other.file !== candidate.file || other.name !== candidate.name);
		if (!duplicate) continue;
		collector.add(
			'AL5',
			candidate.file,
			candidate.source,
			candidate.position,
			`type=${candidate.name} duplicate=${duplicate.file}:${duplicate.name}`
		);
	}
}

function addTsIdentifierReferences(sourceFile, names, totals) {
	function visit(node) {
		if (ts.isIdentifier(node) && names.has(node.text) && isTsValueReference(node)) {
			incrementReference(totals, node.text);
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
}

function addEstreeIdentifierReferences(root, names, totals) {
	walkEstree(root, (node, parent) => {
		if (isEstreeValueReference(node, parent) && names.has(node.name)) {
			incrementReference(totals, node.name);
		}
	});
}

function collectProductionIdentifierReferences(names, shared, root, scope, compiler) {
	const totals = new Map();
	if (!names.size) return totals;
	const seen = new Set();
	for (const [file, refs] of shared.referencesByFile) {
		seen.add(file);
		for (const name of names) {
			const count = refs.get(name);
			if (count) incrementReference(totals, name, count);
		}
	}
	for (const file of scope.allFiles) {
		if (seen.has(file)) continue;
		const absolute = join(root, file);
		if (!existsSync(absolute)) continue;
		const source = readFileSync(absolute, 'utf8');
		if (file.endsWith('.svelte')) {
			if (!compiler) continue;
			try {
				const ast = compiler.parse(source, { modern: true, filename: file });
				for (const tree of [ast.instance, ast.module, ast.fragment].filter(Boolean)) {
					addEstreeIdentifierReferences(tree, names, totals);
				}
			} catch {
				// Parse failures are reported when that file is itself in scope.
			}
			continue;
		}
		const sourceFile = ts.createSourceFile(
			file,
			source,
			ts.ScriptTarget.Latest,
			true,
			file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
		);
		addTsIdentifierReferences(sourceFile, names, totals);
	}
	return totals;
}

async function finalizeOneOffFunctions(collector, shared, root, scope, compiler) {
	const exportedNames = new Set(
		shared.functionCandidates.filter((candidate) => candidate.exported).map(({ name }) => name)
	);
	let svelteCompiler = compiler;
	if (
		exportedNames.size &&
		!svelteCompiler &&
		scope.allFiles.some((file) => file.endsWith('.svelte') && !shared.referencesByFile.has(file))
	) {
		svelteCompiler = await loadSvelteCompiler(root);
	}
	const productionRefs = collectProductionIdentifierReferences(
		exportedNames,
		shared,
		root,
		scope,
		svelteCompiler
	);
	for (const candidate of shared.functionCandidates) {
		if (ENTRY_POINT_NAMES.includes(candidate.name)) continue;
		if (tsBodyReferencesName(candidate.body, candidate.name)) continue;
		if (shared.reassignedFunctionsByFile.get(candidate.file)?.has(candidate.name)) continue;
		const references = candidate.exported
			? (productionRefs.get(candidate.name) ?? 0)
			: (shared.referencesByFile.get(candidate.file)?.get(candidate.name) ?? 0);
		if (references === 1) {
			const startLine = candidate.sourceFile.getLineAndCharacterOfPosition(
				candidate.body.getStart(candidate.sourceFile)
			).line;
			const endLine = candidate.sourceFile.getLineAndCharacterOfPosition(candidate.body.end).line;
			collector.add(
				'Q3',
				candidate.file,
				candidate.source,
				candidate.nameNode.getStart(candidate.sourceFile),
				`name=${candidate.name} references=${references} lines=${endLine - startLine + 1}`
			);
		}
	}
}

function publishCatalogue(findings, path) {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}`;
	const sorted = findings.sort(
		(a, b) =>
			SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
			CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
			a.rule.localeCompare(b.rule) ||
			a.location.localeCompare(b.location)
	);
	writeFileSync(
		temporary,
		sorted
			.map(({ severity, confidence, rule, summary, location }) =>
				[severity, confidence, rule, summary, location].join('\t')
			)
			.join('\n') + (sorted.length ? '\n' : '')
	);
	try {
		renameSync(temporary, path);
	} finally {
		if (existsSync(temporary)) unlinkSync(temporary);
	}
}

async function main() {
	let options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(`stupidity-scanner: ${error.message}`);
		usage();
		process.exit(2);
	}
	const root = gitRoot();
	const path = cataloguePath(root);
	if (options.show && !options.refresh) {
		if (!existsSync(path)) {
			console.error('stupidity-scanner: no catalogue found; run the scanner once first');
			process.exit(2);
		}
		const findings = readCatalogue(path);
		if (options.format === 'json') {
			renderJson(findings, path, { label: 'catalogue', files: null }, options.show);
		} else renderDetails(findings, options.show, options.limit, path);
		return;
	}

	const scope = selectScope(root, options);
	const files = scope.files;
	const compiler = files.some((file) => file.endsWith('.svelte'))
		? await loadSvelteCompiler(root)
		: null;
	const collector = createFindingCollector();
	const shared = {
		functionCandidates: [],
		duplicateCandidates: [],
		typeCandidates: [],
		referencesByFile: new Map(),
		reassignedFunctionsByFile: new Map(),
		collectionModels: [],
		customTypeUuidFields: new Map(),
		root
	};
	const records = files.map((file) => ({ file, source: readFileSync(join(root, file), 'utf8') }));
	for (const record of records) {
		if (record.file.endsWith('.svelte')) {
			scanSvelte(record, compiler, collector, shared);
		} else {
			record.sourceFile = ts.createSourceFile(
				record.file,
				record.source,
				ts.ScriptTarget.Latest,
				true,
				record.file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
			);
			scanTypeScript(record, collector, shared);
		}
	}
	await finalizeOneOffFunctions(collector, shared, root, scope, compiler);
	finalizeDuplicateFunctions(collector, shared.duplicateCandidates, root, scope, compiler);
	finalizeDuplicateTypes(collector, shared, root, scope);
	finalizeUuidSurfaces(collector, shared, scope);
	publishCatalogue(collector.findings, path);
	const outputScope = { label: scope.label, files: files.length };
	if (options.format === 'json') {
		renderJson(collector.findings, path, outputScope, options.show);
	} else {
		renderSummary(collector.findings, options.summaryLimit, path, outputScope);
		if (options.show) renderDetails(collector.findings, options.show, options.limit, path);
	}
	process.exitCode = hasActionable(collector.findings) ? 1 : 0;
}

await main();
