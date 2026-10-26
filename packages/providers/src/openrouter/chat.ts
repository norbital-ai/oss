import { openAiChat, type OpenAiChat, type OpenAiChatConfig } from '@norbital-ai/bolt/engine';
import { Array as EffectArray } from 'effect';

type DeepSeekRouting = {
	readonly provider?: {
		readonly sort: 'price';
		readonly require_parameters: true;
	};
};

/** OpenRouter selects a compatible DeepSeek provider by price, subject to the account's privacy policy. */
export const deepSeekRouting = (endpoint: string, model: string): DeepSeekRouting =>
	model.startsWith('deepseek/') && new URL(endpoint).hostname === 'openrouter.ai'
		? { provider: { sort: 'price', require_parameters: true } }
		: {};

/** Provider routing uses the resolved model, including a catalog id chosen instead of a configured class. */
export const openRouterChat =
	(config: OpenAiChatConfig, options: Parameters<typeof openAiChat>[1] = {}): OpenAiChat =>
	(request) => {
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
