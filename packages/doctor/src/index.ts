/**
 * `@norbital-ai/doctor` (RFC §3.3.10, OD-K5′): the static rules `bolt check` runs. Four fixed workspace packs —
 * `boundaries`, `layout`, `svelte`, `reactive` — and no configuration; every finding is an error. A reviewed
 * `repository-health:allow <rule> -- <reason>` line is the only exception (`allowances.ts`).
 *
 * The realm's own gates select the realm packs by name (`packs/realm/*`): `realm/boundaries`, `realm/graph`,
 * `realm/overlaps`, `realm/structure`, `realm/effect`, `realm/ceremony`, and `realm/types` (the type-aware tier). An
 * absolute directory is a host's own pack.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import './analyses.js';
import { applyAllowances } from './allowances.js';
import { bindCrossFile } from './cross-file.js';
import { loadPackDirectory } from './patterns-yaml.js';
import type { Confidence, Rule, Severity } from './rules.js';
import type { Constraints, Matcher, Utils } from './matcher.js';
import { searchRule } from './pattern.js';
import { runRules, searchRules, sourceFiles, type Match } from './runner.js';
import { runTypeAware } from './type-aware.js';

export type Finding = Readonly<{
	readonly severity: Severity;
	readonly confidence: Confidence;
	/** Rule identifier, for example `UI5` or `R3e`. */
	readonly rule: string;
	readonly summary: string;
	/** `path/to/file.ts:12: source excerpt` */
	readonly location: string;
	readonly principles: ReadonlyArray<string>;
}>;

/** One compiled pack rule. */
export type DoctorRule = Rule;

const PACKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'packs');
const WORKSPACE = ['boundaries', 'layout', 'svelte', 'reactive'];
const loaded = new Map<string, ReadonlyArray<DoctorRule>>();

/**
 * Every finding of `packs` (the four workspace packs by default) over `root`'s sources, or only `files`
 * (repository-relative). `realm/graph` indexes the whole selection first; tests reach modules but are never reported.
 */
export function doctor(
	options: Readonly<{ root?: string; files?: ReadonlyArray<string>; includeTests?: boolean; packs?: ReadonlyArray<string> }> = {}
): ReadonlyArray<Finding> {
	const root = resolve(options.root ?? process.cwd());
	const packs = options.packs ?? WORKSPACE;
	const rules = packs.filter((pack) => pack !== 'realm/types').flatMap((pack) => {
		if (!loaded.has(pack)) loaded.set(pack, loadPackDirectory(resolve(PACKS, pack)));
		return loaded.get(pack)!;
	});
	const files = options.files ?? sourceFiles(root, { includeTests: options.includeTests });
	if (packs.includes('realm/graph')) {
		const selected = new Set(files);
		bindCrossFile(root, files, options.files ? [] : sourceFiles(root, { includeTests: true }).filter((file) => !selected.has(file)));
	}
	const types = packs.includes('realm/types') ? runTypeAware({ root, files }) : [];
	return applyAllowances(root, [...runRules({ root, rules, files }), ...types]);
}

export type { Match, Matcher };
/** An ast-grep rule: a pattern string, or an object whose keys all hold (`{ kind, regex, inside }`). */
export type SearchRule = Matcher | Readonly<{ [key: string]: unknown }>;

/**
 * Where `rule` matches over `files` (repository-relative, read through `read` when given — a draft, an artifact): ast-grep's
 * rule language, a pattern with `$X` and `$$$`, a kind, and `inside`, `has`, `all`, `any` and `not`, over `.ts` and `.svelte`
 * alike. File and line order: the first `limit` matches and the total.
 */
export function search(options: Readonly<{ rule: SearchRule; utils?: Utils; constraints?: Constraints; root?: string; files: ReadonlyArray<string>;
	read?: (file: string) => string | undefined; limit?: number }>): Readonly<{ matches: ReadonlyArray<Match>; total: number }> {
	return searchRules({ root: resolve(options.root ?? '/'), rules: [searchRule(asAstGrep(options.rule), { utils: options.utils, constraints: options.constraints })],
		files: options.files, read: options.read, limit: options.limit });
}

/** ast-grep ANDs an object's keys (`{ kind, regex }`, `{ pattern, inside }`); this engine reads one key per object. */
function asAstGrep(rule: SearchRule): Matcher {
	if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) return rule as Matcher;
	const r = rule as Readonly<Record<string, unknown>>, nested = (v: unknown) => asAstGrep(v as SearchRule);
	const parts: Matcher[] = [];
	for (const [k, v] of Object.entries(r)) {
		if (k === 'stopBy' || k === 'field' || k === 'on') continue;
		if (k === 'inside' || k === 'has' || k === 'follows' || k === 'precedes')
			parts.push({ [k]: nested(v), ...(r['stopBy'] === undefined ? {} : { stopBy: r['stopBy'] === 'end' || r['stopBy'] === 'neighbor' ? r['stopBy'] : nested(r['stopBy']) }),
				...(r['field'] === undefined || k === 'follows' || k === 'precedes' ? {} : { field: r['field'] }) } as Matcher);
		else if (k === 'all' || k === 'any') parts.push({ [k]: (v as Matcher[]).map(nested) } as unknown as Matcher);
		else if (k === 'not') parts.push({ not: nested(v) });
		else if (k === 'regex') parts.push({ regex: v as string, ...(r['on'] === undefined ? {} : { on: r['on'] as string }) });
		else parts.push({ [k]: v } as Matcher);
	}
	return parts.length === 1 ? parts[0]! : { all: parts };
}
