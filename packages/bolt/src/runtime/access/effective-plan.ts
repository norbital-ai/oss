import { Result, Schema } from 'effect';
import { sha256Text } from '@norbital-ai/std/reckon/hash';
import { asc, desc, getColumns, type SQL } from 'drizzle-orm';
import {
	MAX_COLLECTION_PREDICATE_DEPTH,
	type CollectionIndexRequirement,
	type CollectionRelationshipSegment,
	type CollectionReversePath
} from '@norbital-ai/bolt-protocol/collections';
import { MAX_SYNC_LOADED_KEYS } from '@norbital-ai/bolt-protocol';
import type {
	CompiledAuthoring,
	FieldDefinition,
	RelationDefinition,
	WorkspaceDefinition
} from '#lib/authoring/workspace-schema.js';
import { SYSTEM_COLUMN_NAMES } from '#lib/authoring/system-row-model.js';
import { canonicalJson } from '#lib/canonical-json.js';
import type { Subject } from '#lib/runtime/identity/subject.js';
import {
	predicateExpression,
	type PredicateFieldRequirement,
	type PredicateRoutingConstraint,
	type PredicateSemantics,
	type RowPredicate,
	type RowPredicateExpression
} from './predicate.js';
import { policyHashSource, type PolicyHashSource } from './policy-surface.js';

const isObject = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const isJson = Schema.is(Schema.Json);
const isString = Schema.is(Schema.String);
const isNumber = Schema.is(Schema.Number);
const isBoolean = Schema.is(Schema.Boolean);
const isBigint = Schema.is(Schema.BigInt);

const DEFAULT_LIVE_PREFIX = 100;
export const DEFAULT_RELATION_PREFIX_LIMIT = 100;
export const MAX_RELATION_DEPTH = MAX_COLLECTION_PREDICATE_DEPTH;

const SUBJECT_OPERANDS = ['id', 'email', 'team', 'teamIds', 'tenantId', 'admin'] as const;
const JSON_PATH_TYPES = ['string', 'number', 'boolean', 'instant', 'json'] as const;
const JSON_PATH_OPS = [
	'eq',
	'ne',
	'gt',
	'gte',
	'lt',
	'lte',
	'in',
	'notIn',
	'isNull',
	'isNotNull'
] as const;
const COMPARISON_OPS = [
	'eq',
	'ne',
	'gt',
	'gte',
	'lt',
	'lte',
	'like',
	'ilike',
	'notLike',
	'notIlike',
	'contains',
	'arrayContains',
	'arrayContained',
	'arrayOverlaps'
] as const;

type WithSpec = { readonly [field: string]: unknown };
export type ColumnSelection = Readonly<Record<string, boolean>>;

export const selectedColumnNames = (
	names: ReadonlyArray<string>,
	columns: ColumnSelection | undefined
): ReadonlyArray<string> => {
	if (columns === undefined) return names;
	const entries = Object.entries(columns);
	if (entries.some(([, enabled]) => enabled)) return names.filter((name) => columns[name] === true);
	const excluded = new Set(entries.filter(([, enabled]) => !enabled).map(([name]) => name));
	return names.filter((name) => !excluded.has(name));
};

export const requestedColumns = (spec: unknown): ColumnSelection | undefined => {
	if (!isObject(spec) || !isObject(spec['columns'])) return undefined;
	const selected: Record<string, boolean> = {};
	for (const [name, enabled] of Object.entries(spec['columns']))
		if (isBoolean(enabled)) selected[name] = enabled;
	return Object.keys(selected).length === 0 ? undefined : selected;
};

export const nestedWith = (spec: unknown): WithSpec | undefined => {
	if (!isObject(spec)) return undefined;
	const nested = spec['with'];
	return isObject(nested) ? nested : undefined;
};

export const requestedRelations = (spec: unknown): ReadonlyArray<string> =>
	isObject(spec)
		? Object.entries(spec)
				.filter(([, value]) => value !== false && value !== undefined)
				.map(([name]) => name)
		: [];

export const relationSpec = (spec: unknown, name: string): unknown =>
	isObject(spec) ? spec[name] : undefined;

export const referenceArmSpec = (spec: unknown, tag: string): unknown =>
	isObject(spec) ? (spec[tag] ?? spec) : spec;

export const boundedCount = (value: unknown): number | undefined =>
	isNumber(value) && Number.isInteger(value) && value >= 0 ? value : undefined;

const fingerprint = (value: unknown): string => `sha256:${sha256Text(canonicalJson(value))}`;

export class EffectivePlanError extends Schema.TaggedError<EffectivePlanError>()(
	'Bolt.Access.EffectivePlanError',
	{
		code: Schema.Literals([
			'invalid-node',
			'unknown-field',
			'unknown-relationship',
			'ambiguous-relationship',
			'unresolved-segment',
			'max-depth',
			'unbound-subject',
			'unsupported-live-shape',
			'missing-index',
			'field-mask'
		]),
		node: Schema.NonEmptyString,
		relationship: Schema.optionalKey(Schema.NonEmptyString),
		message: Schema.NonEmptyString
	}
) {
	readonly category = 'effective-plan' as const;
	readonly retryable = false;
}

export class WhereCompileError extends Schema.TaggedError<WhereCompileError>()(
	'Bolt.Collections.WhereCompileError',
	{
		collection: Schema.NonEmptyString,
		field: Schema.NonEmptyString,
		message: Schema.NonEmptyString,
		node: Schema.optionalKey(Schema.NonEmptyString),
		relationship: Schema.optionalKey(Schema.NonEmptyString)
	}
) {}

export type OrderTerm = Readonly<{
	readonly column: string;
	readonly direction: 'asc' | 'desc';
}>;
type EffectivePlanMode = 'live-prefix' | 'one-shot';
export type EffectiveFieldRequirement = Readonly<{
	readonly collection: string;
	readonly field: string;
	readonly purpose: 'filter' | 'join' | 'order' | 'projection' | 'field-mask';
}>;
export type EffectiveProjection = Readonly<{
	readonly collection: string;
	readonly relationship?: string;
	readonly fields: ReadonlyArray<string>;
	readonly order: ReadonlyArray<
		Readonly<{ readonly field: string; readonly direction: 'asc' | 'desc' }>
	>;
	readonly limit: number;
	readonly children: ReadonlyArray<EffectiveProjection>;
}>;
type EffectiveQueryExecution = Readonly<{
	readonly collection: string;
	readonly kind: 'findMany' | 'findFirst' | 'count' | 'findGrouped';
	readonly where?: unknown;
	readonly userFilter?: unknown;
	readonly orderBy?: unknown;
	readonly with?: unknown;
	readonly columns?: unknown;
	readonly limit: number;
	readonly after?: string;
	readonly search?: Readonly<{ readonly mode?: unknown }>;
}>;
type EffectiveAuthorityPlan = Readonly<{
	readonly collections: ReadonlyArray<string>;
	readonly subjectOperands: ReadonlyArray<EffectiveSubjectOperand>;
	readonly source: ReadonlyArray<PolicyHashSource>;
	readonly fingerprint: string;
}>;
export type EffectiveQueryPlan = Readonly<{
	readonly mode: EffectivePlanMode;
	readonly rootCollection: string;
	readonly schemaFingerprint: string | null;
	readonly sql: SQL;
	readonly dependencies: ReadonlyArray<string>;
	readonly reversePaths: ReadonlyArray<CollectionReversePath>;
	readonly indexRequirements: ReadonlyArray<CollectionIndexRequirement>;
	readonly routing: ReadonlyArray<PredicateRoutingConstraint>;
	readonly authority: EffectiveAuthorityPlan;
	readonly execution: EffectiveQueryExecution;
	readonly fingerprint: string;
	readonly order: ReadonlyArray<
		Readonly<{ readonly field: string; readonly direction: 'asc' | 'desc' }>
	>;
	readonly projection: EffectiveProjection;
	readonly fields: ReadonlyArray<EffectiveFieldRequirement>;
	readonly limit: number;
	readonly oneShotReason?: string;
}>;
type EffectiveQueryNarrowing = Readonly<{
	readonly where?: unknown;
	readonly limit?: number;
	readonly after?: string;
}>;

const combinedWhere = (left: unknown, right: unknown): unknown => {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return { AND: [left, right] };
};

export const narrowEffectiveQuery = (
	plan: Pick<EffectiveQueryPlan, 'execution'>,
	narrowing: EffectiveQueryNarrowing = {}
): EffectiveQueryExecution => ({
	...plan.execution,
	where: combinedWhere(plan.execution.where, narrowing.where),
	...(narrowing.limit === undefined ? {} : { limit: narrowing.limit }),
	...(narrowing.after === undefined ? {} : { after: narrowing.after })
});

export const effectiveOrderTerms = (
	plan: Pick<EffectiveQueryPlan, 'order'>
): ReadonlyArray<OrderTerm> =>
	plan.order.map(({ field, direction }) => ({ column: field, direction }));

type ResolvedRelationship = Readonly<{
	readonly definition: RelationDefinition;
	readonly identity: string;
	readonly segment: string;
	readonly sourceField: string;
	readonly targetField: string;
}>;
type ForwardSegment = Readonly<{
	readonly relationship: string;
	readonly segment: string;
	readonly sourceCollection: string;
	readonly sourceField: string;
	readonly targetCollection: string;
	readonly targetField: string;
}>;
type EffectiveSubjectOperand = 'id' | 'email' | 'team' | 'tenantId' | 'admin';
type SubjectOperandName = EffectiveSubjectOperand | 'teamIds';
type PlanResult<A> = Result.Result<A, EffectivePlanError>;
type PredicateState = {
	readonly dependencies: Set<string>;
	readonly reversePaths: Map<string, CollectionReversePath>;
	readonly indexes: Map<string, CollectionIndexRequirement>;
	readonly routing: Map<string, PredicateRoutingConstraint>;
	readonly fields: Map<string, PredicateFieldRequirement>;
	readonly subjectOperands: Set<EffectiveSubjectOperand>;
	actorBound: boolean;
	alias: number;
	opaque: boolean;
};

const stateFor = (root: string): PredicateState => ({
	dependencies: new Set([root]),
	reversePaths: new Map(),
	indexes: new Map(),
	routing: new Map(),
	fields: new Map(),
	subjectOperands: new Set(),
	actorBound: false,
	alias: 0,
	opaque: false
});

const diagnostic = (
	code: EffectivePlanError['code'],
	node: string,
	message: string,
	relationship?: string
): PlanResult<never> =>
	Result.fail(
		new EffectivePlanError({
			code,
			node,
			message,
			...(relationship === undefined ? {} : { relationship })
		})
	);

const failed = <A>(result: Result.Failure<unknown, EffectivePlanError>): PlanResult<A> =>
	Result.fail(result.failure);

const relationshipIdentity = (relation: RelationDefinition): string =>
	`${relation.source}.${relation.name}`;
const segmentIdentity = (
	relation: RelationDefinition,
	sourceField: string,
	targetField: string
): string =>
	`${relationshipIdentity(relation)}:${relation.source}.${sourceField}->${relation.target}.${targetField}`;

export const resolveCompiledRelationship = (
	relationships: CompiledAuthoring['relationships'],
	source: string,
	name: string,
	node: string
): PlanResult<ResolvedRelationship> => {
	const identity = `${source}.${name}`;
	const candidates = relationships.filter(
		(relation) => relation.source === source && relation.name === name
	);
	if (candidates.length === 0)
		return diagnostic(
			'unknown-relationship',
			node,
			`Query node ${node} names no compiled relationship ${identity}.`,
			identity
		);
	if (candidates.length !== 1)
		return diagnostic(
			'ambiguous-relationship',
			node,
			`Query node ${node} resolves to ${candidates.length} compiled relationships named ${identity}.`,
			identity
		);
	const relation = candidates[0]!;
	const from = relation.from;
	const to = relation.to;
	const oriented =
		from !== undefined && to !== undefined
			? from.collection === source && to.collection === relation.target
				? { sourceField: from.column, targetField: to.column }
				: to.collection === source && from.collection === relation.target
					? { sourceField: to.column, targetField: from.column }
					: undefined
			: undefined;
	if (oriented === undefined)
		return diagnostic(
			'unresolved-segment',
			node,
			`Query node ${node} cannot traverse compiled relationship ${identity}: its ordered source/target segment endpoints are missing or inconsistent.`,
			identity
		);
	return Result.succeed({
		definition: relation,
		identity,
		segment: segmentIdentity(relation, oriented.sourceField, oriented.targetField),
		sourceField: oriented.sourceField,
		targetField: oriented.targetField
	});
};

const fieldsOf = (
	definition: WorkspaceDefinition,
	collection: string
): Readonly<Record<string, FieldDefinition>> | undefined =>
	definition.collections.find((entry) => entry.name === collection)?.fields;

const isField = (definition: WorkspaceDefinition, collection: string, field: string): boolean =>
	SYSTEM_COLUMN_NAMES.includes(field) ||
	Object.hasOwn(fieldsOf(definition, collection) ?? {}, field);

const fieldDefinition = (
	definition: WorkspaceDefinition,
	collection: string,
	field: string
): FieldDefinition | undefined => fieldsOf(definition, collection)?.[field];

const addField = (
	state: PredicateState,
	collection: string,
	field: string,
	purpose: PredicateFieldRequirement['purpose']
): void => {
	state.fields.set(`${collection}\u0000${field}\u0000${purpose}`, { collection, field, purpose });
};

const addIndex = (
	state: PredicateState,
	collection: string,
	field: string,
	reason: CollectionIndexRequirement['reason']
): void => {
	if (field === 'id') return;
	const key = `${collection}\u0000${field}`;
	if (state.indexes.get(key)?.reason === 'relationship') return;
	state.indexes.set(key, { collection, field, reason });
};

const reverseSegments = (
	chain: ReadonlyArray<ForwardSegment>
): ReadonlyArray<CollectionRelationshipSegment> =>
	[...chain].reverse().map((segment) => ({
		relationship: segment.relationship,
		segment: segment.segment,
		fromCollection: segment.targetCollection,
		fromField: segment.targetField,
		toCollection: segment.sourceCollection,
		toField: segment.sourceField
	}));

const reverseKey = (path: CollectionReversePath): string =>
	`${path.collection}\u0000${path.segments.map(({ segment }) => segment).join('\u0001')}`;

const addReversePath = (
	state: PredicateState,
	collection: string,
	chain: ReadonlyArray<ForwardSegment>
): void => {
	if (chain.length === 0) return;
	const path = { collection, segments: reverseSegments(chain) };
	state.reversePaths.set(reverseKey(path), path);
};

const rebaseSemantics = (
	value: PredicateSemantics | undefined,
	rootCollection: string,
	chain: ReadonlyArray<ForwardSegment>
): PredicateSemantics | undefined => {
	if (value === undefined || chain.length === 0) return value;
	const outer = reverseSegments(chain);
	const paths = new Map<string, CollectionReversePath>();
	for (const dependency of value.dependencies) {
		const local = value.reversePaths.filter((path) => path.collection === dependency);
		const candidates =
			local.length === 0 && dependency === rootCollection
				? [{ collection: dependency, segments: [] }]
				: local;
		for (const path of candidates) {
			const rebased = { collection: path.collection, segments: [...path.segments, ...outer] };
			paths.set(
				`${rebased.collection}:${rebased.segments.map(({ segment }) => segment).join(':')}`,
				rebased
			);
		}
	}
	return { ...value, reversePaths: [...paths.values()] };
};

const absorbRelatedPolicy = (
	state: PredicateState,
	semantics: PredicateSemantics | undefined,
	policyRoot: string,
	chain: ReadonlyArray<ForwardSegment>
): void => {
	const rebased = rebaseSemantics(semantics, policyRoot, chain);
	if (rebased === undefined) return;
	for (const dependency of rebased.dependencies) state.dependencies.add(dependency);
	for (const path of rebased.reversePaths) state.reversePaths.set(reverseKey(path), path);
	for (const requirement of rebased.indexRequirements)
		addIndex(state, requirement.collection, requirement.field, requirement.reason);
	for (const field of rebased.fields) addField(state, field.collection, field.field, field.purpose);
	for (const operand of rebased.subjectOperands ?? []) state.subjectOperands.add(operand);
	state.actorBound ||= (rebased.subjectOperands?.length ?? 0) > 0;
	state.opaque ||= rebased.opaque;
};

const bindSubject = (subject: Subject, name: SubjectOperandName): Schema.Json =>
	name === 'id'
		? subject.userId
		: name === 'email'
			? (subject.email ?? null)
			: name === 'team'
				? (subject.teamPath[0] ?? null)
				: name === 'teamIds'
					? Object.freeze([...subject.teamPath])
					: name === 'tenantId'
						? subject.tenantId
						: subject.admin === true;

const subjectOperand = (value: unknown): SubjectOperandName | undefined => {
	if (!isObject(value) || Object.keys(value).length !== 1) return undefined;
	const name = value['$subject'];
	return isString(name) && (SUBJECT_OPERANDS as ReadonlyArray<string>).includes(name)
		? (name as SubjectOperandName)
		: undefined;
};

const bindOperand = (
	value: unknown,
	subject: Subject | undefined,
	state: PredicateState,
	node: string
): PlanResult<Schema.Json> => {
	const operand = subjectOperand(value);
	if (operand !== undefined) {
		if (subject === undefined)
			return diagnostic(
				'unbound-subject',
				node,
				`Query node ${node} uses subject.${operand} outside a policy-bound compilation.`
			);
		state.actorBound = true;
		state.subjectOperands.add(operand === 'teamIds' ? 'team' : operand);
		return Result.succeed(bindSubject(subject, operand));
	}
	if (value instanceof Date)
		return Number.isNaN(value.getTime())
			? diagnostic('invalid-node', node, `Query node ${node} contains an invalid Date operand.`)
			: Result.succeed(value.toISOString());
	if (isBigint(value)) return Result.succeed(value.toString());
	return isJson(value)
		? Result.succeed(value)
		: diagnostic('invalid-node', node, `Query node ${node} contains an unbindable operand.`);
};

const bindScalarOperand = (
	value: unknown,
	subject: Subject | undefined,
	state: PredicateState,
	node: string
): PlanResult<Schema.Json> =>
	subjectOperand(value) === 'teamIds'
		? diagnostic(
				'invalid-node',
				node,
				`Query node ${node} uses set-valued subject.teamIds with a scalar operator.`
			)
		: bindOperand(value, subject, state, node);

const boundValues = (
	value: unknown,
	subject: Subject | undefined,
	state: PredicateState,
	node: string
): PlanResult<ReadonlyArray<Schema.Json>> => {
	if (subjectOperand(value) === 'teamIds') {
		const bound = bindOperand(value, subject, state, node);
		if (Result.isFailure(bound)) return failed(bound);
		return Array.isArray(bound.success)
			? Result.succeed(bound.success)
			: diagnostic('invalid-node', node, `Query node ${node} requires an array operand.`);
	}
	if (!Array.isArray(value))
		return diagnostic('invalid-node', node, `Query node ${node} requires an array operand.`);
	const values: Array<Schema.Json> = [];
	for (let index = 0; index < value.length; index += 1) {
		const bound = bindScalarOperand(value[index], subject, state, `${node}[${index}]`);
		if (Result.isFailure(bound)) return failed(bound);
		values.push(bound.success);
	}
	return Result.succeed(values);
};

const joinExpression = (
	kind: 'and' | 'or',
	expressions: ReadonlyArray<RowPredicateExpression>
): RowPredicateExpression =>
	expressions.length === 0
		? { kind: 'constant', value: kind === 'and' }
		: expressions.length === 1
			? expressions[0]!
			: { kind, expressions };

const exclusiveOperator = (
	value: Readonly<Record<string, unknown>>,
	reserved: ReadonlyArray<string>
): string | undefined => {
	const operators = Object.keys(value).filter((key) => !reserved.includes(key));
	return operators.length === 1 ? operators[0] : undefined;
};

const jsonSegments = (
	path: unknown,
	requireNonEmpty: boolean
): ReadonlyArray<string> | undefined => {
	if (!Array.isArray(path) || (requireNonEmpty && path.length === 0)) return undefined;
	return path.every((part) => isString(part) && part.length > 0) ? path : undefined;
};

const compileJsonPath = (
	definition: WorkspaceDefinition,
	collection: string,
	field: string,
	value: unknown,
	subject: Subject | undefined,
	state: PredicateState,
	node: string
): PlanResult<RowPredicateExpression> => {
	if (fieldDefinition(definition, collection, field)?.type !== 'json')
		return diagnostic(
			'invalid-node',
			node,
			`Query node ${node} applies jsonPath to a non-JSON field.`
		);
	if (!isObject(value))
		return diagnostic('invalid-node', node, `Query node ${node} must be an object.`);
	const path = jsonSegments(value['path'], true);
	const valueType = value['type'];
	const transform = value['transform'];
	if (path === undefined)
		return diagnostic(
			'invalid-node',
			node,
			`Query node ${node}.path must name JSON path segments.`
		);
	if (!(JSON_PATH_TYPES as ReadonlyArray<string>).includes(String(valueType)))
		return diagnostic('invalid-node', node, `Query node ${node}.type is unsupported.`);
	if (transform !== undefined && transform !== 'case-fold')
		return diagnostic('invalid-node', node, `Query node ${node}.transform is unsupported.`);
	const operator = exclusiveOperator(value, ['path', 'type', 'transform']);
	if (operator === undefined || !(JSON_PATH_OPS as ReadonlyArray<string>).includes(operator))
		return diagnostic(
			'invalid-node',
			node,
			operator === undefined
				? `Query node ${node} requires exactly one comparison.`
				: `Query node ${node} has unsupported comparison ${String(operator)}.`
		);
	if ((operator === 'isNull' || operator === 'isNotNull') && !isBoolean(value[operator]))
		return diagnostic(
			'invalid-node',
			`${node}.${operator}`,
			`Query node ${node}.${operator} requires a boolean operand.`
		);
	const normalizedOperator =
		operator === 'isNull' || operator === 'isNotNull'
			? value[operator] === true
				? operator
				: operator === 'isNull'
					? 'isNotNull'
					: 'isNull'
			: operator;
	const values =
		operator === 'isNull' || operator === 'isNotNull'
			? Result.succeed([] as ReadonlyArray<Schema.Json>)
			: operator === 'in' || operator === 'notIn'
				? boundValues(value[operator], subject, state, `${node}.${operator}`)
				: Result.map(
						bindScalarOperand(value[operator], subject, state, `${node}.${operator}`),
						(bound) => [bound]
					);
	if (Result.isFailure(values)) return failed(values);
	const valueMatchesType = (entry: Schema.Json): boolean =>
		entry === null ||
		valueType === 'json' ||
		(valueType === 'number' && isNumber(entry)) ||
		(valueType === 'boolean' && isBoolean(entry)) ||
		((valueType === 'string' || valueType === 'instant') && isString(entry));
	if (!values.success.every(valueMatchesType))
		return diagnostic(
			'invalid-node',
			node,
			`Query node ${node} has an operand incompatible with JSON path type ${String(valueType)}.`
		);
	return Result.succeed({
		kind: 'json-path',
		column: field,
		path,
		valueType: valueType as (typeof JSON_PATH_TYPES)[number],
		...(transform === 'case-fold' ? { transform } : {}),
		operator: normalizedOperator as (typeof JSON_PATH_OPS)[number],
		values: values.success
	});
};

const compileJsonArraySome = (
	definition: WorkspaceDefinition,
	collection: string,
	field: string,
	value: unknown,
	subject: Subject | undefined,
	state: PredicateState,
	node: string
): PlanResult<RowPredicateExpression> => {
	if (fieldDefinition(definition, collection, field)?.type !== 'json')
		return diagnostic(
			'invalid-node',
			node,
			`Query node ${node} applies jsonArraySome to a non-JSON field.`
		);
	if (!isObject(value))
		return diagnostic('invalid-node', node, `Query node ${node} must be an object.`);
	const path = jsonSegments(value['path'] ?? [], false);
	if (path === undefined)
		return diagnostic(
			'invalid-node',
			node,
			`Query node ${node}.path must contain JSON path segments.`
		);
	const transform = value['transform'];
	if (transform !== undefined && transform !== 'case-fold')
		return diagnostic('invalid-node', node, `Query node ${node}.transform is unsupported.`);
	const operator = exclusiveOperator(value, ['path', 'transform']);
	if (operator !== 'eq' && operator !== 'in')
		return diagnostic('invalid-node', node, `Query node ${node} requires exactly one of eq or in.`);
	const values =
		operator === 'in'
			? boundValues(value[operator], subject, state, `${node}.${operator}`)
			: Result.map(
					bindScalarOperand(value[operator], subject, state, `${node}.${operator}`),
					(bound) => [bound]
				);
	if (Result.isFailure(values)) return failed(values);
	if (!values.success.every((entry) => entry === null || isString(entry)))
		return diagnostic(
			'invalid-node',
			node,
			`Query node ${node} requires string JSON-array members.`
		);
	return Result.succeed({
		kind: 'json-array-some',
		column: field,
		path,
		...(transform === 'case-fold' ? { transform } : {}),
		operator,
		values: values.success,
		alias: `pa${state.alias++}`
	});
};

const compileReferenceField = (
	definition: NonNullable<FieldDefinition['reference']>,
	operator: string,
	value: unknown,
	subject: Subject | undefined,
	state: PredicateState,
	node: string
): PlanResult<RowPredicateExpression> => {
	if (operator === 'isNull' || operator === 'isNotNull') {
		if (!isBoolean(value))
			return diagnostic('invalid-node', node, `Query node ${node} requires a boolean operand.`);
		const wantsNull = operator === 'isNull' ? value : !value;
		return Result.succeed(
			joinExpression(
				wantsNull ? 'and' : 'or',
				definition.targets.map((target) => ({
					kind: 'null',
					column: target.storageColumn,
					negated: !wantsNull
				}))
			)
		);
	}
	if (operator === 'kind') {
		if (!isObject(value))
			return diagnostic('invalid-node', node, `Query node ${node} must be an object.`);
		const entries = Object.entries(value);
		const comparison = entries[0];
		if (
			entries.length !== 1 ||
			comparison === undefined ||
			(comparison[0] !== 'eq' && comparison[0] !== 'ne') ||
			!isString(comparison[1])
		)
			return diagnostic(
				'invalid-node',
				node,
				`Query node ${node} accepts exactly kind.eq or kind.ne.`
			);
		const target = definition.targets.find(({ tag }) => tag === comparison[1]);
		return target === undefined
			? diagnostic('invalid-node', node, `Query node ${node} names an unknown reference kind.`)
			: Result.succeed({
					kind: 'null',
					column: target.storageColumn,
					negated: comparison[0] === 'eq'
				});
	}
	const values = operator === 'in' || operator === 'notIn' ? value : [value];
	if (!Array.isArray(values))
		return diagnostic('invalid-node', node, `Query node ${node} requires an array.`);
	const expressions: Array<RowPredicateExpression> = [];
	for (let index = 0; index < values.length; index += 1) {
		const bound = bindScalarOperand(values[index], subject, state, `${node}[${index}]`);
		if (Result.isFailure(bound)) return failed(bound);
		if (!isObject(bound.success))
			return diagnostic('invalid-node', node, `Query node ${node} requires { kind, id } operands.`);
		const kind = bound.success['kind'];
		const id = bound.success['id'];
		const target = definition.targets.find(({ tag }) => tag === kind);
		if (target === undefined || !isString(id))
			return diagnostic(
				'invalid-node',
				node,
				`Query node ${node} requires a known kind and string id.`
			);
		expressions.push({
			kind: 'comparison',
			column: target.storageColumn,
			operator: operator === 'ne' || operator === 'notIn' ? 'ne' : 'eq',
			value: id
		});
	}
	return Result.succeed(
		joinExpression(operator === 'ne' || operator === 'notIn' ? 'and' : 'or', expressions)
	);
};

const compileFieldOperator = (
	definition: WorkspaceDefinition,
	collection: string,
	field: string,
	operator: string,
	value: unknown,
	subject: Subject | undefined,
	state: PredicateState,
	node: string,
	routeSafe: boolean
): PlanResult<RowPredicateExpression> => {
	const described = fieldDefinition(definition, collection, field);
	if (described?.reference !== undefined)
		return compileReferenceField(described.reference, operator, value, subject, state, node);
	if (operator === 'jsonPath')
		return compileJsonPath(definition, collection, field, value, subject, state, node);
	if (operator === 'jsonArraySome')
		return compileJsonArraySome(definition, collection, field, value, subject, state, node);
	if (operator === 'approvalParty') {
		if (value !== true)
			return diagnostic('invalid-node', node, `Query node ${node} accepts only true.`);
		if (subject === undefined)
			return diagnostic('unbound-subject', node, `Query node ${node} is policy-only.`);
		const relationName =
			collection === 'approval_request' && field === 'id'
				? 'requestors'
				: collection === 'requestor' && field === 'approval_request_id'
					? 'approvalRequest'
					: undefined;
		if (relationName === undefined)
			return diagnostic(
				'invalid-node',
				node,
				`Query node ${node} may apply approvalParty only to approval_request.id or requestor.approval_request_id.`
			);
		const resolved = resolveCompiledRelationship(
			definition.relations,
			collection,
			relationName,
			node
		);
		if (Result.isFailure(resolved)) return failed(resolved);
		const relation = resolved.success;
		const segment: ForwardSegment = {
			relationship: relation.identity,
			segment: relation.segment,
			sourceCollection: collection,
			sourceField: relation.sourceField,
			targetCollection: relation.definition.target,
			targetField: relation.targetField
		};
		state.subjectOperands.add('id');
		state.subjectOperands.add('team');
		state.subjectOperands.add('admin');
		state.dependencies.add('approval_request');
		state.dependencies.add('requestor');
		state.dependencies.add(relation.definition.target);
		addReversePath(state, relation.definition.target, [segment]);
		addField(state, collection, relation.sourceField, 'join');
		addField(state, relation.definition.target, relation.targetField, 'join');
		addField(state, 'requestor', 'user_id', 'filter');
		addField(state, 'approval_request', 'approver_teams', 'filter');
		addField(state, 'approval_request', 'superseder_teams', 'filter');
		addIndex(state, collection, relation.sourceField, 'relationship');
		addIndex(state, relation.definition.target, relation.targetField, 'relationship');
		return Result.succeed({
			kind: 'approval-party',
			column: field,
			subjectId: subject.userId,
			subjectTeam: subject.teamPath[0] ?? null,
			administrator: subject.admin === true
		});
	}
	if (operator === 'teamScopeUsers') {
		if (value !== true)
			return diagnostic('invalid-node', node, `Query node ${node} accepts only true.`);
		if (subject === undefined)
			return diagnostic('unbound-subject', node, `Query node ${node} is policy-only.`);
		state.subjectOperands.add('id');
		state.dependencies.add('team');
		state.dependencies.add('user');
		addField(state, 'user', 'id', 'filter');
		addField(state, 'user', 'team_id', 'join');
		addField(state, 'team', 'id', 'join');
		addField(state, 'team', 'parent_id', 'join');
		addIndex(state, collection, field, 'routing');
		addIndex(state, 'user', 'team_id', 'relationship');
		addIndex(state, 'team', 'parent_id', 'relationship');
		return Result.succeed({ kind: 'team-scope-users', column: field, subjectId: subject.userId });
	}
	if (operator === 'isNull' || operator === 'isNotNull') {
		if (!isBoolean(value))
			return diagnostic('invalid-node', node, `Query node ${node} requires a boolean operand.`);
		return Result.succeed({
			kind: 'null',
			column: field,
			negated: !(operator === 'isNull' ? value : !value)
		});
	}
	if (operator === 'in' || operator === 'notIn') {
		const values = boundValues(value, subject, state, node);
		if (Result.isFailure(values)) return failed(values);
		if (routeSafe && operator === 'in' && values.success.length > 0) {
			state.routing.set(field, { field, values: values.success });
			addIndex(state, collection, field, 'routing');
		}
		return Result.succeed({
			kind: 'membership',
			column: field,
			negated: operator === 'notIn',
			values: values.success,
			...(described?.type === 'json' ? { encoding: 'jsonb' as const } : {})
		});
	}
	if (operator === 'caseFoldEq' || operator === 'caseFoldIn') {
		const values =
			operator === 'caseFoldIn'
				? boundValues(value, subject, state, node)
				: Result.map(bindScalarOperand(value, subject, state, node), (bound) => [bound]);
		if (Result.isFailure(values)) return failed(values);
		if (!values.success.every((entry) => entry === null || isString(entry)))
			return diagnostic('invalid-node', node, `Query node ${node} requires string operands.`);
		return Result.succeed({
			kind: 'case-fold',
			column: field,
			operator: operator === 'caseFoldEq' ? 'eq' : 'in',
			values: values.success
		});
	}
	if (operator === 'contains_date') {
		const bound = bindScalarOperand(value, subject, state, node);
		if (Result.isFailure(bound)) return failed(bound);
		return isString(bound.success)
			? Result.succeed({ kind: 'contains-date', column: field, value: bound.success })
			: diagnostic('invalid-node', node, `Query node ${node} requires a canonical instant string.`);
	}
	if (operator === 'overlaps') {
		if (!isObject(value))
			return diagnostic('invalid-node', node, `Query node ${node} must be an object.`);
		const start = bindScalarOperand(value['start'], subject, state, `${node}.start`);
		if (Result.isFailure(start)) return failed(start);
		const end = bindScalarOperand(value['end'], subject, state, `${node}.end`);
		if (Result.isFailure(end)) return failed(end);
		return !isString(start.success) || !isString(end.success)
			? diagnostic('invalid-node', node, `Query node ${node} requires canonical instant strings.`)
			: Result.succeed({ kind: 'overlaps', column: field, start: start.success, end: end.success });
	}
	if (!(COMPARISON_OPS as ReadonlyArray<string>).includes(operator))
		return diagnostic(
			'invalid-node',
			node,
			`Query node ${node} uses unsupported operator ${operator}.`
		);
	const bound = bindScalarOperand(value, subject, state, node);
	if (Result.isFailure(bound)) return failed(bound);
	if (
		(operator === 'like' ||
			operator === 'ilike' ||
			operator === 'notLike' ||
			operator === 'notIlike') &&
		!isString(bound.success)
	)
		return diagnostic('invalid-node', node, `Query node ${node} requires a string operand.`);
	if (routeSafe && operator === 'eq') {
		state.routing.set(field, { field, values: [bound.success] });
		addIndex(state, collection, field, 'routing');
	}
	return Result.succeed({
		kind: 'comparison',
		column: field,
		operator: operator as (typeof COMPARISON_OPS)[number],
		value: bound.success,
		...(described?.type === 'json' ? { encoding: 'jsonb' as const } : {})
	});
};

const compileField = (
	definition: WorkspaceDefinition,
	collection: string,
	field: string,
	condition: unknown,
	subject: Subject | undefined,
	state: PredicateState,
	node: string,
	routeSafe: boolean
): PlanResult<RowPredicateExpression> => {
	addField(state, collection, field, 'filter');
	if (!isObject(condition) || subjectOperand(condition) !== undefined)
		return compileFieldOperator(
			definition,
			collection,
			field,
			'eq',
			condition,
			subject,
			state,
			node,
			routeSafe
		);
	if (Object.keys(condition).length === 0)
		return diagnostic('invalid-node', node, `Query node ${node} must name at least one operator.`);
	const expressions: Array<RowPredicateExpression> = [];
	for (const [operator, value] of Object.entries(condition)) {
		const compiled = compileFieldOperator(
			definition,
			collection,
			field,
			operator,
			value,
			subject,
			state,
			`${node}.${operator}`,
			routeSafe
		);
		if (Result.isFailure(compiled)) return failed(compiled);
		expressions.push(compiled.success);
	}
	return Result.succeed(joinExpression('and', expressions));
};

const compileNode = (
	definition: WorkspaceDefinition,
	collection: string,
	where: unknown,
	subject: Subject | undefined,
	state: PredicateState,
	policyFor: ((collection: string) => RowPredicate) | undefined,
	chain: ReadonlyArray<ForwardSegment>,
	depth: number,
	node: string,
	routeSafe: boolean
): PlanResult<RowPredicateExpression> => {
	if (where === undefined || where === null)
		return Result.succeed({ kind: 'constant', value: true });
	if (!isObject(where))
		return diagnostic('invalid-node', node, `Query node ${node} must be an object.`);
	const clauses: Array<RowPredicateExpression> = [];
	for (const [name, condition] of Object.entries(where)) {
		const childNode = `${node}.${name}`;
		if (name === 'AND' || name === 'OR') {
			if (!Array.isArray(condition))
				return diagnostic('invalid-node', childNode, `Query node ${childNode} requires an array.`);
			const branches: Array<RowPredicateExpression> = [];
			for (let index = 0; index < condition.length; index += 1) {
				const branch = compileNode(
					definition,
					collection,
					condition[index],
					subject,
					state,
					policyFor,
					chain,
					depth,
					`${childNode}[${index}]`,
					routeSafe && name === 'AND'
				);
				if (Result.isFailure(branch)) return failed(branch);
				branches.push(branch.success);
			}
			clauses.push(joinExpression(name === 'AND' ? 'and' : 'or', branches));
			continue;
		}
		if (name === 'NOT') {
			const nested = compileNode(
				definition,
				collection,
				condition,
				subject,
				state,
				policyFor,
				chain,
				depth,
				childNode,
				false
			);
			if (Result.isFailure(nested)) return failed(nested);
			clauses.push({ kind: 'not', expression: nested.success });
			continue;
		}
		if (isField(definition, collection, name)) {
			const compiled = compileField(
				definition,
				collection,
				name,
				condition,
				subject,
				state,
				childNode,
				routeSafe && chain.length === 0
			);
			if (Result.isFailure(compiled)) return failed(compiled);
			clauses.push(compiled.success);
			continue;
		}
		if (!isObject(condition))
			return diagnostic(
				'unknown-field',
				childNode,
				`Query node ${childNode} is neither a field of ${collection} nor a compiled relationship.`
			);
		if (depth >= MAX_COLLECTION_PREDICATE_DEPTH)
			return diagnostic(
				'max-depth',
				childNode,
				`Query node ${childNode} exceeds the maximum relationship depth ${MAX_COLLECTION_PREDICATE_DEPTH}.`,
				`${collection}.${name}`
			);
		const resolved = resolveCompiledRelationship(definition.relations, collection, name, childNode);
		if (Result.isFailure(resolved)) return failed(resolved);
		const quantifiers = Object.keys(condition).filter(
			(key) => key === 'some' || key === 'none' || key === 'every'
		);
		const implicitSome = quantifiers.length === 0;
		if (!implicitSome && (quantifiers.length !== 1 || Object.keys(condition).length !== 1))
			return diagnostic(
				'invalid-node',
				childNode,
				`Query node ${childNode} requires exactly one of some, none, or every.`,
				`${collection}.${name}`
			);
		const relation = resolved.success;
		state.dependencies.add(relation.definition.target);
		addField(state, collection, relation.sourceField, 'join');
		addField(state, relation.definition.target, relation.targetField, 'join');
		addIndex(state, collection, relation.sourceField, 'relationship');
		addIndex(state, relation.definition.target, relation.targetField, 'relationship');
		const segment: ForwardSegment = {
			relationship: relation.identity,
			segment: relation.segment,
			sourceCollection: collection,
			sourceField: relation.sourceField,
			targetCollection: relation.definition.target,
			targetField: relation.targetField
		};
		const nextChain = [...chain, segment];
		addReversePath(state, relation.definition.target, nextChain);
		const quantifier = (quantifiers[0] ?? 'some') as 'some' | 'none' | 'every';
		const alias = `pr${state.alias++}`;
		const nested = compileNode(
			definition,
			relation.definition.target,
			implicitSome ? condition : condition[quantifier],
			subject,
			state,
			policyFor,
			nextChain,
			depth + 1,
			`${childNode}.${quantifier}`,
			false
		);
		if (Result.isFailure(nested)) return failed(nested);
		const relatedPolicy = policyFor?.(relation.definition.target);
		absorbRelatedPolicy(state, relatedPolicy?.semantics, relation.definition.target, nextChain);
		clauses.push({
			kind: 'relation',
			relationship: relation.identity,
			segment: relation.segment,
			sourceCollection: collection,
			sourceField: relation.sourceField,
			targetCollection: relation.definition.target,
			targetField: relation.targetField,
			alias,
			quantifier,
			...(relatedPolicy === undefined ? {} : { visibility: relatedPolicy.expression }),
			expression: nested.success
		});
	}
	return Result.succeed(joinExpression('and', clauses));
};

const semanticsOf = (
	state: PredicateState
): PredicateSemantics &
	Readonly<{ readonly subjectOperands: ReadonlyArray<EffectiveSubjectOperand> }> => ({
	dependencies: [...state.dependencies].toSorted(),
	reversePaths: [...state.reversePaths.values()].toSorted((left, right) =>
		`${left.collection}:${left.segments.map(({ segment }) => segment).join(':')}`.localeCompare(
			`${right.collection}:${right.segments.map(({ segment }) => segment).join(':')}`
		)
	),
	indexRequirements: [...state.indexes.values()].toSorted((left, right) =>
		`${left.collection}.${left.field}`.localeCompare(`${right.collection}.${right.field}`)
	),
	routing: [...state.routing.values()].toSorted((left, right) =>
		left.field.localeCompare(right.field)
	),
	fields: [...state.fields.values()].toSorted((left, right) =>
		`${left.collection}.${left.field}.${left.purpose}`.localeCompare(
			`${right.collection}.${right.field}.${right.purpose}`
		)
	),
	opaque: state.opaque,
	subjectOperands: [...state.subjectOperands].toSorted()
});

type CompiledStructuredPredicate = Readonly<{
	readonly expression: RowPredicateExpression;
	readonly sql: SQL;
	readonly semantics: ReturnType<typeof semanticsOf>;
}>;

export const compileStructuredPredicate = (
	input: Readonly<{
		readonly definition: WorkspaceDefinition;
		readonly rootCollection: string;
		readonly where: unknown;
		readonly subject?: Subject;
		readonly policyFor?: (collection: string) => RowPredicate;
		readonly qualifier?: string;
		readonly node?: string;
	}>
): PlanResult<CompiledStructuredPredicate> => {
	if (fieldsOf(input.definition, input.rootCollection) === undefined)
		return diagnostic(
			'unknown-field',
			input.node ?? 'where',
			`Predicate root ${input.rootCollection} is not a compiled collection.`
		);
	const state = stateFor(input.rootCollection);
	const expression = compileNode(
		input.definition,
		input.rootCollection,
		input.where,
		input.subject,
		state,
		input.policyFor,
		[],
		0,
		input.node ?? 'where',
		true
	);
	if (Result.isFailure(expression)) return failed(expression);
	return Result.succeed({
		expression: expression.success,
		sql: predicateExpression(
			{
				allowed: true,
				reason: 'compiled structured predicate',
				expression: expression.success,
				actorBound: state.actorBound || state.subjectOperands.size > 0
			},
			input.qualifier === undefined ? undefined : { qualifier: input.qualifier }
		),
		semantics: semanticsOf(state)
	});
};

export const compileCollectionPredicate = (
	input: Readonly<{
		readonly definition: WorkspaceDefinition;
		readonly collection: string;
		readonly where: unknown;
		readonly qualifier?: string;
		readonly node?: string;
	}>
): Result.Result<CompiledStructuredPredicate, WhereCompileError> => {
	const compiled = compileStructuredPredicate({
		definition: input.definition,
		rootCollection: input.collection,
		where: input.where,
		...(input.qualifier === undefined ? {} : { qualifier: input.qualifier }),
		...(input.node === undefined ? {} : { node: input.node })
	});
	if (Result.isSuccess(compiled)) return Result.succeed(compiled.success);
	return Result.fail(
		new WhereCompileError({
			collection: input.collection,
			field: compiled.failure.node,
			node: compiled.failure.node,
			message: compiled.failure.message,
			...(compiled.failure.relationship === undefined
				? {}
				: { relationship: compiled.failure.relationship })
		})
	);
};

export const mergePredicateSemantics = (
	values: ReadonlyArray<PredicateSemantics | undefined>
): PredicateSemantics => {
	const dependencies = new Set<string>();
	const reverse = new Map<string, CollectionReversePath>();
	const indexes = new Map<string, CollectionIndexRequirement>();
	const routing = new Map<string, PredicateRoutingConstraint>();
	const fields = new Map<string, PredicateFieldRequirement>();
	const subjectOperands = new Set<NonNullable<PredicateSemantics['subjectOperands']>[number]>();
	let opaque = false;
	for (const value of values) {
		if (value === undefined) continue;
		for (const dependency of value.dependencies) dependencies.add(dependency);
		for (const path of value.reversePaths)
			reverse.set(
				`${path.collection}:${path.segments.map(({ segment }) => segment).join(':')}`,
				path
			);
		for (const requirement of value.indexRequirements)
			indexes.set(`${requirement.collection}.${requirement.field}`, requirement);
		for (const route of value.routing) routing.set(route.field, route);
		for (const field of value.fields)
			fields.set(`${field.collection}.${field.field}.${field.purpose}`, field);
		for (const operand of value.subjectOperands ?? []) subjectOperands.add(operand);
		opaque ||= value.opaque;
	}
	return {
		dependencies: [...dependencies].toSorted(),
		reversePaths: [...reverse.values()],
		indexRequirements: [...indexes.values()].toSorted((left, right) =>
			`${left.collection}.${left.field}`.localeCompare(`${right.collection}.${right.field}`)
		),
		routing: [...routing.values()].toSorted((left, right) => left.field.localeCompare(right.field)),
		fields: [...fields.values()],
		subjectOperands: [...subjectOperands].toSorted(),
		opaque
	};
};

export const compileOrderTerms = (
	definition: WorkspaceDefinition,
	collection: string,
	orderBy: unknown
): ReadonlyArray<OrderTerm> => {
	const terms: Array<OrderTerm> = [];
	if (isObject(orderBy)) {
		for (const [column, direction] of Object.entries(orderBy)) {
			if (!isField(definition, collection, column)) continue;
			if (fieldsOf(definition, collection)?.[column]?.reference !== undefined) continue;
			if (direction === 'asc' || direction === 'desc') terms.push({ column, direction });
		}
	}
	return terms.some(({ column }) => column === 'id')
		? terms
		: [...terms, { column: 'id', direction: 'asc' }];
};

export const orderingExpressions = (
	table: unknown,
	terms: ReadonlyArray<OrderTerm>
): ReadonlyArray<SQL> => {
	const columns = getColumns(table as Parameters<typeof getColumns>[0]) as Readonly<
		Record<string, unknown>
	>;
	return terms.flatMap((term) => {
		const selected = columns[term.column];
		if (selected === undefined) return [];
		return [term.direction === 'asc' ? asc(selected as never) : desc(selected as never)];
	});
};

const normalizedOrder = (
	definition: WorkspaceDefinition,
	collection: string,
	orderBy: unknown
): ReadonlyArray<Readonly<{ readonly field: string; readonly direction: 'asc' | 'desc' }>> =>
	compileOrderTerms(definition, collection, orderBy).map(({ column, direction }) => ({
		field: column,
		direction
	}));

const selectedFields = (
	definition: WorkspaceDefinition,
	collection: string,
	columns: unknown
): ReadonlyArray<string> => {
	const available = [
		...SYSTEM_COLUMN_NAMES,
		...Object.keys(fieldsOf(definition, collection) ?? {})
	];
	if (!isObject(columns)) return available;
	const selection: Record<string, boolean> = {};
	for (const [field, selected] of Object.entries(columns))
		if (isBoolean(selected)) selection[field] = selected;
	return selectedColumnNames(available, selection);
};

type ProjectionResult = Readonly<{
	readonly projection: EffectiveProjection;
	readonly semantics: PredicateSemantics;
	readonly fields: ReadonlyArray<EffectiveFieldRequirement>;
	/** The authored `columns` and `with`, widened to carry the fields a live prefix is keyed by. */
	readonly execution: Readonly<{ readonly columns?: unknown; readonly with?: unknown }>;
}>;

/**
 * The caller's column selection, widened to carry `carried`.
 *
 * A live prefix is keyed by its ordering fields and the implicit `id` tie-breaker: the engine reads
 * them off every admitted row to place it, and the browser replica addresses rows by them. A caller
 * narrowing `columns` to what its view renders knows nothing of that, and the engine used to answer
 * the omission with a refusal — "Live projection must include ordering field leave_types.id" — for a
 * `with: { leave_request_type: { columns: { code: true, name: true } } }` that is exactly how a
 * template author writes a lookup. The sentence never reached anyone: the sync host reported the
 * status alone, the client treated the 500 as a transport blip and retried it forever, and a whole
 * page sat on its spinner. Carrying the keys is what the caller meant; refusing taught nothing.
 *
 * An inclusion list gains the carried fields; an exclusion list stops excluding them, and an
 * exclusion list left empty by that is no selection at all.
 */
const carryingSelection = (columns: unknown, carried: ReadonlyArray<string>): unknown => {
	if (carried.length === 0 || !isObject(columns)) return columns;
	const entries = Object.entries(columns);
	if (entries.some(([, enabled]) => enabled === true))
		return { ...columns, ...Object.fromEntries(carried.map((field) => [field, true])) };
	const kept = entries.filter(([field]) => !carried.includes(field));
	return kept.length === 0 ? undefined : Object.fromEntries(kept);
};

const IMPLICIT_READ_MASK_FIELDS = ['id', 'row_version'] as const;
const effectiveReadMask = (
	fields: ReadonlyArray<string> | undefined
): ReadonlyArray<string> | undefined =>
	fields === undefined ? undefined : [...new Set([...fields, ...IMPLICIT_READ_MASK_FIELDS])];

const joinSemantics = (
	collection: string,
	sourceField: string,
	target: string,
	targetField: string,
	chain: ReadonlyArray<ForwardSegment>
): PredicateSemantics => ({
	dependencies: [target],
	reversePaths: [{ collection: target, segments: reverseSegments(chain) }],
	indexRequirements: [
		...(sourceField === 'id'
			? []
			: [{ collection, field: sourceField, reason: 'relationship' as const }]),
		...(targetField === 'id'
			? []
			: [{ collection: target, field: targetField, reason: 'relationship' as const }])
	],
	routing: [],
	fields: [
		{ collection, field: sourceField, purpose: 'join' },
		{ collection: target, field: targetField, purpose: 'join' }
	],
	opaque: false
});

const projectionPlan = (
	definition: WorkspaceDefinition,
	collection: string,
	withClause: unknown,
	columns: unknown,
	orderBy: unknown,
	levelLimit: number,
	enforceLive: boolean,
	policyFor: ((collection: string) => RowPredicate) | undefined,
	depth: number,
	node: string,
	chain: ReadonlyArray<ForwardSegment>
): PlanResult<ProjectionResult> => {
	const policy = policyFor?.(collection);
	if (columns !== undefined && !isObject(columns))
		return diagnostic(
			'invalid-node',
			`${node}.columns`,
			`Projection node ${node}.columns must be an object.`
		);
	if (isObject(columns)) {
		for (const [field, selected] of Object.entries(columns)) {
			if (!isField(definition, collection, field))
				return diagnostic(
					'unknown-field',
					`${node}.columns.${field}`,
					`Projection node ${node}.columns.${field} is not a field of ${collection}.`
				);
			if (!isBoolean(selected))
				return diagnostic(
					'invalid-node',
					`${node}.columns.${field}`,
					`Projection node ${node}.columns.${field} must be boolean.`
				);
		}
	}
	if (orderBy !== undefined && !isObject(orderBy))
		return diagnostic(
			'invalid-node',
			`${node}.orderBy`,
			`Ordering node ${node}.orderBy must be an object.`
		);
	if (isObject(orderBy)) {
		for (const [field, direction] of Object.entries(orderBy)) {
			if (!isField(definition, collection, field))
				return diagnostic(
					'unknown-field',
					`${node}.orderBy.${field}`,
					`Ordering node ${node}.orderBy.${field} is not a field of ${collection}.`
				);
			if (direction !== 'asc' && direction !== 'desc')
				return diagnostic(
					'invalid-node',
					`${node}.orderBy.${field}`,
					`Ordering node ${node}.orderBy.${field} must be asc or desc.`
				);
		}
	}
	const authored = selectedFields(definition, collection, columns);
	const order = normalizedOrder(definition, collection, orderBy);
	const readMask = effectiveReadMask(policy?.fields);
	// A live prefix is keyed by its ordering values, and a key is a scalar: the cursor that continues
	// the prefix binds each value back into SQL, and a JSON object has no total order the engine can
	// bind. Ordering a live query by a range or any other custom type used to pass planning, load its
	// rows, and then fail at the first row with a 502 the client retried forever — the loans page,
	// ordered by `effective_range`, sat on "Reconnecting to live updates" with no sentence anywhere.
	// Refusing here names the field, and a refusal is terminal for the client, so the page shows it.
	if (enforceLive) {
		const compound = order.find(({ field }) => fieldsOf(definition, collection)?.[field]?.type === 'json');
		if (compound !== undefined) {
			const declared = fieldsOf(definition, collection)?.[compound.field]?.customType ?? 'json';
			return diagnostic(
				'unsupported-live-shape',
				`${node}.orderBy.${compound.field}`,
				`Live ordering requires a scalar field: ${collection}.${compound.field} is ${declared}, which cannot key a live prefix. Order by a scalar column, such as one generated from it.`
			);
		}
	}
	const carried = enforceLive
		? order.map(({ field }) => field).filter((field) => !authored.includes(field))
		: [];
	const selected = [...authored, ...carried];
	const ownFields =
		readMask === undefined ? selected : selected.filter((field) => readMask.includes(field));
	const fieldRequirements: Array<EffectiveFieldRequirement> = [
		...ownFields.map((field) => ({ collection, field, purpose: 'projection' as const })),
		...(readMask ?? []).map((field) => ({ collection, field, purpose: 'field-mask' as const })),
		...order.map(({ field }) => ({ collection, field, purpose: 'order' as const }))
	];
	const semantics: Array<PredicateSemantics | undefined> = [
		rebaseSemantics(policy?.semantics, collection, chain)
	];
	const children: Array<EffectiveProjection> = [];
	const carriedWith: Record<string, unknown> = {};
	if (withClause !== undefined) {
		if (!isObject(withClause))
			return diagnostic('invalid-node', node, `Projection node ${node} must be an object.`);
		for (const name of requestedRelations(withClause)) {
			const authored = relationSpec(withClause, name);
			const childNode = `${node}.with.${name}`;
			if (depth >= MAX_COLLECTION_PREDICATE_DEPTH)
				return diagnostic(
					'max-depth',
					childNode,
					`Projection node ${childNode} exceeds the maximum depth.`
				);
			const resolved = resolveCompiledRelationship(
				definition.relations,
				collection,
				name,
				childNode
			);
			if (Result.isFailure(resolved)) return failed(resolved);
			const relation = resolved.success;
			const segment: ForwardSegment = {
				relationship: relation.identity,
				segment: relation.segment,
				sourceCollection: collection,
				sourceField: relation.sourceField,
				targetCollection: relation.definition.target,
				targetField: relation.targetField
			};
			const nextChain = [...chain, segment];
			const childSpec = authored === true ? undefined : authored;
			if (enforceLive && isObject(childSpec) && childSpec['offset'] !== undefined)
				return diagnostic(
					'unsupported-live-shape',
					`${childNode}.offset`,
					`Live projection ${childNode} cannot use offset pagination.`,
					relation.identity
				);
			const limit = isObject(childSpec) ? childSpec['limit'] : undefined;
			if (
				enforceLive &&
				limit !== undefined &&
				(!isNumber(limit) ||
					!Number.isInteger(limit) ||
					limit < 1 ||
					limit > MAX_SYNC_LOADED_KEYS)
			)
				return diagnostic(
					'unsupported-live-shape',
					`${childNode}.limit`,
					`Live projection ${childNode} requires a limit from 1 to ${MAX_SYNC_LOADED_KEYS}.`,
					relation.identity
				);
			const nestedWhere = isObject(childSpec) ? childSpec['where'] : undefined;
			if (nestedWhere !== undefined) {
				const compiled = compileStructuredPredicate({
					definition,
					rootCollection: relation.definition.target,
					where: nestedWhere,
					node: `${childNode}.where`
				});
				if (Result.isFailure(compiled)) return failed(compiled);
				semantics.push(
					rebaseSemantics(compiled.success.semantics, relation.definition.target, nextChain)
				);
			}
			const nested = projectionPlan(
				definition,
				relation.definition.target,
				isObject(childSpec) ? childSpec['with'] : undefined,
				isObject(childSpec) ? childSpec['columns'] : undefined,
				isObject(childSpec) ? childSpec['orderBy'] : undefined,
				isNumber(limit) ? limit : DEFAULT_LIVE_PREFIX,
				enforceLive,
				policyFor,
				depth + 1,
				childNode,
				nextChain
			);
			if (Result.isFailure(nested)) return failed(nested);
			children.push({ ...nested.success.projection, relationship: relation.identity });
			carriedWith[name] = isObject(childSpec)
				? {
						...childSpec,
						...(nested.success.execution.columns === undefined
							? {}
							: { columns: nested.success.execution.columns }),
						...(nested.success.execution.with === undefined
							? {}
							: { with: nested.success.execution.with })
					}
				: authored;
			semantics.push(
				nested.success.semantics,
				joinSemantics(
					collection,
					relation.sourceField,
					relation.definition.target,
					relation.targetField,
					nextChain
				)
			);
			fieldRequirements.push(...nested.success.fields);
		}
	}
	const executedColumns = carryingSelection(columns, carried);
	return Result.succeed({
		projection: { collection, fields: ownFields, order, limit: levelLimit, children },
		semantics: mergePredicateSemantics(semantics),
		fields: fieldRequirements,
		execution: {
			...(executedColumns === undefined ? {} : { columns: executedColumns }),
			...(isObject(withClause) ? { with: carriedWith } : {})
		}
	});
};

type EffectiveQueryPlanInput = Readonly<{
	readonly definition: WorkspaceDefinition;
	readonly rootCollection: string;
	readonly where?: unknown;
	readonly userFilter?: unknown;
	readonly orderBy?: unknown;
	readonly with?: unknown;
	readonly columns?: unknown;
	readonly limit?: number;
	readonly after?: string;
	readonly search?: Readonly<{ readonly mode?: unknown }>;
	readonly kind: 'findMany' | 'findFirst' | 'count' | 'findGrouped';
	readonly subject: Subject;
	readonly policyFor: (collection: string) => RowPredicate;
	readonly qualifier?: string;
	readonly indexAdmission?: Readonly<{
		readonly enforce: true;
		readonly available: ReadonlySet<string>;
	}>;
}>;

const projectedPolicyCollections = (projection: EffectiveProjection): ReadonlyArray<string> => [
	projection.collection,
	...projection.children.flatMap(projectedPolicyCollections)
];

export const compileEffectiveQueryPlan = (
	input: EffectiveQueryPlanInput
): PlanResult<EffectiveQueryPlan> => {
	const query = compileStructuredPredicate({
		definition: input.definition,
		rootCollection: input.rootCollection,
		where: input.where,
		policyFor: input.policyFor,
		...(input.qualifier === undefined ? {} : { qualifier: input.qualifier }),
		node: 'query.where'
	});
	if (Result.isFailure(query)) return failed(query);
	const userFilter = compileStructuredPredicate({
		definition: input.definition,
		rootCollection: input.rootCollection,
		where: input.userFilter,
		policyFor: input.policyFor,
		...(input.qualifier === undefined ? {} : { qualifier: input.qualifier }),
		node: 'query.userFilter'
	});
	if (Result.isFailure(userFilter)) return failed(userFilter);
	const mode: EffectivePlanMode =
		input.kind === 'count' ||
		input.kind === 'findGrouped' ||
		input.after !== undefined ||
		input.search?.mode === 'semantic'
			? 'one-shot'
			: 'live-prefix';
	const requestedLimit = input.kind === 'findFirst' ? 1 : (input.limit ?? DEFAULT_LIVE_PREFIX);
	if (
		mode === 'live-prefix' &&
		(!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_SYNC_LOADED_KEYS)
	)
		return diagnostic(
			'unsupported-live-shape',
			'query.limit',
			`Live queries require a contiguous prefix limit from 1 to ${MAX_SYNC_LOADED_KEYS}.`
		);
	const rootPolicy = input.policyFor(input.rootCollection);
	const projection = projectionPlan(
		input.definition,
		input.rootCollection,
		input.with,
		input.columns,
		input.orderBy,
		requestedLimit,
		mode === 'live-prefix',
		input.policyFor,
		0,
		'query',
		[]
	);
	if (Result.isFailure(projection)) return failed(projection);
	const order = normalizedOrder(input.definition, input.rootCollection, input.orderBy);
	const oneShotReason =
		input.kind === 'count' || input.kind === 'findGrouped'
			? `${input.kind} is an aggregate one-shot read`
			: input.after !== undefined
				? 'an anchored cursor page is one-shot'
				: input.search?.mode === 'semantic'
					? 'vector-nearest ordering is one-shot'
					: undefined;
	const semantics = mergePredicateSemantics([
		query.success.semantics,
		userFilter.success.semantics,
		rootPolicy.semantics,
		projection.success.semantics
	]);
	if (mode === 'live-prefix') {
		if (semantics.opaque)
			return diagnostic(
				'unsupported-live-shape',
				'policy.where',
				'An effective live plan cannot contain an opaque policy predicate.'
			);
		const indexAdmission = input.indexAdmission;
		if (indexAdmission?.enforce === true) {
			const missing = semantics.indexRequirements.find(
				(requirement) =>
					requirement.field !== 'id' &&
					!indexAdmission.available.has(`${requirement.collection}.${requirement.field}`)
			);
			if (missing !== undefined)
				return diagnostic(
					'missing-index',
					`index.${missing.collection}.${missing.field}`,
					`Live plan requires an installed index on ${missing.collection}.${missing.field} before enforced admission.`
				);
		}
	}
	const fields: Array<EffectiveFieldRequirement> = [
		...semantics.fields,
		...projection.success.fields,
		...order.map(({ field }) => ({
			collection: input.rootCollection,
			field,
			purpose: 'order' as const
		}))
	];
	const mask = effectiveReadMask(rootPolicy.fields);
	if (mode === 'live-prefix' && mask !== undefined) {
		for (const field of mask)
			fields.push({ collection: input.rootCollection, field, purpose: 'field-mask' });
	}
	const authorityCollections = [
		...new Set([
			input.rootCollection,
			...query.success.semantics.reversePaths.map(({ collection }) => collection),
			...userFilter.success.semantics.reversePaths.map(({ collection }) => collection),
			...projectedPolicyCollections(projection.success.projection)
		])
	].toSorted();
	const authoritySource = authorityCollections.map((collection) =>
		policyHashSource('read', collection, input.policyFor(collection))
	);
	const authority: EffectiveAuthorityPlan = {
		collections: authorityCollections,
		subjectOperands: [...new Set(semantics.subjectOperands ?? [])].toSorted(),
		source: authoritySource,
		fingerprint: fingerprint(authoritySource)
	};
	const execution: EffectiveQueryExecution = {
		collection: input.rootCollection,
		kind: input.kind,
		...(input.where === undefined ? {} : { where: input.where }),
		...(input.userFilter === undefined ? {} : { userFilter: input.userFilter }),
		...(input.orderBy === undefined ? {} : { orderBy: input.orderBy }),
		...projection.success.execution,
		limit: requestedLimit,
		...(input.after === undefined ? {} : { after: input.after }),
		...(input.search === undefined ? {} : { search: input.search })
	};
	const dependencies = mode === 'one-shot' ? [] : semantics.dependencies;
	const reversePaths = mode === 'one-shot' ? [] : semantics.reversePaths;
	const indexRequirements = mode === 'one-shot' ? [] : semantics.indexRequirements;
	const routing = mode === 'one-shot' ? [] : semantics.routing;
	const schemaFingerprint = input.definition.schemaFingerprint ?? null;
	return Result.succeed({
		mode,
		rootCollection: input.rootCollection,
		schemaFingerprint,
		sql: predicateExpression(
			{
				...rootPolicy,
				expression: {
					kind: 'and',
					expressions: [
						query.success.expression,
						userFilter.success.expression,
						rootPolicy.expression
					]
				}
			},
			input.qualifier === undefined ? undefined : { qualifier: input.qualifier }
		),
		dependencies,
		reversePaths,
		indexRequirements,
		routing,
		authority,
		execution,
		fingerprint: fingerprint({
			schemaFingerprint,
			execution,
			authority: authority.fingerprint,
			mode,
			dependencies,
			reversePaths,
			indexRequirements,
			routing,
			order,
			projection: projection.success.projection,
			fields,
			limit: requestedLimit
		}),
		order,
		projection: projection.success.projection,
		fields,
		limit: requestedLimit,
		...(oneShotReason === undefined ? {} : { oneShotReason })
	});
};

export const policyIndexRequirements = (
	definition: WorkspaceDefinition
): ReadonlyArray<CollectionIndexRequirement> => {
	const requirements = new Map<string, CollectionIndexRequirement>();
	const add = (requirement: CollectionIndexRequirement): void => {
		requirements.set(`${requirement.collection}.${requirement.field}`, requirement);
	};
	for (const relation of definition.relations) {
		for (const endpoint of [relation.from, relation.to]) {
			if (endpoint === undefined || endpoint.column === 'id') continue;
			add({ collection: endpoint.collection, field: endpoint.column, reason: 'relationship' });
		}
	}
	const subject: Subject = {
		userId: 'effective-plan-index-inspection',
		tenantId: 'effective-plan-index-inspection',
		teamPath: ['effective-plan-index-inspection'],
		policies: [],
		email: 'effective-plan-index-inspection@example.invalid',
		admin: false
	};
	for (const policy of definition.policies) {
		for (const grant of policy.grants ?? []) {
			if ((grant.action !== 'read' && grant.action !== 'history') || grant.where === undefined)
				continue;
			const compiled = compileStructuredPredicate({
				definition,
				rootCollection: grant.collection,
				where: grant.where,
				subject,
				node: `policy.${policy.name}.${grant.collection}.${grant.action}`
			});
			if (Result.isFailure(compiled)) throw compiled.failure;
			for (const requirement of compiled.success.semantics.indexRequirements) add(requirement);
		}
	}
	return [...requirements.values()].toSorted((left, right) =>
		`${left.collection}.${left.field}`.localeCompare(`${right.collection}.${right.field}`)
	);
};
