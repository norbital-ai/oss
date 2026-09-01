/**
 * YAML as the authoring surface for pattern rules.
 *
 * `defineRule` in `pattern.ts` speaks TypeScript, which is the right surface for rules that live in
 * this repository — the compiler checks the syntax kinds and the examples run in the suite. It is
 * the wrong surface for a consumer that wants to add a rule without owning a build of this package,
 * so this module translates a documented YAML dialect onto the same machinery: a `rule` field goes
 * to `defineRule` untouched exactly as an ast-grep config would state it, and a `detect`/`prefer`
 * pair delegates to the overlap detectors in `overlaps.ts`.
 *
 * Strictness is the contract. A misspelled field, a principle outside `PRINCIPLE_ORDER`, or a glob
 * that matches nothing throws at load time with the file named — never a rule that silently reports
 * nothing, because "zero findings" must mean "clean", not "misconfigured". One file maps to one
 * rule; ids are unique across every file loaded in a call.
 */
import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { Effect } from 'effect';
import * as Result from 'effect/Result';
import { jsonRecord } from './manifest.js';
import { OVERLAP_SHAPES, overlapRules, type OverlapShape } from './overlaps.js';
import { defineRule, type Matcher } from './pattern.js';
import {
	PRINCIPLE_ORDER,
	type Confidence,
	type Principle,
	type Rule,
	type Severity
} from './rules.js';

type LoadedPatterns = Readonly<{
	/** Rules ready to feed runRules() alongside pack/authored rules. */
	readonly rules: ReadonlyArray<Rule>;
	/** Absolute paths loaded, for receipts. */
	readonly sources: ReadonlyArray<string>;
}>;

const FIELDS: ReadonlyArray<string> = [
	'id',
	'summary',
	'severity',
	'principles',
	'confidence',
	'files',
	'ignore',
	'dominates',
	'detect',
	'prefer',
	'module',
	'rule'
];

/** A rule file is YAML; `.yaml` is accepted beside `.yml` because globs do not distinguish them. */
const RULE_FILE = /\.ya?ml$/;

/**
 * `defineRule` demands inline examples for a matcher rule and discards them before the `Rule` is
 * built — they exist to be executed by `verifyExamples`, not carried on the rule. A YAML rule's
 * proof lives in the consuming repository's own suite instead, so the assertion is met here with a
 * placeholder that never reaches a catalogue row. Named for what it is so nobody mistakes it for
 * checked behaviour.
 */
const DELEGATED_EXAMPLES = { bad: [''], good: [''] } as const;

/** Directories that hold dependencies and outputs, not authored rules. Mirrors runner's IGNORED. */
const SKIPPED =
	/(^|\/)(node_modules|\.yalc|\.git|build|dist|coverage|generated|\.generated|\.svelte-check|\.svelte-kit|\.tmp|\.norbital|\.turbo|\.agents)(\/|$)/;

/** Authored doctor extensions live here; the rest of `.norbital` is generated output. */
function isDoctorConfigTree(local: string): boolean {
	return (
		local === '.norbital' ||
		local === '.norbital/config' ||
		local.startsWith('.norbital/config/')
	);
}

function detailOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function fail(file: string, problem: string): never {
	throw new Error(`norbital-doctor: ${file}: ${problem}`);
}

function required(file: string, yaml: Readonly<Record<string, unknown>>, field: string): unknown {
	const value = yaml[field];
	if (value === undefined) fail(file, `missing required field "${field}"`);
	return value;
}

function readString(file: string, field: string, value: unknown): string {
	if (typeof value !== 'string' || value.trim() === '')
		fail(file, `"${field}" must be a non-empty string, received ${JSON.stringify(value)}`);
	return value;
}

function readStringArray(
	file: string,
	field: string,
	value: unknown
): ReadonlyArray<string> {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.some((item) => typeof item !== 'string')
	)
		fail(file, `"${field}" must be a non-empty array of strings`);
	return value as ReadonlyArray<string>;
}

function readPrinciples(file: string, value: unknown): ReadonlyArray<Principle> {
	const listed = readStringArray(file, 'principles', value);
	for (const principle of listed)
		if (!PRINCIPLE_ORDER.includes(principle as Principle))
			fail(file, `"${principle}" is not a principle; choose from ${PRINCIPLE_ORDER.join(', ')}`);
	return listed as ReadonlyArray<Principle>;
}

/** Split an `owner#member` binding at the last `#`; an owner may name a scope such as `effect/Number`. */
function readPrefer(file: string, value: unknown): { owner: string; member: string } {
	const prefer = readString(file, 'prefer', value);
	const hash = prefer.lastIndexOf('#');
	const owner = prefer.slice(0, hash);
	const member = prefer.slice(hash + 1);
	if (hash <= 0 || member === '')
		fail(file, `"prefer" must read owner#member like es-toolkit#clamp, received "${prefer}"`);
	return { owner, member };
}

/**
 * Translate a `*` / `**` path pattern into an anchored expression, with runner's exact semantics:
 * a `**` followed by a separator may match nothing at all, a bare `**` widens to anything, and a
 * single `*` stops at a separator.
 *
 * The staged replacement uses sentinel words rather than runner's literal NUL bytes so this source
 * stays printable; both are free of regular-expression metacharacters, and neither may ever appear
 * anchored mid-pattern where an assertion could never hold.
 */
function patternToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	const expression = escaped
		.replace(/\*\*\//g, '@DOCTOR_SLASH@')
		.replace(/\*\*/g, '@DOCTOR_ANY@')
		.replace(/\*/g, '[^/]*')
		.replace(/@DOCTOR_SLASH@/g, '(?:.*/)?')
		.replace(/@DOCTOR_ANY@/g, '.*');
	return new RegExp(`^${expression}$`);
}

/** One directory read through Effect: the walk owns its failure message. */
function readDirectory(directory: string): ReadonlyArray<Dirent> {
	const read = Effect.runSync(Effect.result(Effect.try(() => readdirSync(directory, { withFileTypes: true }))));
	return Result.match(read, {
		onFailure: (error) => {
			throw new Error(`norbital-doctor: cannot walk ${directory} for rule files: ${detailOf(error)}`);
		},
		onSuccess: (found) => found
	});
}

/** Every repository-relative file beneath a root, sorted, dependency and output trees excluded. */
function repositoryFiles(root: string): ReadonlyArray<string> {
	const files: Array<string> = [];
	const visit = (directory: string): void => {
		const entries = readDirectory(directory);
		for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
			const absolute = join(directory, entry.name);
			const local = relative(root, absolute).split(sep).join('/');
			if (entry.isDirectory()) {
				if (isDoctorConfigTree(local) || !SKIPPED.test(`${local}/`)) visit(absolute);
			} else if (entry.isFile()) files.push(local);
		}
	};
	visit(root);
	return files;
}

/**
 * Expand each pattern against the repository's files, in order, dropping repeats.
 *
 * A pattern matching nothing is a typo wearing a glob, and a typo must not look like zero rules
 * configured — so it throws naming the pattern rather than yielding quietly.
 */
function expandPatterns(
	root: string,
	patterns: ReadonlyArray<string>,
	implicit: boolean
): ReadonlyArray<string> {
	const candidates = repositoryFiles(root);
	const selected: Array<string> = [];
	const seen = new Set<string>();
	for (const pattern of patterns) {
		const regExp = patternToRegExp(pattern);
		const matched = candidates.filter((file) => RULE_FILE.test(file) && regExp.test(file));
		if (matched.length === 0 && !implicit)
			throw new Error(
				`norbital-doctor: pattern "${pattern}" matched no rule files (.yaml/.yml) under ${root}`
			);
		for (const file of matched) {
			if (seen.has(file)) continue;
			seen.add(file);
			selected.push(file);
		}
	}
	return selected;
}

/** Parse, validate and synthesise one YAML file, appending to the run-wide accumulators. */
function loadFile(
	file: string,
	absolute: string,
	rules: Array<Rule>,
	declared: Map<string, string>
): void {
	let document: unknown;
	{
		const read = Effect.runSync(Effect.result(Effect.try(() => parseYaml(readFileSync(absolute, 'utf8')))));
		Result.match(read, {
			onFailure: (error) => fail(file, `invalid YAML: ${detailOf(error)}`),
			onSuccess: (parsed) => {
				document = parsed;
			}
		});
	}
	// The YAML document is decoded at its boundary: one mapping of fields, or the file is not a
	// rule file at all.
	const yaml = jsonRecord(document) ?? fail(file, 'expected one rule per file, written as a mapping of fields');
	for (const field of Object.keys(yaml))
		if (!FIELDS.includes(field))
			fail(file, `unknown field "${field}"; known fields are ${FIELDS.join(', ')}`);

	const id = readString(file, 'id', required(file, yaml, 'id'));
	if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(id))
		fail(file, `"${id}" is not a valid rule id; ids are alphanumeric like rules.ts requires`);
	const declaredBy = declared.get(id);
	if (declaredBy !== undefined) fail(file, `rule id "${id}" is already declared by ${declaredBy}`);

	const severityValue = required(file, yaml, 'severity');
	if (severityValue !== 'error' && severityValue !== 'hint')
		fail(file, `"severity" must be "error" or "hint", received ${JSON.stringify(severityValue)}`);
	const severity = severityValue as Severity;

	const summary = readString(file, 'summary', required(file, yaml, 'summary'));
	const principles = readPrinciples(file, required(file, yaml, 'principles'));

	if (yaml.confidence !== undefined && yaml.confidence !== 'high' && yaml.confidence !== 'medium')
		fail(file, `"confidence" must be "high" or "medium", received ${JSON.stringify(yaml.confidence)}`);
	const confidence = yaml.confidence as Confidence | undefined;

	const hasRule = yaml.rule !== undefined;
	const hasDetect = yaml.detect !== undefined;
	if (hasRule && hasDetect)
		fail(file, '"rule" and "detect" are two structural claims; state one');
	if (!hasRule && !hasDetect) fail(file, '"rule" or "detect" is required');

	if (yaml.prefer !== undefined && !hasDetect) fail(file, '"prefer" belongs beside "detect"');
	if (yaml.module !== undefined && !hasDetect) fail(file, '"module" belongs beside "detect"');
	if (hasDetect) {
		if (typeof yaml.detect !== 'string' || !OVERLAP_SHAPES.includes(yaml.detect as OverlapShape))
			fail(file, `"detect" must be one of ${OVERLAP_SHAPES.join(', ')}`);
		if (yaml.prefer === undefined) fail(file, '"detect" requires "prefer" as owner#member');
	}

	const common = {
		id,
		severity,
		summary,
		principles,
		confidence,
		files: yaml.files === undefined ? undefined : readStringArray(file, 'files', yaml.files),
		ignore: yaml.ignore === undefined ? undefined : readStringArray(file, 'ignore', yaml.ignore),
		dominates:
			yaml.dominates === undefined ? undefined : readStringArray(file, 'dominates', yaml.dominates)
	};
	if (common.dominates?.includes(id) === true)
		fail(file, `"dominates" cannot include the rule's own id`);

	declared.set(id, file);

	if (hasRule) {
		if (
			typeof yaml.rule !== 'string' &&
			(typeof yaml.rule !== 'object' || yaml.rule === null || Array.isArray(yaml.rule))
		)
			fail(file, '"rule" must be a pattern string or a matcher object');
		rules.push(defineRule({ ...common, rule: yaml.rule as Matcher, examples: DELEGATED_EXAMPLES }));
		return;
	}

	const { owner, member } = readPrefer(file, yaml.prefer);
	const module = yaml.module === undefined ? undefined : readString(file, 'module', yaml.module);
	const produced = overlapRules([
		{ shape: yaml.detect as OverlapShape, owner, member, module, severity, id }
	])[0];
	if (produced === undefined) fail(file, `detector "${yaml.detect}" produced no rule`);
	// The detector fixes its own summary, principles and confidence; YAML owns the identity
	// fields, so the detector's dispatch and check are kept and the description is rebuilt
	// around them through the ordinary visitor form of defineRule.
	rules.push(defineRule({ ...common, when: produced.when, check: produced.check }));
}

type PatternLoadOptions = Readonly<{
	/**
	 * The caller supplied no patterns of its own, so `.norbital/config/doctor/` is being
	 * probed. A repository without any rule files is normal under that default — silence
	 * there is absence of rules, not a typo — while an explicitly configured glob keeps the
	 * strict no-match error.
	 */
	readonly implicit?: boolean | undefined;
}>;

/**
 * Load YAML-authored pattern rules from a repository.
 *
 * Patterns are repository-relative globs (`**`, `*`, or literal paths); each file holds exactly one
 * rule. A `rule` or `detect` half becomes an ordinary `Rule` indistinguishable from an authored one.
 */
export async function loadPatternFiles(
	root: string,
	patterns: string | ReadonlyArray<string>,
	options: PatternLoadOptions = {}
): Promise<LoadedPatterns> {
	const described = typeof patterns === 'string' ? [patterns] : patterns;
	const rules: Array<Rule> = [];
	const sources: Array<string> = [];
	const declared = new Map<string, string>();
	for (const file of expandPatterns(root, described, options.implicit ?? false)) {
		const absolute = join(root, file);
		sources.push(absolute);
		loadFile(file, absolute, rules, declared);
	}
	return { rules, sources };
}
