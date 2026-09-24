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
	[
		`- ${field.value} (${field.label}): ${field.kind}${field.array === true ? '[]' : ''}`,
		field.nullable ? ' nullable' : '',
		field.values === undefined ? '' : `; values ${field.values.join(' | ')}`,
		field.target === undefined
			? ''
			: `; a ${field.target} record id — resolve names with find_records`,
		`; operators ${field.operators.join(', ')}`
	].join('');

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
	const refused = decoded.conditions.filter(
		(condition) => !offered.get(condition.field)?.operators.includes(condition.operator)
	);
	return {
		conditions: decoded.conditions.filter((condition) => !refused.includes(condition)),
		unresolved: [
			...decoded.unresolved,
			...refused.map((condition) => `${condition.field} ${condition.operator}`)
		]
	} satisfies CollectionFilterInference;
});
