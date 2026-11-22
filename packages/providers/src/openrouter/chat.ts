import type { OpenAiChat } from '@norbital-ai/host-api';
import { open_ai_chat, session_of, type OpenAiChatConfig } from '../openai/index.ts';
import { Array as EffectArray } from 'effect';

export { session_of };

type DeepSeekRouting = {
	readonly provider?: {
		readonly only: readonly string[];
		readonly sort: 'latency';
		readonly require_parameters: true;
	};
};

const is_open_router = (endpoint: string): boolean => {
	try {
		const host = new URL(endpoint).hostname.toLowerCase();
		return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
	} catch {
		return false;
	}
};

/**
 * OpenRouter sorts once and the conversation stays, subject to the account's privacy policy. `only` holds the DeepSeek
 * providers whose prompt cache read 99 to 100% across a conversation (others read 25 to 80%, or serve a stale context, or drop
 * tool arguments), `sort` takes the fastest on the first step, and `session_id` keeps every later step there, where its
 * prefix and cached price are, moving only if that provider fails.
 */
const deep_seek_routing = (model: string): DeepSeekRouting =>
	model.startsWith('deepseek/')
		? {
				provider: {
					only: ['together', 'relace/fast', 'deepinfra/fp8', 'baseten'],
					sort: 'latency',
					require_parameters: true
				}
			}
		: {};

/** Provider routing uses the resolved model, including a catalog id chosen instead of a configured class. */
export const open_router_chat =
	(config: OpenAiChatConfig, options: Parameters<typeof open_ai_chat>[1] = {}): OpenAiChat =>
	(request) => {
		const model = config.models[request.model] ?? request.model;
		const openRouter = is_open_router(config.endpoint);
		const routing = openRouter ? deep_seek_routing(model) : {};
		const configured = config.body?.['provider'];
		const preferences =
			typeof configured === 'object' &&
			configured !== null &&
			!EffectArray.isArray<typeof configured>(configured)
				? configured
				: {};
		return open_ai_chat(
			{
				...config,
				models: {},
				body: {
					...config.body,
					...(openRouter && config.body?.['session_id'] === undefined
						? { session_id: session_of(request) }
						: {}),
					...(routing.provider === undefined
						? {}
						: {
								provider: { ...routing.provider, ...preferences }
							})
				}
			},
			options
		)({ ...request, model });
	};
