// Embeddings on an OpenAI-compatible endpoint (OpenRouter, or any `/v1` that serves `/embeddings`), and P39's check
// that every `sys_2` and embedding model a host binds takes images. The one implementation every host uses
// as one shared provider implementation.
import { Crypto, Duration, Effect, Schedule, Schema } from 'effect';
import type { Json } from '@norbital-ai/bolt/engine';
import { ProviderUnavailable } from '../errors.ts';
import { jsonApi } from '../link.ts';
import { models, type ModelCatalogue } from './models.ts';

/** One embedding input: text, or a stored file's bytes (an image; embed models are multimodal). */
export type EmbedInput =
	| string
	| {
			readonly $file: { readonly name: string; readonly mime: string; readonly bytes: Uint8Array };
	  };
export type Endpoint = { readonly baseUrl: string; readonly apiKey?: string | undefined };
export type EmbeddingsConfig<E> = Endpoint & {
	/** The provider model a workspace's embedding name runs and how many inputs one request may carry; `undefined`: none is mapped. */
	readonly model: (name: string) => { readonly id: string; readonly batch: number } | undefined;
	/** Records the provider's charge for one request (USD) under its id; a failure is logged, never the embedding's. */
	readonly meter?: ((costUsd: number, id: string) => Effect.Effect<void, E>) | undefined;
};

const RETRIES = 3;
const Answer = Schema.Struct({
	id: Schema.optionalKey(Schema.String),
	data: Schema.Array(
		Schema.Struct({
			index: Schema.optionalKey(Schema.Number),
			embedding: Schema.Array(Schema.Number)
		})
	),
	usage: Schema.optionalKey(Schema.Struct({ cost: Schema.optionalKey(Schema.Number) }))
});
const auth = (e: Endpoint) =>
	e.apiKey === undefined ? {} : { authorization: `Bearer ${e.apiKey}` };
/** A file as an OpenAI-style image or file content part, its bytes inline. */
const part = (f: {
	readonly name: string;
	readonly mime: string;
	readonly bytes: Uint8Array;
}): Json => {
	const url = `data:${f.mime};base64,${Buffer.from(f.bytes).toString('base64')}`;
	return f.mime.startsWith('image/')
		? { type: 'image_url', image_url: { url } }
		: { type: 'file', file: { filename: f.name, file_data: url } };
};
/** Text alone goes as strings; a batch with a file goes in the multimodal shape, one `{ content }` per input (a bare part is refused). */
const wire = (batch: readonly EmbedInput[]): Json =>
	batch.every((x): x is string => typeof x === 'string')
		? batch
		: batch.map((x) => ({
				content: [typeof x === 'string' ? { type: 'text', text: x } : part(x.$file)]
			}));

/**
 * `embed(inputs, name, dimensions?)`: one vector per input, in order, `dimensions` long when the model truncates. A
 * request carries at most the model's batch; a rate limit or a 5xx is retried up to three times, after the provider's
 * `retry-after` (at most 10 s) or exponentially from 1 s.
 */
export const openAiEmbeddings = <E>(config: EmbeddingsConfig<E>) => {
	const call = jsonApi(config.baseUrl, auth(config));
	return Effect.fn('openrouter.embed')(function* (
		inputs: readonly EmbedInput[],
		name: string,
		dimensions?: number
	) {
		const model = config.model(name);
		if (model === undefined)
			return yield* new ProviderUnavailable({
				message: `no model is mapped to the embedding '${name}'`
			});
		const vectors: (readonly number[])[] = [],
			size = Math.max(1, model.batch);
		for (let at = 0; at < inputs.length; at += size) {
			const batch = inputs.slice(at, at + size);
			const answer = yield* call(Answer, 'POST', '/embeddings', {
				model: model.id,
				input: wire(batch),
				...(dimensions === undefined ? {} : { dimensions })
			}).pipe(
				Effect.retry({
					times: RETRIES,
					while: (e) =>
						e._tag === 'ProviderUnavailable' &&
						e.status !== undefined &&
						(e.status === 429 || e.status >= 500),
					schedule: Schedule.exponential('1 second').pipe(
						Schedule.modifyDelay(({ input, duration }) =>
							Effect.succeed(
								Math.min(
									10_000,
									input instanceof ProviderUnavailable && input.retryAfterMs !== undefined
										? input.retryAfterMs
										: Duration.toMillis(duration)
								)
							)
						)
					)
				})
			);
			if (answer.data.length !== batch.length)
				return yield* new ProviderUnavailable({
					message: `the AI provider answered ${answer.data.length} embeddings for ${batch.length} inputs`
				});
			vectors.push(
				...[...answer.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding)
			);
			const cost = answer.usage?.cost ?? 0;
			const meter = config.meter;
			if (meter !== undefined && Number.isFinite(cost) && cost > 0)
				yield* Effect.gen(function* () {
					const id = answer.id ?? `embed:${yield* (yield* Crypto.Crypto).randomUUIDv4}`;
					yield* meter(cost, id);
				}).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
		}
		return vectors;
	});
};

/** One system's models for P39: the ones to check, what the operator declared they take, and the env var that declares it. */
export type ModalityCheck = {
	readonly system: 'sys_2' | 'embed';
	readonly endpoint: Endpoint;
	readonly models: readonly string[];
	readonly declared: readonly string[] | undefined;
	readonly env: string;
};

/**
 * P39 before activation: each model must take images, by the provider's published metadata (`GET /models` and
 * `/embeddings/models`, `architecture.input_modalities`, as OpenRouter publishes them), else by the operator's
 * declaration. One message per refused model, naming the system, the model id and its modalities. `tolerateUnread`: a
 * listing that did not answer is no evidence against an undeclared model (one blip must not refuse the host); it is
 * logged and passed.
 */
export const aiModalityRefusals = Effect.fn('openrouter.modalities')(function* (
	checks: readonly ModalityCheck[],
	options: {
		readonly tolerateUnread: boolean;
		readonly listings?: ReadonlyMap<string, ModelCatalogue>;
	}
) {
	// each endpoint's listings are read once: OpenRouter lists chat models at `/models` and embedding models only at `/embeddings/models`
	const listings = new Map<
		string,
		{ readonly meta: ReadonlyMap<string, readonly string[]>; readonly unread: boolean }
	>();
	const out: string[] = [];
	for (const check of checks) {
		let read = listings.get(check.endpoint.baseUrl);
		if (read === undefined) {
			const catalogue =
				options.listings?.get(check.endpoint.baseUrl) ?? (yield* models(check.endpoint));
			const meta = new Map<string, readonly string[]>();
			for (const model of [...catalogue.chat, ...catalogue.embeddings])
				if (model.architecture?.input_modalities !== undefined)
					meta.set(model.id, model.architecture.input_modalities);
			listings.set(check.endpoint.baseUrl, (read = { meta, unread: catalogue.unread }));
		}
		for (const id of new Set(check.models)) {
			const mods = read.meta.get(id) ?? check.declared;
			if (mods?.includes('image') === true) continue;
			if (mods === undefined && read.unread && options.tolerateUnread) {
				yield* Effect.logWarning(
					`${check.system} model '${id}': the provider's model list did not answer; its modalities are unchecked`
				);
				continue;
			}
			out.push(
				`${check.system} model '${id}' ${mods === undefined ? `has no published input modalities and ${check.env} is unset` : `takes ${mods.join(', ') || 'nothing'}`}: it must take image (P39)`
			);
		}
	}
	return out;
});
