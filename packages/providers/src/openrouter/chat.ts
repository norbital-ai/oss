import {
	openAiChat,
	provideHttp,
	type OpenAiChat,
	type OpenAiChatConfig
} from '@norbital-ai/bolt/engine';
import { Array as EffectArray, Effect } from 'effect';
import { models } from './models.ts';

type DeepSeekRouting = {
	readonly provider?: {
		readonly sort: 'price';
		readonly require_parameters: true;
		readonly ignore: readonly string[];
	};
};

/**
 * OpenRouter selects a compatible DeepSeek provider by price, subject to the account's privacy policy. A provider whose
 * prompt cache serves a stale context (the model cannot see the tool results it was just sent) is never chosen.
 */
export const deepSeekRouting = (endpoint: string, model: string): DeepSeekRouting =>
	model.startsWith('deepseek/') && new URL(endpoint).hostname === 'openrouter.ai'
		? { provider: { sort: 'price', require_parameters: true, ignore: ['open-inference'] } }
		: {};

/** Provider routing uses the resolved model, including a catalog id chosen instead of a configured class. */
export const openRouterChat = (
	config: OpenAiChatConfig,
	options: Parameters<typeof openAiChat>[1] = {}
): OpenAiChat => {
	// each model's input modalities from `/models`, read once the listing answers
	let listed: ReadonlyMap<string, readonly string[]> | undefined;
	const inputs = (model: string) =>
		listed !== undefined
			? Effect.succeed(listed.get(model))
			: models({ baseUrl: config.endpoint, apiKey: config.credential }).pipe(
					provideHttp(options),
					Effect.map((catalogue) => {
						const known = new Map(
							catalogue.chat.flatMap((m) =>
								m.architecture?.input_modalities === undefined
									? []
									: [[m.id, m.architecture.input_modalities] as const]
							)
						);
						if (!catalogue.unread) listed = known;
						return known.get(model);
					})
				);
	return (request) => {
		const model = config.models[request.model] ?? request.model;
		const routing = deepSeekRouting(config.endpoint, model);
		const configured = config.body?.['provider'];
		const preferences =
			typeof configured === 'object' &&
			configured !== null &&
			!EffectArray.isArray<typeof configured>(configured)
				? configured
				: {};
		return openAiChat(
			{
				...config,
				models: {},
				inputs: config.inputs ?? inputs,
				body: {
					...config.body,
					...(routing.provider === undefined
						? {}
						: { provider: { ...routing.provider, ...preferences } })
				}
			},
			options
		)({ ...request, model });
	};
};
