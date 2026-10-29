// Studio's Audit rules page (§5 "Audit: rules are an organization's data"): what the host answers and the page's pure
// edits. The host owns the rule set (the control store), its compiler (the audit job) and the decoding of the job's
// lines; these shapes are what reaches the page, decoded already.
import { Option, Schema } from 'effect';
import type { Authority } from '../../engine/contracts.ts';

export const AuditRuleState = Schema.Literals(['error', 'hint', 'off']);
export type AuditRuleState = typeof AuditRuleState.Type;
/**
 * One organization's rule set: each platform rule's state by id, the paths the audit skips, its own rules (doctor's
 * `RuleSet`, decoded here so the host route takes no other shape).
 */
export const AuditRuleSet = Schema.Struct({
	states: Schema.Record(Schema.String, AuditRuleState),
	ignore: Schema.Array(Schema.String),
	rules: Schema.Array(Schema.Record(Schema.String, Schema.Json))
});
export type AuditRuleSet = typeof AuditRuleSet.Type;
/** A rule as this organization sees it; `pack` is `organization` for its own. */
export type StudioAuditRule = {
	id: string;
	pack: string;
	summary: string;
	severity: 'error' | 'hint';
	state: AuditRuleState;
	principles: readonly string[];
	files?: readonly string[];
	rationale?: string;
	examples: { bad: readonly string[]; good: readonly string[] };
};
/** An own rule that did not compile, with the compiler's message. */
export type StudioAuditRuleError = { id: string; message: string };
/** The saved rule set (`revision` 0: never saved) under its catalogue. */
export type StudioAuditRules = {
	revision: number;
	ruleSet: AuditRuleSet;
	rules: readonly StudioAuditRule[];
	errors: readonly StudioAuditRuleError[];
	digest: string;
	version: string;
};
/** One audit of a commit; `location` is `path:line: excerpt`. */
export type StudioAuditFinding = {
	rule: string;
	severity: 'error' | 'hint';
	summary: string;
	location: string;
	principles: readonly string[];
};
export type StudioAudit = {
	commit: string;
	findings: readonly StudioAuditFinding[];
	errors: readonly StudioAuditRuleError[];
	digest: string;
	version: string;
};
/**
 * The host's audit (`StudioPort.audit`), an administrator's: `rules` reads the saved set, `save` stores one over its
 * revision once every own rule compiles (refused with the compiler's messages, or as stale), `run` audits the
 * viewer's head under the saved set or, given one, an unsaved set (Try).
 */
export type StudioAuditPort = {
	rules(auth: Authority): Promise<StudioAuditRules>;
	save(auth: Authority, revision: number, ruleSet: AuditRuleSet): Promise<StudioAuditRules>;
	run(auth: Authority, ruleSet?: AuditRuleSet): Promise<StudioAudit>;
};

/** Rules grouped by pack in catalogue order, the organization's own last. */
export function byPack(
	rules: readonly StudioAuditRule[]
): readonly (readonly [string, readonly StudioAuditRule[]])[] {
	const packs = new Map<string, StudioAuditRule[]>();
	for (const rule of rules) packs.set(rule.pack, [...(packs.get(rule.pack) ?? []), rule]);
	return [...packs].sort(
		([a], [b]) => Number(a === 'organization') - Number(b === 'organization') || a.localeCompare(b)
	);
}
/** `ruleSet` with `id` in `state`; its declared severity is the default, so that state is not stored. */
export function withState(
	ruleSet: AuditRuleSet,
	rule: Pick<StudioAuditRule, 'id' | 'severity'>,
	state: AuditRuleState
): AuditRuleSet {
	const { [rule.id]: _previous, ...rest } = ruleSet.states;
	return { ...ruleSet, states: state === rule.severity ? rest : { ...rest, [rule.id]: state } };
}
/** The path scopes as the editor shows them, one glob per line, and back. */
export const ignoreText = (ruleSet: AuditRuleSet) => ruleSet.ignore.join('\n');
export const withIgnore = (ruleSet: AuditRuleSet, text: string): AuditRuleSet => ({
	...ruleSet,
	ignore: text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '')
});
/** The organization's own rules as the editor shows them: a JSON array of rule documents. */
export const ownText = (ruleSet: AuditRuleSet) => JSON.stringify(ruleSet.rules, null, '\t');
const OwnRules = Schema.fromJsonString(Schema.Array(Schema.Record(Schema.String, Schema.Json)));
/** The editor's text as own rules: a JSON array of rule objects, or why not (the compiler judges the rest). */
export function withOwn(
	ruleSet: AuditRuleSet,
	text: string
): { ruleSet: AuditRuleSet } | { error: string } {
	const rules = Schema.decodeUnknownOption(OwnRules)(text);
	return Option.isNone(rules)
		? { error: 'Give a JSON array of rule objects.' }
		: { ruleSet: { ...ruleSet, rules: rules.value } };
}
