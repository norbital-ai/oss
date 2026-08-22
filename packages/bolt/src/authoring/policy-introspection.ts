import { Result, Schema } from 'effect';
import type { PolicyDeclaration, RuntimePolicyGrant } from './workspace-schema.js';
import {
	resolvePolicyLimits,
	validatePolicyLimits,
	type RateLimitRule
} from './rate-limits-schema.js';

/**
 * Turning an authored policy file into the policy the runtime reads.
 *
 * The authored file states no name — the filename is the name — so this is where the two meet, and
 * it is the only place they do. A `name:` field restated inside the module is exactly how five of
 * six workspaces shipped a display-cased string that compiled and matched nothing at run time, and
 * there is no longer a field for it to be wrong in.
 *
 * Everything else here is normalization the runtime would otherwise each have to guess at: the four
 * capability lists always exist, `limits` always carries a resolved `key`, `effect` is always
 * `allow`, and `actions` is derived from the grants rather than restated beside them.
 */

/**
 * The approval an authored grant declares, before this module gives it an identity.
 *
 * `key` is the author's; everything else below is derived from where the grant sits.
 *
 * Schema-owned and validated once, because the declaration arrives from compiled authored
 * source that this module has never seen: the guard below is the whole verification an approval
 * is a list of steps rather than a summary of it.
 */
const AuthoredApprovalSchema = Schema.Struct({
	steps: Schema.Array(
		Schema.Struct({
			key: Schema.String,
			approvers: Schema.Array(Schema.String),
			description: Schema.optionalKey(Schema.String)
		})
	)
});
const isAuthoredApproval = Schema.is(AuthoredApprovalSchema);

const AuthoredGrant = Schema.Struct({
	collection: Schema.String,
	action: Schema.Literals(['read', 'create', 'update', 'delete', 'history']),
	where: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
	fields: Schema.optionalKey(Schema.Array(Schema.String)),
	approval: Schema.optionalKey(Schema.Unknown)
});
const PolicyCapabilities = Schema.Struct({
	apps: Schema.optionalKey(Schema.Array(Schema.String)),
	tools: Schema.optionalKey(Schema.Array(Schema.String)),
	mcp: Schema.optionalKey(Schema.Array(Schema.String)),
	skills: Schema.optionalKey(Schema.Array(Schema.String))
});
const AuthoredRateLimitRule = Schema.Struct({
	window: Schema.String,
	limit: Schema.Number,
	key: Schema.optionalKey(Schema.Literals(['address', 'subject', 'sender', 'tenant']))
});
const AuthoredPolicy = Schema.Struct({
	description: Schema.String,
	grants: Schema.Array(AuthoredGrant),
	capabilities: Schema.optionalKey(PolicyCapabilities),
	limits: Schema.optionalKey(
		Schema.Record(
			Schema.String,
			Schema.Union([AuthoredRateLimitRule, Schema.Array(AuthoredRateLimitRule)])
		)
	)
});
const AuthoredEnvoy = Schema.Struct({
	transport: Schema.String,
	audience: Schema.Literals(['public', 'authenticated']),
	policies: Schema.Array(Schema.String),
	task: Schema.String,
	groupMessages: Schema.optionalKey(Schema.Literals(['disabled', 'mention_or_reply', 'all']))
});

/**
 * A grant's approval identity, derived rather than authored.
 *
 * `(policy, collection, action)` names exactly one grant — two grants are never the same grant — so
 * the id is unique by construction, stable across releases, and legible in a log line. Nothing has
 * to be issued, nothing can collide, and there is no authored UUID for a copy-paste to duplicate.
 *
 * `bolt_approvals` is keyed by `request_id text primary key` with the configuration carried in
 * `state jsonb`, so there is no foreign key a derived id has to satisfy.
 */
export const approvalConfigurationId = (
	policy: string,
	collection: string,
	action: string
): string => `${policy}:${collection}:${action}`;

/**
 * A step's identity, derived from its `key` and never from its index.
 *
 * That is what makes reordering a policy's steps safe: an in-flight approval names the step it is
 * waiting on by key, so moving a step in the array cannot silently rebind it to a different one.
 */
export const approvalStepId = (configurationId: string, key: string): string =>
	`${configurationId}:${key}`;

/** A human-readable label for an approval, so a timeline reads as prose rather than as an id. */
const label = (value: string): string =>
	value.replaceAll('_', ' ').replace(/^./, (first) => first.toLocaleUpperCase());

/**
 * One authored grant, with its approval given the identity the runtime stores.
 *
 * The approval arrives as `{ steps: [{ key, approvers, description? }] }` and leaves as the
 * `ApprovalConfiguration` shape `approvals.ts` decodes — `id`, `name`, and a step `id` and `name`
 * per entry. Every one of those is computed here, from the grant's own coordinates.
 */
const describeGrant = (policyName: string, grant: RuntimePolicyGrant): RuntimePolicyGrant => {
	if (!isAuthoredApproval(grant.approval)) {
		if (grant.approval === undefined) return grant;
		throw new TypeError(
			`Policy ${policyName} declares an approval on ${grant.action} of ${grant.collection} that is not a list of steps. Write it as { steps: [{ key, approvers }] }.`
		);
	}
	const id = approvalConfigurationId(policyName, grant.collection, grant.action);
	const keys = grant.approval.steps.map((step) => step.key);
	if (new Set(keys).size !== keys.length) {
		throw new TypeError(
			`Policy ${policyName} repeats a step key on ${grant.action} of ${grant.collection}. A step's key is its identity, so two steps sharing one would be the same approval twice.`
		);
	}
	return {
		...grant,
		approval: {
			id,
			name: `${label(policyName)} — ${grant.action} ${grant.collection}`,
			steps: grant.approval.steps.map((step) => ({
				id: approvalStepId(id, step.key),
				name: label(step.key),
				approvers: [...step.approvers],
				...(step.description === undefined ? {} : { description: step.description })
			}))
		}
	};
};

/**
 * The authored policy file, plus the name its filename gave it.
 *
 * Called from the compiled artifact, where both halves are in hand: the module is imported live and
 * the name is a string literal the compiler wrote from the path.
 */
export const describePolicy = (name: string, declaration: unknown): PolicyDeclaration => {
	const decoded = Schema.decodeUnknownResult(AuthoredPolicy)(declaration);
	if (Result.isFailure(decoded)) {
		throw new TypeError(
			`Policy ${name} does not export a valid policy object. A policy file default-exports { description, grants, capabilities?, limits? }.`
		);
	}
	const { capabilities, description, grants } = decoded.success;
	if (description.trim() === '') {
		throw new TypeError(`Policy ${name} requires a description.`);
	}
	const limits: Readonly<Record<string, ReadonlyArray<RateLimitRule>>> = resolvePolicyLimits(
		decoded.success.limits
	);
	validatePolicyLimits(name, limits);
	const described = grants.map((grant: RuntimePolicyGrant) => describeGrant(name, grant));
	return Object.freeze({
		name,
		description,
		// Always `allow`. A denylist beside an allowlist fails open — adding a grant silently hands it
		// to every holder — so there is exactly one direction a policy can point.
		effect: 'allow' as const,
		actions: [...new Set(described.map(({ action }) => action))],
		grants: described,
		capabilities: {
			apps: capabilities?.apps ?? [],
			tools: capabilities?.tools ?? [],
			mcp: capabilities?.mcp ?? [],
			skills: capabilities?.skills ?? []
		},
		limits
	});
};

/**
 * The authored envoy file, plus the name its filename gave it.
 *
 * Symmetrical with `describePolicy` and for the same reason: the module cannot state its own file
 * name, and nothing else about it comes from anywhere else.
 */
export const describeEnvoy = (
	name: string,
	declaration: unknown
): {
	readonly name: string;
	readonly transport: string;
	readonly audience: 'public' | 'authenticated';
	readonly policies: ReadonlyArray<string>;
	readonly task: string;
	readonly groupMessages?: 'disabled' | 'mention_or_reply' | 'all';
} => {
	const decoded = Schema.decodeUnknownResult(AuthoredEnvoy)(declaration);
	if (Result.isFailure(decoded)) {
		throw new TypeError(
			`Envoy ${name} does not export a valid envoy object. An envoy file default-exports { transport, audience, policies, task, groupMessages? }.`
		);
	}
	if (decoded.success.transport.trim() === '') {
		throw new TypeError(`Envoy ${name} requires a transport.`);
	}
	if (decoded.success.policies.length === 0) {
		throw new TypeError(
			`Envoy ${name} names no policies, so every turn on it would hold no authority at all. Name the policies it may act under.`
		);
	}
	if (decoded.success.task.trim() === '') {
		throw new TypeError(`Envoy ${name} requires a task.`);
	}
	return Object.freeze({
		name,
		transport: decoded.success.transport,
		audience: decoded.success.audience,
		policies: Object.freeze(decoded.success.policies),
		task: decoded.success.task.trim(),
		...(decoded.success.groupMessages === undefined
			? {}
			: { groupMessages: decoded.success.groupMessages })
	});
};
