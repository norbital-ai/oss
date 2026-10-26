/**
 * The audit job's work: the workspace packs under one organization's rule set. It answers the rule catalogue as that
 * organization sees it, its own rules that failed to compile (the audit completes without them) and, unless only the
 * rules are asked for, every finding, ending with the rule set's digest and this doctor's version. Nothing is written.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { Predicate, Result, Schema } from 'effect';
import { parse as parseYaml } from 'yaml';
import { applyAllowances } from './allowances.js';
import { DoctorFailure } from './failure.js';
import { doctor, PACKS, WORKSPACE, type Finding } from './index.js';
import { compileRuleDocument, loadPackDirectory } from './patterns-yaml.js';
import { runRules, sourceFiles } from './runner.js';
import type { Rule } from './rules.js';
import {
	ruleSetDigest,
	type AuditEvent,
	type AuditRule,
	type RuleSet,
	type RuleState
} from './rule-set.js';

/** The catalogue fields of a rule document; anything it does not carry is left out of the entry. */
const Document = Schema.Struct({
	id: Schema.String,
	summary: Schema.String,
	severity: Schema.Literals(['error', 'hint']),
	principles: Schema.Array(Schema.String),
	files: Schema.optionalKey(Schema.Array(Schema.String)),
	examples: Schema.Struct({ bad: Schema.Array(Schema.String), good: Schema.Array(Schema.String) })
});
const Version = Schema.Struct({ version: Schema.String });
const version = Schema.decodeUnknownSync(Schema.fromJsonString(Version))(
	readFileSync(join(PACKS, '..', 'package.json'), 'utf8')
).version;

/** A rule's catalogue entry; a pack file's leading comment block is its rationale. */
const entry = (
	pack: string,
	document: unknown,
	state: (id: string, severity: Finding['severity']) => RuleState,
	rationale?: string
): AuditRule => {
	const d = Schema.decodeUnknownSync(Document)(document);
	return {
		type: 'rule',
		id: d.id,
		pack,
		summary: d.summary,
		severity: d.severity,
		state: state(d.id, d.severity),
		principles: d.principles,
		...(d.files === undefined ? {} : { files: d.files }),
		...(rationale === undefined || rationale === '' ? {} : { rationale }),
		examples: { bad: d.examples.bad, good: d.examples.good }
	};
};
const rationaleOf = (text: string) => {
	const lines: string[] = [];
	for (const line of text.split('\n')) {
		if (!line.startsWith('#')) break;
		lines.push(line.replace(/^#\s?/, ''));
	}
	return lines.join('\n').trim();
};

/** One organization's audit of `root`; `findings: false` answers its rules alone (a rule set's save and the catalogue). */
export function audit(
	options: Readonly<{ root: string; ruleSet: RuleSet; findings?: boolean }>
): ReadonlyArray<AuditEvent> {
	const { root, ruleSet } = options;
	const state = (id: string, severity: Finding['severity']): RuleState =>
		ruleSet.states[id] ?? severity;
	const events: AuditEvent[] = [];
	const declared = new Map<string, string>();
	let platform = 0;
	for (const pack of WORKSPACE) {
		const directory = join(PACKS, pack);
		for (const name of readdirSync(directory)
			.filter((file) => /\.ya?ml$/.test(file))
			.sort()) {
			const text = readFileSync(join(directory, name), 'utf8');
			const document: unknown = parseYaml(text);
			events.push(entry(pack, document, state, rationaleOf(text)));
		}
		for (const rule of loadPackDirectory(directory)) {
			declared.set(rule.id, `${pack}/${rule.id}`);
			if (state(rule.id, rule.severity) !== 'off') platform += 1;
		}
	}
	// each of the organization's rules compiles alone, so one bad rule never stops the audit
	const own: Rule[] = [];
	ruleSet.rules.forEach((document, index) => {
		const id = document['id'];
		const label =
			Predicate.isString(id) && id.trim() !== '' ? id.slice(0, 200) : `rule ${index + 1}`;
		const compiled = Result.try({
			try: () => compileRuleDocument(label, document, declared),
			catch: (cause) => new DoctorFailure(cause)
		});
		if (Result.isFailure(compiled)) {
			events.push({
				type: 'rule-error',
				id: label,
				message: compiled.failure.message.slice(0, 4000)
			});
			return;
		}
		events.push(entry('organization', document, state));
		if (state(compiled.success.id, compiled.success.severity) !== 'off') own.push(compiled.success);
	});
	const findings: Finding[] = [];
	if (options.findings !== false) {
		const files = sourceFiles(root).filter(
			(file) => !ruleSet.ignore.some((glob) => posix.matchesGlob(file, glob))
		);
		for (const finding of [
			...doctor({ root, files }),
			...applyAllowances(root, runRules({ root, rules: own, files }))
		]) {
			const severity = state(finding.rule, finding.severity);
			if (severity !== 'off') findings.push({ ...finding, severity });
		}
		for (const finding of findings)
			events.push({
				type: 'finding',
				rule: finding.rule,
				severity: finding.severity,
				summary: finding.summary,
				location: finding.location.slice(0, 4000),
				principles: finding.principles
			});
	}
	events.push({
		type: 'done',
		findings: findings.length,
		rules: platform + own.length,
		digest: ruleSetDigest(ruleSet),
		version
	});
	return events;
}
