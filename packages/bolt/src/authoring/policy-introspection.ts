import { Predicate, Result, Schema } from 'effect'; // repository-health:allow STATE2 -- compiled grant functions ride the policy declaration through a WeakMap keyed by the frozen policy object; describePolicy writes each entry once and the runtime reads them for the workspace lifetime.
import { CollectionPredicate } from '@norbital-ai/bolt-protocol/collections';
import type { PolicyDeclaration, RuntimePolicyGrant } from './workspace-schema.js';
import {
	resolvePolicyLimits,
	validatePolicyLimits,
	type RateLimitRule
} from './rate-limits-schema.js';

export type PolicyRuntimeFunction = (context: unknown, api: unknown) => unknown;

type PolicyRuntimeFunctions = Readonly<{
	readonly authorizations: Readonly<Record<string, PolicyRuntimeFunction>>;
	readonly approvalFlows: Readonly<Record<string, PolicyRuntimeFunction>>;
}>;

const functionsByPolicy = new WeakMap<PolicyDeclaration, PolicyRuntimeFunctions>();

/** Runtime actions remain flat after the authored mutation branches have been compiled. */
const RUNTIME_ACTIONS = ['read', 'history', 'create', 'update', 'delete'] as const;
type PolicyAction = (typeof RUNTIME_ACTIONS)[number];
const READ_ACTIONS = new Set<PolicyAction>(['read', 'history']);
const POLICY_KEYS = new Set(['description', 'grants', 'capabilities', 'limits']);
const COLLECTION_GRANT_KEYS = new Set(['read', 'history', 'mutate', 'delete']);
const MUTATE_KEYS = new Set(['new', 'existing']);
const READ_GRANT_KEYS = new Set(['where', 'fields']);
const DELETE_GRANT_KEYS = new Set(['authorize', 'approval']);
const WRITE_GRANT_KEYS = new Set(['fields', 'authorize', 'approval']);
const APPROVAL_KEYS = new Set(['flow', 'superceded_by']);

const AuthoredActionGrant = Schema.Struct({
	where: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
	fields: Schema.optionalKey(Schema.Array(Schema.String)),
	authorize: Schema.optionalKey(Schema.Unknown),
	approval: Schema.optionalKey(Schema.Unknown)
});
const AuthoredCollectionGrants = Schema.Struct({
	read: Schema.optionalKey(AuthoredActionGrant),
	history: Schema.optionalKey(AuthoredActionGrant),
	mutate: Schema.optionalKey(
		Schema.Struct({
			new: Schema.optionalKey(AuthoredActionGrant),
			existing: Schema.optionalKey(AuthoredActionGrant)
		})
	),
	delete: Schema.optionalKey(AuthoredActionGrant)
});
const PolicyCapabilities = Schema.Struct({
	apps: Schema.optionalKey(Schema.Array(Schema.String)),
	tools: Schema.optionalKey(Schema.Array(Schema.String)),
	mcp: Schema.optionalKey(Schema.Array(Schema.String)),
	skills: Schema.optionalKey(Schema.Array(Schema.String)),
	envoyHistory: Schema.optionalKey(Schema.Literal('this_envoy'))
});
const AuthoredRateLimitRule = Schema.Struct({
	window: Schema.String,
	limit: Schema.Number,
	key: Schema.optionalKey(Schema.Literals(['address', 'subject', 'sender', 'tenant']))
});
const AuthoredPolicy = Schema.Struct({
	description: Schema.String,
	grants: Schema.Record(Schema.String, AuthoredCollectionGrants),
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
	groupMessages: Schema.optionalKey(Schema.Literals(['disabled', 'mention_or_reply', 'all'])),
	delegation: Schema.Literals(['enabled', 'disabled'])
});

const jsonObject = Schema.Record(Schema.String, Schema.Unknown);
const isString = Schema.is(Schema.String);
const isRecord = Schema.is(jsonObject);

/** The decoded-failure fallback, once, typed without a cast: an empty map is never reached. */
const EMPTY_RECORD: Record<string, unknown> = Object.freeze({});

function requireExactKeys(
	value: unknown,
	allowed: ReadonlySet<string>,
	location: string
): asserts value is Record<string, unknown> {
	const decoded = Schema.decodeUnknownResult(jsonObject)(value);
	if (Result.isFailure(decoded)) throw new TypeError(`${location} must be an object.`);
	const record: Record<string, unknown> = Result.getOrElse(decoded, () => EMPTY_RECORD);
	const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
	if (unexpected.length > 0) {
		throw new TypeError(`${location} has unsupported ${unexpected.join(', ')} key(s).`);
	}
}

const grantKeys = (action: PolicyAction): ReadonlySet<string> =>
	READ_ACTIONS.has(action)
		? READ_GRANT_KEYS
		: action === 'delete'
			? DELETE_GRANT_KEYS
			: WRITE_GRANT_KEYS;

const validateGrantFields = (grant: Record<string, unknown>, location: string): void => {
	if (!('fields' in grant)) return;
	if (!Array.isArray(grant.fields) || grant.fields.some((field) => !isString(field))) {
		throw new TypeError(`${location}.fields must be an array of field names.`);
	}
	if (new Set(grant.fields).size !== grant.fields.length) {
		throw new TypeError(`${location}.fields cannot repeat a field.`);
	}
};

const validateGrantApproval = (grant: Record<string, unknown>, location: string): void => {
	if (!('approval' in grant)) return;
	requireExactKeys(grant.approval, APPROVAL_KEYS, `${location}.approval`);
	if (!Predicate.isFunction(grant.approval.flow)) {
		throw new TypeError(`${location}.approval.flow must be a function.`);
	}
	const superseders = grant.approval.superceded_by;
	if (
		!Array.isArray(superseders) ||
		superseders.some((team) => !isString(team) || team.trim() === '') ||
		new Set(superseders).size !== superseders.length
	) {
		throw new TypeError(`${location}.approval.superceded_by must be a unique array of team names.`);
	}
};

const rejectLegacySqlTokens = (value: unknown, location: string): void => {
	if (!isRecord(value) && !Array.isArray(value)) return;
	if (Array.isArray(value)) {
		value.forEach((entry, index) => rejectLegacySqlTokens(entry, `${location}[${index}]`));
		return;
	}
	for (const [key, nested] of Object.entries(value)) {
		if (key === '$sql') {
			throw new TypeError(
				`${location} uses removed $sql policy syntax; use the closed structured predicate language.`
			);
		}
		rejectLegacySqlTokens(nested, `${location}.${key}`);
	}
};

/**
 * The protocol query grammar deliberately excludes policy-only operators. Validate their exact
 * authored shape here, then substitute an inert member of the same field-filter branch solely for
 * closed-grammar decoding. The original predicate remains the runtime declaration.
 */
const policyGrammarProjection = (value: unknown, location: string): unknown => {
	if (Array.isArray(value)) {
		return value.map((entry, index) => policyGrammarProjection(entry, `${location}[${index}]`));
	}
	if (!isRecord(value)) return value;
	const entries = Object.entries(value);
	if (entries.some(([key]) => key === 'teamScopeUsers')) {
		if (entries.length !== 1 || Reflect.get(value, 'teamScopeUsers') !== true) {
			throw new TypeError(`${location}.teamScopeUsers must be the sole field operator with value true.`);
		}
		return { in: [] };
	}
	return Object.fromEntries(
		entries.map(([key, nested]) => [key, policyGrammarProjection(nested, `${location}.${key}`)])
	);
};

const validateGrantWhere = (grant: Record<string, unknown>, location: string): void => {
	if (!('where' in grant)) return;
	const where = grant.where;
	if (isRecord(where) && Reflect.get(where, 'kind') === 'policy-sql') {
		throw new TypeError(
			`${location}.where uses administrative one-shot SQL in a read/history policy; use the closed structured predicate language.`
		);
	}
	rejectLegacySqlTokens(where, `${location}.where`);
	const decoded = Schema.decodeUnknownResult(CollectionPredicate)(
		policyGrammarProjection(where, `${location}.where`)
	);
	if (Result.isFailure(decoded)) {
		throw new TypeError(
			`${location}.where must use the closed structured predicate language: ${String(decoded.failure)}`
		);
	}
};

const validateGrantShape = (
	name: string,
	collection: string,
	action: PolicyAction,
	authoredCoordinate: string,
	grant: unknown
): void => {
	const location = `Policy ${name}.grants.${collection}.${authoredCoordinate}`;
	requireExactKeys(grant, grantKeys(action), location);
	const authorize = Reflect.get(grant, 'authorize');
	if (authorize !== undefined && !Predicate.isFunction(authorize)) {
		throw new TypeError(`${location}.authorize must be a function.`);
	}
	validateGrantFields(grant, location);
	if (READ_ACTIONS.has(action)) {
		validateGrantWhere(grant, location);
	}
	validateGrantApproval(grant, location);
};

const validatePolicyShape = (name: string, declaration: unknown): void => {
	requireExactKeys(declaration, POLICY_KEYS, `Policy ${name}`);
	const grants = declaration.grants;
	const grantsDecoded = Schema.decodeUnknownResult(jsonObject)(grants);
	if (Result.isFailure(grantsDecoded)) {
		throw new TypeError(
			`Policy ${name}.grants must be a collection grant object. Grant arrays are not supported.`
		);
	}
	const grantMap: Record<string, unknown> = Result.getOrElse(grantsDecoded, () => EMPTY_RECORD);
	for (const [collection, collectionGrants] of Object.entries(grantMap)) {
		requireExactKeys(
			collectionGrants,
			COLLECTION_GRANT_KEYS,
			`Policy ${name}.grants.${collection}`
		);
		for (const [coordinate, grant] of Object.entries(collectionGrants)) {
			if (coordinate !== 'mutate') {
				validateGrantShape(name, collection, coordinate as PolicyAction, coordinate, grant);
				continue;
			}
			requireExactKeys(grant, MUTATE_KEYS, `Policy ${name}.grants.${collection}.mutate`);
			for (const [target, targetGrant] of Object.entries(grant)) {
				validateGrantShape(
					name,
					collection,
					target === 'new' ? 'create' : 'update',
					`mutate.${target}`,
					targetGrant
				);
			}
		}
	}
};

export const approvalConfigurationId = (
	policy: string,
	collection: string,
	action: string
): string => `${policy}:${collection}:${action}`;

const policyAuthorizationId = (policy: string, collection: string, action: string): string =>
	`${policy}:${collection}:${action}:authorize`;

/** Approval stage identities are runtime-derived; authors never name stages. */
export const approvalStepId = (configurationId: string, index: number): string =>
	`${configurationId}:stage:${index + 1}`;

const describeGrant = (
	policyName: string,
	collection: string,
	action: PolicyAction,
	grant: Readonly<Record<string, unknown>>,
	authorizations: Map<string, PolicyRuntimeFunction>,
	approvalFlows: Map<string, PolicyRuntimeFunction>
): RuntimePolicyGrant => {
	const where =
		grant.where === undefined ? undefined : Schema.decodeUnknownSync(jsonObject)(grant.where);
	const described: RuntimePolicyGrant = {
		collection,
		action,
		...(where === undefined ? {} : { where }),
		...(grant.fields === undefined ? {} : { fields: grant.fields as ReadonlyArray<string> })
	};
	if (Predicate.isFunction(grant.authorize)) {
		const id = policyAuthorizationId(policyName, collection, action);
		authorizations.set(id, grant.authorize as PolicyRuntimeFunction);
		Object.assign(described, { authorization: { id, live: true } });
	}
	const approvalDecoded = Schema.decodeUnknownResult(jsonObject)(grant.approval);
	if (Result.isSuccess(approvalDecoded)) {
		const approval: Record<string, unknown> = Result.getOrElse(approvalDecoded, () => EMPTY_RECORD);
		const id = approvalConfigurationId(policyName, collection, action);
		approvalFlows.set(id, approval.flow as PolicyRuntimeFunction);
		Object.assign(described, {
			approval: {
				id,
				flow: true,
				superceded_by: Object.freeze([...(approval.superceded_by as ReadonlyArray<string>)])
			}
		});
	}
	return Object.freeze(described);
};

export const describePolicy = (name: string, declaration: unknown): PolicyDeclaration => {
	validatePolicyShape(name, declaration);
	const decoded = Schema.decodeUnknownResult(AuthoredPolicy)(declaration);
	if (Result.isFailure(decoded)) {
		throw new TypeError(
			`Policy ${name} does not export a valid policy object. A policy file default-exports { description, grants, capabilities?, limits? }.`
		);
	}
	const { capabilities, description, grants } = decoded.success;
	if (description.trim() === '') throw new TypeError(`Policy ${name} requires a description.`);
	const limits: Readonly<Record<string, ReadonlyArray<RateLimitRule>>> = resolvePolicyLimits(
		decoded.success.limits
	);
	validatePolicyLimits(name, limits);
	const authorizations = new Map<string, PolicyRuntimeFunction>();
	const approvalFlows = new Map<string, PolicyRuntimeFunction>();
	const described = Object.keys(grants)
		.sort()
		.flatMap((collection) => {
			const collectionGrants = grants[collection];
			const authoredByRuntimeAction = {
				read: collectionGrants?.read,
				history: collectionGrants?.history,
				create: collectionGrants?.mutate?.new,
				update: collectionGrants?.mutate?.existing,
				delete: collectionGrants?.delete
			};
			return RUNTIME_ACTIONS.flatMap((action) => {
				const grant = authoredByRuntimeAction[action];
				return grant === undefined
					? []
					: [describeGrant(name, collection, action, grant, authorizations, approvalFlows)];
			});
		});
	const policy = Object.freeze({
		name,
		description,
		effect: 'allow' as const,
		actions: [...new Set(described.map(({ action }) => action))],
		grants: Object.freeze(described),
		capabilities: {
			apps: capabilities?.apps ?? [],
			tools: capabilities?.tools ?? [],
			mcp: capabilities?.mcp ?? [],
			skills: capabilities?.skills ?? []
		},
		limits
	});
	functionsByPolicy.set(policy, {
		authorizations: Object.freeze(Object.fromEntries(authorizations)),
		approvalFlows: Object.freeze(Object.fromEntries(approvalFlows))
	});
	return policy;
};

export const policyRuntimeFunctionsFor = (
	policies: ReadonlyArray<PolicyDeclaration>
): PolicyRuntimeFunctions =>
	Object.freeze({
		authorizations: Object.freeze(
			Object.fromEntries(
				policies.flatMap((policy) =>
					Object.entries(functionsByPolicy.get(policy)?.authorizations ?? {})
				)
			)
		),
		approvalFlows: Object.freeze(
			Object.fromEntries(
				policies.flatMap((policy) =>
					Object.entries(functionsByPolicy.get(policy)?.approvalFlows ?? {})
				)
			)
		)
	});

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
	readonly delegation: 'enabled' | 'disabled';
} => {
	const decoded = Schema.decodeUnknownResult(AuthoredEnvoy)(declaration);
	if (Result.isFailure(decoded)) {
		throw new TypeError(
			`Envoy ${name} does not export a valid envoy object. An envoy file default-exports { transport, audience, policies, task, delegation, groupMessages? }.`
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
		delegation: decoded.success.delegation,
		...(decoded.success.groupMessages === undefined
			? {}
			: { groupMessages: decoded.success.groupMessages })
	});
};
