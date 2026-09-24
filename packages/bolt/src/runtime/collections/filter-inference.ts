import { Effect, Schema } from 'effect';
import {
	CollectionFilterInference,
	EffectId,
	type CollectionFilterInferenceInput,
	type EffectId as EffectIdType
} from '@norbital-ai/bolt-protocol';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import { AI } from '#lib/runtime/facilities/services.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import { inferOp } from '#lib/runtime/inference.js';

/** How many candidate records one lookup answers with; enough to disambiguate, never a page. */
const LOOKUP_LIMIT = 5;
/** Longest text value a lookup row carries back; the model needs a name, not a document. */
const LOOKUP_TEXT = 80;

const FindRecordsInput = Schema.Struct({
	collection: Schema.NonEmptyString,
	search: Schema.NonEmptyString
});

/** A looked-up row reduced to what names it: its id and its short text fields. */
const lookupRow = (row: Readonly<Record<string, unknown>>): Record<string, unknown> =>
	Object.fromEntries(
		Object.entries(row)
			.filter(([key, value]) => key === 'id' || (typeof value === 'string' && value.length <= 400))
			.slice(0, 6)
			.map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, LOOKUP_TEXT) : value])
	);

const fieldLine = (field: CollectionFilterInferenceInput['fields'][number]): string =>
	field.operators.includes('related')
		? [
				`- ${field.value} (${field.label}): related ${field.target ?? 'records'} — operator related, `,
				'value { match: some|none|every|gte|lte|eq, count?: n, where: [conditions on its fields] }; its fields:',
				...(field.fields ?? []).map((nested) => `\n  ${fieldLine(nested)}`)
			].join('')
		: [
				`- ${field.value} (${field.label}): ${field.kind}${field.array === true ? '[]' : ''}`,
				field.nullable ? ' nullable' : '',
				field.values === undefined ? '' : `; values ${field.values.join(' | ')}`,
				field.target === undefined
					? ''
					: `; a ${field.target} record id — resolve names with find_records`,
				`; operators ${field.operators.join(', ')}`
			].join('');

const RELATED_MATCHES = ['some', 'none', 'every', 'gte', 'lte', 'eq'];

/** A `related` answer's value: a match, a count when counting, and conditions on offered fields. */
const relatedProblem = (
	value: unknown,
	field: CollectionFilterInferenceInput['fields'][number]
): string | undefined => {
	if (typeof value !== 'object' || value === null) return 'not an object';
	const match = Reflect.get(value, 'match');
	if (typeof match !== 'string' || !RELATED_MATCHES.includes(match)) return 'unknown match';
	const count = Reflect.get(value, 'count');
	if (['gte', 'lte', 'eq'].includes(match) && (!Number.isInteger(count) || Number(count) < 0))
		return 'count is not a whole number';
	const where = Reflect.get(value, 'where') ?? [];
	if (!Array.isArray(where)) return 'where is not a list';
	const nested = new Map((field.fields ?? []).map((candidate) => [candidate.value, candidate]));
	return where.every(
		(condition: unknown) =>
			typeof condition === 'object' &&
			condition !== null &&
			nested
				.get(String(Reflect.get(condition, 'field')))
				?.operators.includes(String(Reflect.get(condition, 'operator'))) === true
	)
		? undefined
		: 'a condition names a field or operator the related collection does not offer';
};

/**
 * Turns a person's description of what to show into the filter rows their builder holds.
 *
 * One structured inference, run as the caller: the collection must be one they may read, and the
 * only data the model can reach is `find_records`, a search under the caller's own policies, used to
 * turn "Bob's" into Bob's id. The answer is the whole filter — the current rows refined by the
 * request — and every condition names a field and operator the browser offered, so the builder
 * renders it as ordinary editable rows. Phrases that map to nothing come back as `unresolved`
 * rather than as a guessed, silently broad condition.
 */
export const inferCollectionFilter = Effect.fn('Collections.inferFilter')(function* (
	effectId: EffectIdType,
	subject: Identity.Subject,
	input: CollectionFilterInferenceInput,
	today: string
) {
	const access = yield* AccessControl.Service;
	const policy = access.invocation();
	yield* policy.authorize(subject, 'read', input.collection);
	const collections = yield* Collections.Service;
	const ai = yield* AI.Service;
	const { defaultLanguageModelId } = yield* ai.catalog(effectId, { _tag: 'Catalog' });
	const infer = inferOp(EffectId.make(`${effectId}:filter`), ai);
	const offered = new Map(input.fields.map((field) => [field.value, field]));
	const answer = yield* infer({
		schema: CollectionFilterInference as unknown as Schema.Codec<unknown, unknown>,
		model: defaultLanguageModelId,
		system: [
			`You turn a request into filter conditions for the "${input.collection}" collection. Today is ${today}.`,
			'Answer with the complete filter: keep current conditions the request does not change, change or drop the ones it does, add what it asks for.',
			'Use only the fields and operators listed. Operands: a date or instant as an ISO string; a relative period ("this week") as gte/lte bounds; `contains` takes the bare text; isNull/isNotNull take no value; array operators take an array.',
			'A person, site or other record named in words is a record id: call find_records to resolve it, and if several match or none do, leave that phrase unresolved.',
			'A condition on related records ("customers with at least 1 open invoice message") is one related condition on the relationship: its where conditions all hold on the same related record, and gte/lte/eq with count compare how many there are.',
			'Put every phrase you could not map faithfully in unresolved, verbatim. Never widen or guess a condition to cover it.',
			'Fields:',
			...input.fields.map(fieldLine)
		].join('\n'),
		prompt: [`Current conditions: ${JSON.stringify(input.current)}`, `Request: ${input.text}`].join(
			'\n'
		),
		tools: [
			{
				name: 'find_records',
				description:
					"Search a collection by text for the records a name refers to; answers each match's id and naming fields.",
				input: FindRecordsInput as unknown as Schema.Codec<unknown, unknown>,
				run: (raw) =>
					Effect.gen(function* () {
						const lookup = yield* Schema.decodeUnknownEffect(FindRecordsInput)(raw);
						const rows = yield* collections.findMany(effectId, subject, {
							collection: lookup.collection,
							search: lookup.search,
							limit: LOOKUP_LIMIT
						});
						return rows.map(lookupRow);
					})
			}
		]
	});
	const decoded = yield* Schema.decodeUnknownEffect(CollectionFilterInference)(answer);
	// The builder can only render what it offered; anything else is reported, never applied.
	const refused = decoded.conditions.filter((condition) => {
		const field = offered.get(condition.field);
		if (!field?.operators.includes(condition.operator)) return true;
		return condition.operator === 'related' && relatedProblem(condition.value, field) !== undefined;
	});
	return {
		conditions: decoded.conditions.filter((condition) => !refused.includes(condition)),
		unresolved: [
			...decoded.unresolved,
			...refused.map((condition) => `${condition.field} ${condition.operator}`)
		]
	} satisfies CollectionFilterInference;
});
