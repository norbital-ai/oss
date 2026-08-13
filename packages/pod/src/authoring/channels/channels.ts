import type { DefaultMcpServerName, DefaultPolicyName } from '../schema/types.js';

/** How host sandbox tools may touch the tenant worktree for one channel. */
export type ChannelHostSandbox = {
	/**
	 * `read-only` — worktree mounted RO; only `/workspace/src/.tmp` (scratch) is writable.
	 * `read-write` — full authoring sandbox (repo edits allowed).
	 */
	readonly workspace: 'read-only' | 'read-write';
};

/** Durable one-minute admission limits applied before an agent run is created. */
export type ChannelRateLimits = {
	readonly perSenderPerMinute: number;
	readonly totalPerMinute: number;
};

type ChannelDefinitionBase = {
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
	/**
	 * The transport carrying this channel — `telegram`, `whatsapp`, and so on.
	 *
	 * Not a closed union: which transports a host offers is the host's business, and holding a socket
	 * open is not something a scale-to-zero tenant can do, so the workspace names one and the host
	 * provides it.
	 *
	 * Checked at startup against the host's `messaging.listTransports()`, so a workspace naming a
	 * transport its host does not supply refuses to boot instead of failing at the first inbound
	 * message — see {@link assertChannelTransportsAreSupported}.
	 */
	readonly transport: string;
	/**
	 * The policy the agent acts under for messages arriving here.
	 *
	 * Bound to the workspace's generated policy names, so a channel cannot point at a policy that does
	 * not exist — that failure would otherwise surface as an agent silently reaching nothing.
	 */
	readonly policy: DefaultPolicyName;
	/** Who reaches the workspace through this channel and what for. Carried into the manifest. */
	readonly description: string;
	/** Overrides the agent's default instruction for this channel. */
	readonly task?: string;
	/**
	 * Host tools this channel's agent may call — empty / omitted means none.
	 *
	 * Channel runs default to no host tools. Naming tools here is an explicit opt-in for that channel
	 * (for example analysis-only `sandbox_bash` plus read tools), checked at startup against what the
	 * host supplies. The host re-resolves the channel agent's principal before opening its worktree.
	 */
	readonly hostTools?: readonly string[];
	/**
	 * MCP servers this channel's agent may call — empty / omitted means none.
	 *
	 * Same default-deny as `hostTools`. A channel that needs a payment or issue tracker opts in by
	 * naming the server declared in `src/mcp/+<name>.mcp.ts`.
	 */
	readonly mcpServers?: readonly DefaultMcpServerName[];
	/**
	 * How those host tools may touch the tenant worktree.
	 *
	 * When `hostTools` is non-empty and this is omitted, the run defaults to `workspace: 'read-only'`
	 * (RO worktree + writable scratch). Set `workspace: 'read-write'` only when the channel is meant
	 * to author the repo.
	 */
	readonly hostSandbox?: ChannelHostSandbox;
};

/**
 * Public profiles must declare their admission budget in the same diff that opens the audience.
 * Authenticated profiles rely on assigned identity and the platform concurrency ceiling instead of
 * adding another per-profile choice.
 */
export type ChannelDefinition = ChannelDefinitionBase &
	(
		| {
				/** Anyone on the transport may message the profile without a Pod account. */
				readonly audience: 'public';
				readonly rateLimits: ChannelRateLimits;
		  }
		| {
				/** Active assigned accounts with a verified transport identity only. */
				readonly audience: 'authenticated';
				readonly rateLimits?: never;
		  }
	) & {
		/** DMs are always enabled; this is the only group-specific choice. */
		readonly groupMessages: 'disabled' | 'all' | 'mention_or_reply';
	};

/** Identity function that exists for its inference; a channel file gets checked on write. */
export function defineChannel<const TChannel extends ChannelDefinition>(
	channel: TChannel
): TChannel {
	if (!channel.transport.trim()) throw new Error('Channel transport cannot be empty');
	if (!String(channel.policy).trim()) throw new Error('Channel policy cannot be empty');
	if (!channel.description.trim()) throw new Error('Channel description cannot be empty');
	if (channel.audience === 'public' && !channel.rateLimits) {
		throw new Error('Public channels must declare rate limits');
	}
	return channel;
}

/**
 * Refuse a channel whose transport this host cannot carry.
 *
 * Same reasoning as the system-event reachability check: the two halves are matched by exact string
 * far from where either is written, so a wrong name produced no error and no record — the channel
 * simply never carried anything, and the silence was only noticed when somebody expected a reply.
 * A transport name is knowable from source and the host's list is knowable at boot, so this is a
 * cross-reference that can be checked once, before the workspace serves anything.
 *
 * The available list is in the message because the mistake is nearly always a name, not a missing
 * provider: `telegram` against a host offering `whatsapp` is a typo-shaped failure, and the fix is
 * unguessable without seeing what the host actually has.
 */
export function assertChannelTransportsAreSupported(
	channels: Readonly<Record<string, { readonly transport: string }>>,
	available: ReadonlySet<string>
): void {
	const unsupported = Object.entries(channels).filter(
		([, channel]) => !available.has(channel.transport)
	);
	if (unsupported.length === 0) return;
	const known = [...available].sort();
	throw new Error(
		unsupported
			.map(
				([name, channel]) =>
					`Channel "${name}" needs transport "${channel.transport}", which this host does not supply.` +
					(known.length > 0
						? ` Available transports: ${known.join(', ')}.`
						: ' This host supplies no transports.')
			)
			.join('\n')
	);
}
