import {
	openAiChat,
	type AiRequest,
	type OpenAiChat,
	type OpenAiChatConfig
} from '@norbital-ai/bolt/engine';
import { Array as EffectArray, Hash } from 'effect';

type DeepSeekRouting = {
	readonly provider?: {
		readonly only: readonly string[];
		readonly sort: 'latency';
		readonly require_parameters: true;
	};
};

/**
 * OpenRouter sorts once and the conversation stays, subject to the account's privacy policy. `only` holds the DeepSeek
 * providers whose prompt cache read 99 to 100% across a conversation (others read 25 to 80%, or serve a stale context, or drop
 * tool arguments), `sort` takes the fastest on the first step, and `session_id` keeps every later step there, where its
 * prefix and cached price are, moving only if that provider fails.
 */
export const deepSeekRouting = (endpoint: string, model: string): DeepSeekRouting =>
	model.startsWith('deepseek/') && new URL(endpoint).hostname === 'openrouter.ai'
		? {
				provider: {
					only: ['together', 'relace/fast', 'deepinfra/fp8', 'baseten'],
					sort: 'latency',
					require_parameters: true
				}
			}
		: {};

/** What never changes in a conversation names it: a compaction starts a new prefix, nothing cached to lose, and sorts again. */
export const sessionOf = (request: Pick<AiRequest, 'system' | 'messages'>) =>
	String(Hash.string(`${request.system ?? ''}${JSON.stringify(request.messages[0])}`));

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
						: { provider: { ...routing.provider, ...preferences }, session_id: sessionOf(request) })
				}
			},
			options
		)({ ...request, model });
	};
