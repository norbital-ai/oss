/**
 * YAML is the rule authoring surface.
 *
 * A pack is a directory of YAML files. Each file is one rule. `rule` is the matcher.
 * `defineRule` compiles that document into the runner's `Rule` object — it is not a second
 * place to declare pack rules.
 *
 * Strictness is the contract. A misspelled field, a principle outside `PRINCIPLE_ORDER`, or a glob
 * that matches nothing throws at load time with the file named — never a rule that silently reports
 * nothing, because "zero findings" must mean "clean", not "misconfigured". One file maps to one
 * rule; ids are unique across every file loaded in a call.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { Effect } from 'effect';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { jsonRecord } from './manifest.js';
import { defineRule, type Examples, type Matcher } from './pattern.js';
import {
	PRINCIPLE_ORDER,
	type Confidence,
	type Principle,
	type Rule,
	type Severity
} from './rules.js';

const FIELDS: ReadonlyArray<string> = [
	'id',
	'summary',
	'severity',
	'principles',
	'confidence',
	'files',
	'ignore',
	'dominates',
	'rule',
	'utils',
	'constraints',
	'examples'
];

/** A rule file is YAML; `.yaml` is accepted beside `.yml` because globs do not distinguish them. */
const RULE_FILE = /\.ya?ml$/;

function fail(file: string, problem: string): never {
	throw new Error(`norbital-doctor: ${file}: ${problem}`);
}

const isString = Schema.is(Schema.String);
const isStringArray = Schema.is(Schema.Array(Schema.String));
// The engine's own `Matcher` union: a pattern string or a matcher object (arrays rejected).
const isMatcherValue = Schema.is(
	Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)])
);

function required(file: string, yaml: Readonly<Record<string, unknown>>, field: string): unknown {
	const value = yaml[field];
	if (value === undefined) fail(file, `missing required field "${field}"`);
	return value;
}

function readString(file: string, field: string, value: unknown): string {
	if (!isString(value) || value.trim() === '')
		fail(file, `"${field}" must be a non-empty string, received ${JSON.stringify(value)}`);
	return value;
}

function readStringArray(file: string, field: string, value: unknown): ReadonlyArray<string> {
	if (!isStringArray(value) || value.length === 0)
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

/**
 * A mapping of name to matcher — `utils`, which a rule references through `{ matches: name }`, and
 * `constraints`, one rule per metavariable.
 *
 * Both were accepted by `defineRule` in TypeScript and absent from the YAML field list, so a YAML
 * rule could not name a reusable shape, could not recurse, and could not narrow a metavariable with
 * anything but a regular expression. `GUARD1` is twenty-one literal spellings of one idea because
 * of it.
 */
function readMatcherMap(
	file: string,
	field: string,
	value: unknown
): Readonly<Record<string, Matcher>> {
	const record = jsonRecord(value) ?? fail(file, `"${field}" must be a mapping of name to rule`);
	for (const [name, matcher] of Object.entries(record))
		if (!isMatcherValue(matcher))
			fail(file, `"${field}.${name}" must be a pattern string or a matcher object`);
	return record as Readonly<Record<string, Matcher>>;
}

function readExamples(file: string, value: unknown): Examples {
	const record = jsonRecord(value) ?? fail(file, '"examples" must be a mapping with bad and good');
	const bad = record.bad;
	const good = record.good;
	if (!isStringArray(bad) || bad.length === 0)
		fail(file, '"examples.bad" must be a non-empty array of strings');
	if (!isStringArray(good) || good.length === 0)
		fail(file, '"examples.good" must be a non-empty array of strings');
	const at = record.file === undefined ? undefined : readString(file, 'examples.file', record.file);
	const fixture = record.fixture;
	if (fixture !== undefined || at !== undefined) {
		const files =
			fixture === undefined
				? {}
				: (jsonRecord(fixture) ??
					fail(file, '"examples.fixture" must be a mapping of path to content'));
		for (const [path, content] of Object.entries(files))
			if (!isString(content))
				fail(file, `"examples.fixture.${path}" must be file content as a string`);
		return {
			bad: bad as ReadonlyArray<string>,
			good: good as ReadonlyArray<string>,
			fixture: files as Readonly<Record<string, string>>,
			...(at === undefined ? {} : { file: at })
		};
	}
	return { bad: bad as ReadonlyArray<string>, good: good as ReadonlyArray<string> };
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
		const read = Effect.runSync(
			Effect.result(Effect.try(() => parseYaml(readFileSync(absolute, 'utf8'))))
		);
		Result.match(read, {
			onFailure: (error) => fail(file, `invalid YAML: ${(error instanceof Error ? error.message : String(error))}`),
			onSuccess: (parsed) => {
				document = parsed;
			}
		});
	}
	// The YAML document is decoded at its boundary: one mapping of fields, or the file is not a
	// rule file at all.
	const yaml =
		jsonRecord(document) ??
		fail(file, 'expected one rule per file, written as a mapping of fields');
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
		fail(
			file,
			`"confidence" must be "high" or "medium", received ${JSON.stringify(yaml.confidence)}`
		);
	const confidence = yaml.confidence as Confidence | undefined;

	if (yaml.rule === undefined) fail(file, '"rule" is required');
	if (!isMatcherValue(yaml.rule)) fail(file, '"rule" must be a pattern string or a matcher object');

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

	// Examples are mandatory. They used to be filled in with `{ bad: [''], good: [''] }` when a
	// YAML rule omitted them, which meant the counter-example contract was suspended for exactly
	// the authoring surface every rule is moving to.
	if (yaml.examples === undefined)
		fail(file, '"examples" is required, with at least one "bad" and one "good"');
	const examples = readExamples(file, yaml.examples);
	const utils = yaml.utils === undefined ? undefined : readMatcherMap(file, 'utils', yaml.utils);
	const constraints =
		yaml.constraints === undefined
			? undefined
			: readMatcherMap(file, 'constraints', yaml.constraints);
	rules.push(
		defineRule({
			...common,
			rule: yaml.rule as Matcher,
			examples,
			...(utils === undefined ? {} : { utils }),
			...(constraints === undefined ? {} : { constraints })
		})
	);
}

/**
 * Load every YAML rule in a shipped pack directory.
 *
 * The directory is the pack: one file, one rule.
 */
export function loadPackDirectory(directory: string): ReadonlyArray<Rule> {
	if (!existsSync(directory))
		throw new Error(`norbital-doctor: pack directory missing: ${directory}`);
	const names = readdirSync(directory)
		.filter((name) => RULE_FILE.test(name))
		.sort((left, right) => left.localeCompare(right));
	if (names.length === 0)
		throw new Error(`norbital-doctor: pack directory ${directory} contains no .yaml/.yml rules`);
	const rules: Array<Rule> = [];
	const declared = new Map<string, string>();
	for (const name of names) loadFile(name, join(directory, name), rules, declared);
	return rules;
}
