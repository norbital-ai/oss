import { Effect, Option, Schema } from 'effect';
import { jsonApi } from '../transport.ts';
import type { Endpoint } from './embeddings.ts';

export const Model = Schema.Struct({
	id: Schema.NonEmptyString,
	name: Schema.optionalKey(Schema.String),
	context_length: Schema.optionalKey(Schema.Number),
	architecture: Schema.optionalKey(
		Schema.Struct({
			input_modalities: Schema.optionalKey(Schema.Array(Schema.String)),
			output_modalities: Schema.optionalKey(Schema.Array(Schema.String))
		})
	),
	supported_parameters: Schema.optionalKey(Schema.Array(Schema.String))
});
export type Model = typeof Model.Type;
export type ModelCatalogue = {
	readonly chat: readonly Model[];
	readonly embeddings: readonly Model[];
	readonly unread: boolean;
};
const Listing = Schema.Struct({ data: Schema.Array(Model) });

/** Both provider lists are read once; an unavailable listing remains explicit for P39. */
export const models = Effect.fn('OpenRouter.models')(function* (endpoint: Endpoint) {
	const call = jsonApi(
		endpoint.baseUrl,
		endpoint.apiKey === undefined ? {} : { authorization: `Bearer ${endpoint.apiKey}` }
	);
	const [chat, embeddings] = yield* Effect.all(
		['/models', '/embeddings/models'].map((path) =>
			call(Listing, 'GET', path).pipe(Effect.timeout('10 seconds'), Effect.option)
		),
		{ concurrency: 'unbounded' }
	);
	return {
		chat: chat !== undefined && Option.isSome(chat) ? chat.value.data : [],
		embeddings: embeddings !== undefined && Option.isSome(embeddings) ? embeddings.value.data : [],
		unread:
			chat === undefined ||
			embeddings === undefined ||
			Option.isNone(chat) ||
			Option.isNone(embeddings)
	} satisfies ModelCatalogue;
});
