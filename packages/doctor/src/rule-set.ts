/**
 * An organization's audit rules as data, and the audit's output lines: the contract between the host that stores a rule
 * set, the job that runs it and the page that edits it. Schemas only (no compiler here), so a host decodes an audit's
 * untrusted output without loading the analyser.
 */
import { createHash } from 'node:crypto';
import { Predicate, Schema } from 'effect';

/** A rule's state in one organization: its severity there, or `off`. */
export const RuleState = Schema.Literals(['error', 'hint', 'off']);
export type RuleState = typeof RuleState.Type;

/**
 * One organization's rule set: each platform rule's state by id (absent: its declared severity), organization-wide
 * path globs the audit skips, and the organization's own rules, each a document in the platform's pack schema (`id`,
 * `summary`, `severity`, `principles`, `files`, `rule`, `examples`, …) compiled by the audit itself.
 */
export const RuleSet = Schema.Struct({
	states: Schema.Record(Schema.String, RuleState),
	ignore: Schema.Array(Schema.String),
	rules: Schema.Array(Schema.Record(Schema.String, Schema.Json))
});
export type RuleSet = typeof RuleSet.Type;
export const DEFAULT_RULE_SET: RuleSet = { states: {}, ignore: [], rules: [] };

/** Keys sorted at every depth: the same rule set always names the same digest. */
const sorted = (_key: string, value: unknown) =>
	Predicate.isObject(value)
		? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
		: value;
/** What every audit result names: the rule set it ran (part of the audit's single-flight key). */
export const ruleSetDigest = (ruleSet: RuleSet): string =>
	createHash('sha256').update(JSON.stringify(ruleSet, sorted)).digest('hex');

const Text = Schema.String.check(Schema.isMaxLength(4000));
const Id = Schema.NonEmptyString.check(Schema.isMaxLength(200));
const Severity = Schema.Literals(['error', 'hint']);
/** A rule as Studio shows it: its pack (`organization` for the organization's own), state and examples as code. */
export const AuditRule = Schema.Struct({
	type: Schema.Literal('rule'),
	id: Id,
	pack: Id,
	summary: Text,
	severity: Severity,
	state: RuleState,
	principles: Schema.Array(Id),
	files: Schema.optionalKey(Schema.Array(Text)),
	rationale: Schema.optionalKey(Text),
	examples: Schema.Struct({ bad: Schema.Array(Text), good: Schema.Array(Text) })
});
export type AuditRule = typeof AuditRule.Type;
/** One finding: `location` is `path:line: excerpt`. */
export const AuditFinding = Schema.Struct({
	type: Schema.Literal('finding'),
	rule: Id,
	severity: Severity,
	summary: Text,
	location: Text,
	principles: Schema.Array(Id)
});
export type AuditFinding = typeof AuditFinding.Type;
/** One of the organization's own rules that did not compile: the audit still completes without it. */
export const AuditRuleError = Schema.Struct({
	type: Schema.Literal('rule-error'),
	id: Id,
	message: Text
});
export type AuditRuleError = typeof AuditRuleError.Type;
/** The last line: how many findings and active rules, the rule set's digest and the doctor that ran it. */
export const AuditDone = Schema.Struct({
	type: Schema.Literal('done'),
	findings: Schema.Int,
	rules: Schema.Int,
	digest: Schema.String,
	version: Schema.String
});
export type AuditDone = typeof AuditDone.Type;
/** Every line an audit writes on stdout; a host decodes each strictly and drops what does not decode. */
export const AuditEvent = Schema.Union([AuditRule, AuditFinding, AuditRuleError, AuditDone]);
export type AuditEvent = typeof AuditEvent.Type;
