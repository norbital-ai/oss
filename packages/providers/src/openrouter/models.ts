import { Effect, Option, Schema } from 'effect';
import type { AiModel } from '@norbital-ai/host-api';
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
	supported_parameters: Schema.optionalKey(Schema.Array(Schema.String)),
	/** USD per token as decimal strings; a router answers `-1` (its price varies by the model it picks). */
	pricing: Schema.optionalKey(
		Schema.Struct({
			prompt: Schema.optionalKey(Schema.String),
			completion: Schema.optionalKey(Schema.String),
			input_cache_read: Schema.optionalKey(Schema.String)
		})
	)
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
		endpoint.base_url,
		endpoint.api_key === undefined ? {} : { authorization: `Bearer ${endpoint.api_key}` }
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

const perMillion = (perToken: string | undefined) => {
	const n = Number(perToken);
	return perToken === undefined || !Number.isFinite(n) || n < 0
		? undefined
		: Number((n * 1_000_000).toPrecision(12));
};
/** A listed model as the panel shows it: OpenRouter's `Vendor: Name` splits into provider and label, its price per million tokens. */
const listed = (model: Model): AiModel => {
	const slash = model.id.indexOf('/'),
		name = model.name ?? (slash < 0 ? model.id : model.id.slice(slash + 1)),
		colon = name.indexOf(': '),
		input = perMillion(model.pricing?.prompt),
		output = perMillion(model.pricing?.completion),
		cached = perMillion(model.pricing?.input_cache_read);
	return {
		id: model.id,
		label: colon < 0 ? name : name.slice(colon + 2),
		...(colon >= 0
			? { provider: name.slice(0, colon) }
			: slash < 0
				? {}
				: { provider: model.id.slice(0, slash) }),
		...(model.context_length === undefined ? {} : { context: model.context_length }),
		...(input === undefined || output === undefined
			? {}
			: { price: { input, output, ...(cached === undefined ? {} : { cached }) } })
	};
};
/**
 * What a listing can run, by system: `sys_2` (the agent) takes text and images, answers text, calls tools and has a known
 * window; `sys_1` (structured decisions) takes text and images and answers to a JSON schema. A model whose listing
 * reports none of that is not offered; nor are `:free` variants (their prompts may be logged) or `:batch` ones (no stream).
 */
export const ai_models = (catalogue: ModelCatalogue) => {
	const usable = catalogue.chat.filter((model) => {
		const input = model.architecture?.input_modalities ?? [];
		return (
			!/:(free|batch)$/.test(model.id) &&
			input.includes('text') &&
			input.includes('image') &&
			(model.architecture?.output_modalities ?? []).includes('text')
		);
	});
	const takes = (model: Model, ...parameters: readonly string[]) =>
		parameters.every((p) => (model.supported_parameters ?? []).includes(p));
	return {
		sys_1: usable.filter((model) => takes(model, 'structured_outputs')).map(listed),
		sys_2: usable
			.filter(
				(model) =>
					takes(model, 'tools', 'tool_choice') &&
					model.context_length !== undefined &&
					Number.isSafeInteger(model.context_length) &&
					model.context_length > 0
			)
			.map(listed)
	};
};
