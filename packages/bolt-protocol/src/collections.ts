import { Option, Schema } from 'effect';

export const CollectionWriteValues = Schema.Record(Schema.String, Schema.Json).annotate({
	identifier: 'BoltCollectionWriteValues'
});
export type CollectionWriteValues = typeof CollectionWriteValues.Type;

export const CollectionMutationIdempotencyKey = Schema.NonEmptyString.check(
	Schema.isMaxLength(256),
	Schema.makeFilter((value: string) => !value.includes('\u0000') || 'must not contain a NUL byte')
).pipe(Schema.brand('BoltCollectionMutationIdempotencyKey'));
export type CollectionMutationIdempotencyKey = typeof CollectionMutationIdempotencyKey.Type;

export const CollectionBaseRowVersion = Schema.Number.check(
	Schema.isInt(),
	Schema.isGreaterThanOrEqualTo(1)
);
export type CollectionBaseRowVersion = typeof CollectionBaseRowVersion.Type;

export const COLLECTION_MUTATION_RETRY_HORIZON_MILLIS = 24 * 60 * 60 * 1000;
export const COLLECTION_MUTATION_QUARANTINE_RETENTION_MILLIS = 14 * 24 * 60 * 60 * 1000;

export const CollectionMutationBaseVersion = Schema.Struct({
	row: Schema.Struct({
		collection: Schema.NonEmptyString,
		recordId: Schema.NonEmptyString
	}),
	rowVersion: Schema.NullOr(CollectionBaseRowVersion)
}).annotate({ identifier: 'BoltCollectionMutationBaseVersion' });
export type CollectionMutationBaseVersion = typeof CollectionMutationBaseVersion.Type;

const CollectionMutationRetryIdentity = {
	idempotencyKey: CollectionMutationIdempotencyKey,
	issuedAtEpochMs: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isFinite())
};

const CollectionMutationDeleteIds = Schema.NonEmptyArray(Schema.NonEmptyString).check(
	Schema.makeFilter(
		(ids: readonly string[]) => new Set(ids).size === ids.length || 'delete ids must be unique'
	)
);

export const CollectionMutationGraph = Schema.Union([
	Schema.Struct({
		action: Schema.Literal('create'),
		collection: Schema.NonEmptyString,
		values: CollectionWriteValues
	}),
	Schema.Struct({
		action: Schema.Literal('update'),
		collection: Schema.NonEmptyString,
		values: CollectionWriteValues
	}),
	Schema.Struct({
		action: Schema.Literal('delete'),
		collection: Schema.NonEmptyString,
		ids: CollectionMutationDeleteIds
	})
]).annotate({ identifier: 'BoltCollectionMutationGraph' });
export type CollectionMutationGraph = typeof CollectionMutationGraph.Type;

/** The record ids a delete graph names. Delete is a batch, like mutate's payload array. */
export const mutationGraphDeleteIds = (
	graph: Extract<CollectionMutationGraph, { readonly action: 'delete' }>
): readonly string[] => graph.ids;

export const CollectionMutationPush = Schema.Struct({
	protocolVersion: Schema.Literal(2),
	...CollectionMutationRetryIdentity,
	partitionKey: Schema.NonEmptyString,
	schemaFingerprint: Schema.NonEmptyString,
	graph: CollectionMutationGraph,
	baseVersions: Schema.Array(CollectionMutationBaseVersion)
}).annotate({ identifier: 'BoltCollectionMutationPush' });
export type CollectionMutationPush = typeof CollectionMutationPush.Type;

export const CollectionMutateRequest = CollectionMutationPush.annotate({
	identifier: 'BoltCollectionMutateRequest'
});
export type CollectionMutateRequest = typeof CollectionMutateRequest.Type;

export const StoredRecord = Schema.Record(Schema.String, Schema.Json).annotate({
	identifier: 'BoltStoredRecord'
});
export type StoredRecord = typeof StoredRecord.Type;

export const CollectionLexicalSearch = Schema.Struct({
	mode: Schema.Literal('lexical'),
	term: Schema.NonEmptyString
}).annotate({ identifier: 'BoltCollectionLexicalSearch' });
export interface CollectionLexicalSearch extends Schema.Schema.Type<
	typeof CollectionLexicalSearch
> {}

export const CollectionSemanticSearch = Schema.Struct({
	mode: Schema.Literal('semantic'),
	term: Schema.NonEmptyString
}).annotate({ identifier: 'BoltCollectionSemanticSearch' });
export interface CollectionSemanticSearch extends Schema.Schema.Type<
	typeof CollectionSemanticSearch
> {}

export const CollectionSearch = Schema.Union([
	CollectionLexicalSearch,
	CollectionSemanticSearch
]).annotate({
	identifier: 'BoltCollectionSearch'
});
export type CollectionSearch = typeof CollectionSearch.Type;

export const COLLECTION_PREDICATE_SUBJECTS = [
	'id',
	'email',
	'team',
	'teamIds',
	'tenantId',
	'admin'
] as const;
export const CollectionPredicateSubject = Schema.Literals(COLLECTION_PREDICATE_SUBJECTS).annotate({
	identifier: 'BoltCollectionPredicateSubject'
});
export type CollectionPredicateSubject = typeof CollectionPredicateSubject.Type;

export const CollectionSubjectOperand = Schema.Struct({
	$subject: CollectionPredicateSubject
}).annotate({
	identifier: 'BoltCollectionSubjectOperand'
});
export interface CollectionSubjectOperand extends Schema.Schema.Type<
	typeof CollectionSubjectOperand
> {}

export const COLLECTION_PREDICATE_FIELD_OPERATORS = [
	'eq',
	'ne',
	'gt',
	'gte',
	'lt',
	'lte',
	'in',
	'notIn',
	'like',
	'ilike',
	'notLike',
	'notIlike',
	'caseFoldEq',
	'caseFoldIn',
	'contains',
	'arrayContains',
	'arrayContained',
	'arrayOverlaps',
	'isNull',
	'isNotNull',
	'contains_date',
	'overlaps',
	'jsonPath',
	'jsonArraySome',
	'kind',
	'approvalParty'
] as const;
export const COLLECTION_PREDICATE_RELATION_QUANTIFIERS = ['some', 'none', 'every'] as const;
export const MAX_COLLECTION_PREDICATE_DEPTH = 4;

const FIELD_OPERATORS = new Set<string>(COLLECTION_PREDICATE_FIELD_OPERATORS);
const RELATION_QUANTIFIERS = new Set<string>(COLLECTION_PREDICATE_RELATION_QUANTIFIERS);
const JSON_PATH_TYPES = new Set(['string', 'number', 'boolean', 'instant', 'json']);
const JSON_PATH_KEYS = new Set([
	'path',
	'type',
	'transform',
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
]);

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const TeamIdsOperand = Schema.Struct({ $subject: Schema.Literal('teamIds') });

const jsonObject = (value: unknown): typeof JsonObject.Type | undefined => {
	const decoded = Schema.decodeUnknownOption(JsonObject)(value);
	return Option.isSome(decoded) ? decoded.value : undefined;
};

const isSubjectOperand = Schema.is(CollectionSubjectOperand);
const isTeamIdsOperand = Schema.is(TeamIdsOperand);

const operandProblem = (value: unknown): string | undefined => {
	if (isSubjectOperand(value)) return undefined;
	return Schema.is(Schema.Json)(value) ? undefined : 'contains a non-JSON predicate operand';
};

const scalarOperandProblem = (value: unknown): string | undefined =>
	isTeamIdsOperand(value)
		? 'uses set-valued subject.teamIds with a scalar operator'
		: operandProblem(value);

const setOperandProblem = (value: unknown): string | undefined => {
	if (isTeamIdsOperand(value)) return undefined;
	if (!Array.isArray(value)) return 'requires an array or subject.teamIds';
	for (const member of value) {
		const problem = scalarOperandProblem(member);
		if (problem !== undefined) return problem;
	}
	return undefined;
};

const unexpectedKey = (
	value: Readonly<Record<string, unknown>>,
	allowed: ReadonlySet<string>
): string | undefined => Object.keys(value).find((key) => !allowed.has(key));

const exclusiveOperator = (
	value: Readonly<Record<string, unknown>>,
	reserved: ReadonlyArray<string>
): string | undefined => {
	const operators = Object.keys(value).filter((key) => !reserved.includes(key));
	return operators.length === 1 ? operators[0] : undefined;
};

const pathSegmentsProblem = (path: unknown, requireNonEmpty: boolean): string | undefined => {
	if (path === undefined && !requireNonEmpty) return undefined;
	if (!Array.isArray(path) || (requireNonEmpty && path.length === 0))
		return 'must be a non-empty array of path segments';
	return path.some((part) => typeof part !== 'string' || part.length === 0)
		? 'must be a non-empty array of path segments'
		: undefined;
};

const jsonPathProblem = (value: unknown): string | undefined => {
	const object = jsonObject(value);
	if (object === undefined) return 'jsonPath must be an object';
	const unexpected = unexpectedKey(object, JSON_PATH_KEYS);
	if (unexpected !== undefined) return `jsonPath has unsupported ${unexpected}`;
	const pathProblem = pathSegmentsProblem(object['path'], true);
	if (pathProblem !== undefined) return `jsonPath.path ${pathProblem}`;
	if (!JSON_PATH_TYPES.has(object['type'] as string)) return 'jsonPath.type is unsupported';
	if (object['transform'] !== undefined && object['transform'] !== 'case-fold')
		return 'jsonPath.transform is unsupported';
	const operator = exclusiveOperator(object, ['path', 'type', 'transform']);
	if (operator === undefined) return 'jsonPath requires exactly one comparison';
	if (operator === 'isNull' || operator === 'isNotNull')
		return typeof object[operator] === 'boolean' ? undefined : `${operator} requires a boolean`;
	return operator === 'in' || operator === 'notIn'
		? setOperandProblem(object[operator])
		: scalarOperandProblem(object[operator]);
};

const jsonArraySomeProblem = (value: unknown): string | undefined => {
	const object = jsonObject(value);
	if (object === undefined) return 'jsonArraySome must be an object';
	const unexpected = unexpectedKey(object, new Set(['path', 'transform', 'eq', 'in']));
	if (unexpected !== undefined) return `jsonArraySome has unsupported ${unexpected}`;
	if (object['path'] !== undefined) {
		const pathProblem = pathSegmentsProblem(object['path'], false);
		if (pathProblem !== undefined) return `jsonArraySome.path ${pathProblem}`;
	}
	if (object['transform'] !== undefined && object['transform'] !== 'case-fold')
		return 'jsonArraySome.transform is unsupported';
	const operator = exclusiveOperator(object, ['path', 'transform']);
	if (operator === undefined) return 'jsonArraySome requires exactly one of eq or in';
	return operator === 'in'
		? setOperandProblem(object[operator])
		: scalarOperandProblem(object[operator]);
};

const fieldPredicateProblem = (value: unknown): string | undefined => {
	if (isSubjectOperand(value)) return scalarOperandProblem(value);
	const object = jsonObject(value);
	if (object === undefined) return operandProblem(value);
	const entries = Object.entries(object);
	if (entries.length === 0) return 'a field condition must name an operator';
	for (const [operator, operand] of entries) {
		if (!FIELD_OPERATORS.has(operator)) return `has unsupported operator ${operator}`;
		if (operator === 'jsonPath') {
			const problem = jsonPathProblem(operand);
			if (problem !== undefined) return problem;
			continue;
		}
		if (operator === 'jsonArraySome') {
			const problem = jsonArraySomeProblem(operand);
			if (problem !== undefined) return problem;
			continue;
		}
		if (operator === 'approvalParty') {
			if (operand !== true) return 'approvalParty accepts only true';
			continue;
		}
		if (operator === 'isNull' || operator === 'isNotNull') {
			if (typeof operand !== 'boolean') return `${operator} requires a boolean`;
			continue;
		}
		if (operator === 'in' || operator === 'notIn' || operator === 'caseFoldIn') {
			const problem = setOperandProblem(operand);
			if (problem !== undefined) return problem;
			continue;
		}
		if (operator === 'kind') {
			const kind = jsonObject(operand);
			if (kind === undefined) return 'kind must be an object';
			const kindEntries = Object.entries(kind);
			if (
				kindEntries.length !== 1 ||
				(kindEntries[0]?.[0] !== 'eq' && kindEntries[0]?.[0] !== 'ne') ||
				typeof kindEntries[0]?.[1] !== 'string'
			)
				return 'kind requires exactly eq or ne with a string discriminator';
			continue;
		}
		const problem = scalarOperandProblem(operand);
		if (problem !== undefined) return problem;
	}
	return undefined;
};

const predicateProblem = (value: unknown, depth = 0): string | undefined => {
	const object = jsonObject(value);
	if (object === undefined) return 'a predicate must be an object';
	if (depth > MAX_COLLECTION_PREDICATE_DEPTH) return 'predicate nesting exceeds the maximum depth';
	for (const [node, condition] of Object.entries(object)) {
		if (node === 'AND' || node === 'OR') {
			if (!Array.isArray(condition)) return `${node} must be an array`;
			for (const branch of condition) {
				const problem = predicateProblem(branch, depth);
				if (problem !== undefined) return `${node} ${problem}`;
			}
			continue;
		}
		if (node === 'NOT') {
			const problem = predicateProblem(condition, depth);
			if (problem !== undefined) return `NOT ${problem}`;
			continue;
		}
		const relation = jsonObject(condition);
		if (relation !== undefined) {
			const quantifiers = Object.keys(relation).filter((key) => RELATION_QUANTIFIERS.has(key));
			if (quantifiers.length > 0) {
				if (quantifiers.length !== 1 || Object.keys(relation).length !== 1)
					return `${node} relation requires exactly one quantifier`;
				const problem = predicateProblem(relation[quantifiers[0] ?? ''], depth + 1);
				if (problem !== undefined) return `${node}.${quantifiers[0]} ${problem}`;
				continue;
			}
		}
		const problem = fieldPredicateProblem(condition);
		if (problem !== undefined) return `${node} ${problem}`;
	}
	return undefined;
};

export const CollectionPredicate = Schema.Json.check(
	Schema.makeFilter((value) => predicateProblem(value))
).annotate({
	identifier: 'BoltCollectionPredicate'
});
export type CollectionPredicate = typeof CollectionPredicate.Type;

export const CollectionRelationshipSegment = Schema.Struct({
	relationship: Schema.NonEmptyString,
	segment: Schema.NonEmptyString,
	fromCollection: Schema.NonEmptyString,
	fromField: Schema.NonEmptyString,
	toCollection: Schema.NonEmptyString,
	toField: Schema.NonEmptyString
}).annotate({ identifier: 'BoltCollectionRelationshipSegment' });
export interface CollectionRelationshipSegment extends Schema.Schema.Type<
	typeof CollectionRelationshipSegment
> {}

export const CollectionReversePath = Schema.Struct({
	collection: Schema.NonEmptyString,
	segments: Schema.Array(CollectionRelationshipSegment)
}).annotate({ identifier: 'BoltCollectionReversePath' });
export interface CollectionReversePath extends Schema.Schema.Type<typeof CollectionReversePath> {}

export const CollectionIndexRequirement = Schema.Struct({
	collection: Schema.NonEmptyString,
	field: Schema.NonEmptyString,
	reason: Schema.Literals(['relationship', 'routing'])
}).annotate({ identifier: 'BoltCollectionIndexRequirement' });
export interface CollectionIndexRequirement extends Schema.Schema.Type<
	typeof CollectionIndexRequirement
> {}

export const CollectionQueryRequestFields = {
	collection: Schema.NonEmptyString,
	where: Schema.optionalKey(CollectionPredicate),
	userFilter: Schema.optionalKey(CollectionPredicate),
	search: Schema.optionalKey(CollectionSearch),
	with: Schema.optionalKey(Schema.Json),
	orderBy: Schema.optionalKey(Schema.Json),
	limit: Schema.optionalKey(Schema.Number),
	after: Schema.optionalKey(Schema.String),
	columns: Schema.optionalKey(Schema.Json)
};
export const CollectionQueryRequest = Schema.Struct(CollectionQueryRequestFields).annotate({
	identifier: 'BoltCollectionQueryRequest'
});
export interface CollectionQueryRequest extends Schema.Schema.Type<typeof CollectionQueryRequest> {}

/** One answered-only keyset page. Live prefixes use sync; a deep `after` stays this one-shot. */
export const CollectionAnchoredPage = Schema.Struct({
	rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
	nextCursor: Schema.NullOr(Schema.String)
}).annotate({ identifier: 'BoltCollectionAnchoredPage' });
export interface CollectionAnchoredPage extends Schema.Schema.Type<typeof CollectionAnchoredPage> {}

const {
	limit: _limit,
	after: _after,
	...CollectionGroupedQueryBaseFields
} = CollectionQueryRequestFields;

export const CollectionGroup = Schema.Struct({
	by: Schema.NonEmptyString,
	lanes: Schema.optionalKey(Schema.Array(Schema.Json))
}).annotate({ identifier: 'BoltCollectionGroup' });
export interface CollectionGroup extends Schema.Schema.Type<typeof CollectionGroup> {}

export const CollectionGroupedQueryRequestFields = {
	...CollectionGroupedQueryBaseFields,
	group: CollectionGroup
};
export const CollectionGroupedQueryRequest = Schema.Struct(
	CollectionGroupedQueryRequestFields
).annotate({
	identifier: 'BoltCollectionGroupedQueryRequest'
});
export interface CollectionGroupedQueryRequest extends Schema.Schema.Type<
	typeof CollectionGroupedQueryRequest
> {}

export const CollectionMutationSettlement = Schema.Union([
	Schema.Struct({
		resolution: Schema.Literal('accepted'),
		mutationId: CollectionMutationIdempotencyKey,
		schemaFingerprint: Schema.NonEmptyString,
		records: Schema.Array(StoredRecord),
		pendingApproval: Schema.optionalKey(
			Schema.Struct({
				requestId: Schema.NonEmptyString,
				collection: Schema.NonEmptyString,
				id: Schema.NonEmptyString,
				action: Schema.Literals(['create', 'update', 'delete'])
			})
		)
	}),
	Schema.Struct({
		resolution: Schema.Literal('rebased'),
		mutationId: CollectionMutationIdempotencyKey,
		fromSchemaFingerprint: Schema.NonEmptyString,
		toSchemaFingerprint: Schema.NonEmptyString,
		records: Schema.Array(StoredRecord)
	}),
	Schema.Struct({
		resolution: Schema.Literal('rejected'),
		mutationId: CollectionMutationIdempotencyKey,
		code: Schema.Literals(['refused', 'forbidden', 'conflict']),
		message: Schema.NonEmptyString,
		schemaFingerprint: Schema.NonEmptyString
	}),
	Schema.Struct({
		resolution: Schema.Literal('quarantined'),
		mutationId: CollectionMutationIdempotencyKey,
		schemaFingerprint: Schema.NonEmptyString,
		reason: Schema.NonEmptyString
	})
]).annotate({ identifier: 'BoltCollectionMutationSettlement' });
export type CollectionMutationSettlement = typeof CollectionMutationSettlement.Type;
