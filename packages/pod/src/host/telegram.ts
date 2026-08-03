import type {
	TransportMessage,
	TransportSendResult
} from '@norbital-ai/platform-utils/runtime/binding';
import type { ChannelInboundMessage, ChannelInboundResult, HostChannelListener } from './types.js';
import type { MessagingTransport } from './facilities.js';

export type TelegramBotOptions = {
	/** The bot token from BotFather. It is the whole credential — treat it as one. */
	readonly botToken: string;
	/**
	 * The declared channel every message this bot receives is delivered to.
	 *
	 * One bot is one conversational surface, so the mapping is fixed at configuration time rather than
	 * guessed per message. A workspace with two Telegram channels runs two bots.
	 */
	readonly channel: string;
	/** Long-poll hold time in seconds. Telegram caps this at 50; the default is deliberate. */
	readonly pollTimeoutSeconds?: number;
	/** Overridable for tests and for a self-hosted Bot API server. */
	readonly apiBaseUrl?: string;
	/** Where a polling failure is reported. Defaults to `console.error`. */
	readonly log?: (message: string, cause?: unknown) => void;
};

type TelegramUpdate = {
	readonly update_id: number;
	readonly message?: {
		readonly message_id: number;
		readonly text?: string;
		readonly chat?: { readonly id: number | string };
		readonly from?: {
			readonly id: number | string;
			readonly first_name?: string;
			readonly last_name?: string;
			readonly username?: string;
		};
	};
};

function senderName(from: NonNullable<NonNullable<TelegramUpdate['message']>['from']>): string {
	const parts = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
	return parts || from.username || String(from.id);
}

/**
 * Turn one Telegram update into the inbound message shape, or nothing.
 *
 * Exported for its test: the mapping from Telegram's envelope to Pod's is the only part of this file
 * with a wrong answer, and the rest is a socket and a loop. Anything without text — a photo, a member
 * joining, an edit — is skipped rather than delivered as an empty message.
 */
export function telegramInboundMessage(
	channel: string,
	update: TelegramUpdate
): ChannelInboundMessage | null {
	const message = update.message;
	const text = message?.text?.trim();
	const chatId = message?.chat?.id;
	if (!message || !text || chatId == null) return null;
	return {
		channel,
		conversationId: String(chatId),
		// Telegram's own id, not the update id: an update is redelivered until acknowledged, and the
		// message id is what stays the same across those attempts. Deduplication depends on it.
		messageId: String(message.message_id),
		text,
		...(message.from
			? { sender: { id: String(message.from.id), displayName: senderName(message.from) } }
			: {})
	};
}

/**
 * Telegram, over long polling rather than a webhook.
 *
 * Polling is the deliberate choice, not a shortcut. A webhook means a publicly reachable endpoint
 * whose authenticity rests on a secret header Pod would have to hold and verify — a security model
 * per transport, inside a runtime that holds no transport credentials. `getUpdates` is an outbound
 * authenticated call: nothing listens, nothing is exposed, and there is nothing to forge. It also
 * needs no public URL, so it works from a laptop and from a private network.
 *
 * The offset is not persisted. That is safe because Telegram redelivers anything unacknowledged and
 * the inbound ledger recognises a redelivery by the provider's own message id — so a restart replays
 * and Pod drops the replay, rather than the host having to keep a cursor durable.
 */
export function telegramBot(options: TelegramBotOptions): {
	readonly transport: MessagingTransport;
	readonly listen: HostChannelListener;
} {
	if (!options.botToken.trim()) throw new Error('telegramBot requires a bot token');
	if (!options.channel.trim()) throw new Error('telegramBot requires the channel it delivers to');
	const base = (options.apiBaseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
	const endpoint = (method: string) => `${base}/bot${options.botToken}/${method}`;
	const pollTimeout = Math.min(Math.max(options.pollTimeoutSeconds ?? 25, 1), 50);
	const log = options.log ?? ((message: string, cause?: unknown) => console.error(message, cause));

	const transport: MessagingTransport = {
		transport: 'telegram',
		async send(message: TransportMessage): Promise<TransportSendResult> {
			const response = await fetch(endpoint('sendMessage'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ chat_id: message.conversationId, text: message.text })
			});
			if (!response.ok) {
				return { sent: false, reason: `Telegram answered ${response.status}` };
			}
			const body = (await response.json()) as {
				readonly ok?: boolean;
				readonly description?: string;
			};
			if (body.ok !== true) {
				return { sent: false, reason: body.description ?? 'Telegram refused the message' };
			}
			return { sent: true };
		}
	};

	const listen: HostChannelListener = async (deliver) => {
		const controller = new AbortController();
		let offset: number | undefined;
		let stopped = false;

		const pollOnce = async (): Promise<void> => {
			const response = await fetch(endpoint('getUpdates'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					timeout: pollTimeout,
					allowed_updates: ['message'],
					...(offset === undefined ? {} : { offset })
				}),
				signal: controller.signal
			});
			if (!response.ok) throw new Error(`Telegram getUpdates answered ${response.status}`);
			const body = (await response.json()) as {
				readonly ok?: boolean;
				readonly result?: readonly TelegramUpdate[];
			};
			if (body.ok !== true) throw new Error('Telegram getUpdates refused');
			for (const update of body.result ?? []) {
				// The offset advances even for an update this bot ignores, or Telegram redelivers the same
				// unhandled update forever and nothing after it is ever seen.
				offset = update.update_id + 1;
				const inbound = telegramInboundMessage(options.channel, update);
				if (!inbound) continue;
				try {
					const outcome: ChannelInboundResult = await deliver(inbound);
					if (outcome.status === 'answered' && outcome.delivered === false) {
						log(`[pod:telegram] reply for ${inbound.conversationId} was not delivered`);
					}
				} catch (cause) {
					// One bad message must not stop the wire. The receipt row records the failure; this
					// loop keeps the rest of the conversation moving.
					log(`[pod:telegram] delivery failed for message ${inbound.messageId}`, cause);
				}
			}
		};

		void (async () => {
			let backoffMs = 1000;
			while (!stopped) {
				try {
					await pollOnce();
					backoffMs = 1000;
				} catch (cause) {
					if (stopped) return;
					log('[pod:telegram] poll failed', cause);
					await new Promise((resolve) => setTimeout(resolve, backoffMs));
					backoffMs = Math.min(backoffMs * 2, 60_000);
				}
			}
		})();

		return () => {
			stopped = true;
			controller.abort();
		};
	};

	return { transport, listen };
}
