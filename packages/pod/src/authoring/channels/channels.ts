import type { DefaultPolicyName } from '../schema/types.js';

/** How host sandbox tools may touch the tenant worktree for one channel. */
export type ChannelHostSandbox = {
	/**
	 * `read-only` — worktree mounted RO; only `/workspace/src/.tmp` (scratch) is writable.
	 * `read-write` — full authoring sandbox (repo edits allowed).
	 */
	readonly workspace: 'read-only' | 'read-write';
};

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
	readonly description?: string | null;
	/** Overrides the agent's default instruction for this channel. */
	readonly task?: string;
	/**
	 * Host tools this channel's agent may call — empty / omitted means none.
	 *
	 * Channel runs default to no host tools: a host tool authorizes as the host's builder principal,
	 * which the channel's policy cannot reach, so a WhatsApp or Telegram group must not inherit
	 * sandbox write / branch / deploy reach by accident. Naming tools here is an explicit opt-in for
	 * that channel (e.g. analysis-only `sandbox_bash` + read tools), checked at startup against what
	 * the host actually supplies.
	 */
	readonly hostTools?: readonly string[];
	/**
	 * How those host tools may touch the tenant worktree.
	 *
	 * When `hostTools` is non-empty and this is omitted, the run defaults to `workspace: 'read-only'`
	 * (RO worktree + writable scratch). Set `workspace: 'read-write'` only when the channel is meant
	 * to author the repo.
	 */
	readonly hostSandbox?: ChannelHostSandbox;
};

/** Identity function that exists for its inference; a channel file gets checked on write. */
export function defineChannel<const TChannel extends ChannelDefinition>(
	channel: TChannel
): TChannel {
	if (!channel.transport.trim()) throw new Error('Channel transport cannot be empty');
	if (!String(channel.policy).trim()) throw new Error('Channel policy cannot be empty');
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
