import type { DefaultPolicyName } from '../schema/types.js';

/**
 * A conversational entry point into the workspace agent, declared in
 * `src/channels/+<name>.channel.ts`.
 *
 * A channel is the agent reached over someone else's wire — Telegram, WhatsApp, email. What arrives is
 * a message from a person the workspace may not have a user row for, so the interesting question is
 * not "how do I speak this protocol" but "whose permissions does the agent act under when it answers".
 * That is `policy`, and it is why a channel is a declaration rather than host configuration: the
 * answer belongs in source, where it shows up in a diff.
 *
 * The transport itself stays host-supplied. Holding a socket open is not something a scale-to-zero
 * tenant can do, so the workspace names the transport and the host provides it.
 */
export type ChannelDefinition = {
	/**
	 * The transport carrying this channel — `telegram`, `whatsapp`, and so on.
	 *
	 * Not a closed union: which transports a host offers is the host's business, and holding a socket
	 * open is not something a scale-to-zero tenant can do, so the workspace names one and the host
	 * provides it.
	 *
	 * **Not yet validated.** The check belongs at startup — a workspace naming a transport its host does
	 * not provide should refuse to boot rather than fail at the first inbound message — but it needs the
	 * `messaging` facility and its `transports` record, which do not exist yet (the facility is still
	 * named `notifications` and carries no transports). Until then a wrong name fails when a message
	 * arrives. Tracked in docs/CORE_REFACTOR.md.
	 */
	readonly transport: string;
	/**
	 * The policy the agent acts under for messages arriving here.
	 *
	 * Bound to the workspace's generated policy names, so a channel cannot point at a policy that does
	 * not exist — that failure would otherwise surface as an agent silently reaching nothing.
	 */
	readonly policy: DefaultPolicyName;
	readonly description?: string | null;
	/** Overrides the agent's default instruction for this channel. */
	readonly task?: string;
};

/** Identity function that exists for its inference; a channel file gets checked on write. */
export function defineChannel<const TChannel extends ChannelDefinition>(
	channel: TChannel
): TChannel {
	if (!channel.transport.trim()) throw new Error('Channel transport cannot be empty');
	if (!String(channel.policy).trim()) throw new Error('Channel policy cannot be empty');
	return channel;
}
