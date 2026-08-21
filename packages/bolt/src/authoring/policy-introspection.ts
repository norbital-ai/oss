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
 */
type AuthoredApproval = {
	readonly steps: ReadonlyArray<{
		readonly key: string;
		readonly approvers: ReadonlyArray<string>;
		readonly description?: string;
	}>;
};

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

const isAuthoredApproval = (value: unknown): value is AuthoredApproval =>
	value !== null &&
	typeof value === 'object' &&
	Array.isArray(Reflect.get(value, 'steps')) &&
	(Reflect.get(value, 'steps') as ReadonlyArray<unknown>).every(
		(step) =>
			step !== null &&
			typeof step === 'object' &&
			typeof Reflect.get(step, 'key') === 'string' &&
			Array.isArray(Reflect.get(step, 'approvers'))
	);

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
const describeGrant = (
	policyName: string,
	grant: RuntimePolicyGrant
): RuntimePolicyGrant => {
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
	if (declaration === null || typeof declaration !== 'object') {
		throw new TypeError(
			`Policy ${name} does not export a policy object. A policy file default-exports { description, grants, capabilities?, limits? }.`
		);
	}
	const description = Reflect.get(declaration, 'description');
	const grants = Reflect.get(declaration, 'grants');
	if (typeof description !== 'string' || description.trim() === '') {
		throw new TypeError(`Policy ${name} requires a description.`);
	}
	if (!Array.isArray(grants)) {
		throw new TypeError(`Policy ${name} requires a grants array, even an empty one.`);
	}
	const capabilities = Reflect.get(declaration, 'capabilities');
	const list = (key: string): ReadonlyArray<string> => {
		const value =
			capabilities === null || typeof capabilities !== 'object'
				? undefined
				: Reflect.get(capabilities, key);
		return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
	};
	const limits: Readonly<Record<string, ReadonlyArray<RateLimitRule>>> = resolvePolicyLimits(
		Reflect.get(declaration, 'limits') as Parameters<typeof resolvePolicyLimits>[0]
	);
	validatePolicyLimits(name, limits);
	const described = (grants as ReadonlyArray<RuntimePolicyGrant>).map((grant) =>
		describeGrant(name, grant)
	);
	return Object.freeze({
		name,
		description,
		// Always `allow`. A denylist beside an allowlist fails open — adding a grant silently hands it
		// to every holder — so there is exactly one direction a policy can point.
		effect: 'allow' as const,
		actions: [...new Set(described.map(({ action }) => action))],
		grants: described,
		capabilities: {
			apps: list('apps'),
			tools: list('tools'),
			mcp: list('mcp'),
			skills: list('skills')
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
	if (declaration === null || typeof declaration !== 'object') {
		throw new TypeError(
			`Envoy ${name} does not export an envoy object. An envoy file default-exports { transport, audience, policies, task, groupMessages? }.`
		);
	}
	const transport = Reflect.get(declaration, 'transport');
	const audience = Reflect.get(declaration, 'audience');
	const policies = Reflect.get(declaration, 'policies');
	const task = Reflect.get(declaration, 'task');
	const groupMessages = Reflect.get(declaration, 'groupMessages');
	if (typeof transport !== 'string' || transport.trim() === '') {
		throw new TypeError(`Envoy ${name} requires a transport.`);
	}
	if (audience !== 'public' && audience !== 'authenticated') {
		throw new TypeError(`Envoy ${name} has an unsupported audience.`);
	}
	if (!Array.isArray(policies) || policies.length === 0) {
		throw new TypeError(
			`Envoy ${name} names no policies, so every turn on it would hold no authority at all. Name the policies it may act under.`
		);
	}
	if (typeof task !== 'string' || task.trim() === '') {
		throw new TypeError(`Envoy ${name} requires a task.`);
	}
	return Object.freeze({
		name,
		transport,
		audience,
		policies: Object.freeze(policies.filter((entry): entry is string => typeof entry === 'string')),
		task: task.trim(),
		...(groupMessages === 'disabled' ||
		groupMessages === 'mention_or_reply' ||
		groupMessages === 'all'
			? { groupMessages }
			: {})
	});
};
