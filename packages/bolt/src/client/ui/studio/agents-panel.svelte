<script module lang="ts">
	import { FEATURE_COLOR_STYLES } from '@norbital-ai/ui/feature-colors';

	// A constant lookup into a frozen table, so it belongs to the module rather than to every
	// instance — and it is emphatically not a computation to make reactive.
	const AGENT_STYLES = FEATURE_COLOR_STYLES.agents;
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { Effect, Schema } from 'effect';
	import Icon from '@iconify/svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { ProductIcon } from '@norbital-ai/ui/product-icon';
	import { cn } from '@norbital-ai/ui/utils';
	import {
		AGENT_BINDING_NOTE,
		CHANNEL_CONNECTION_UNREPORTABLE,
		ChannelStatusSchema,
		type ChannelStatus,
		type StudioAgent
	} from './studio-state.js';

	/**
	 * Agents, and everything reached through one of them, on a single page.
	 *
	 * A channel is how an agent is spoken to and a tool is what it may call, so both are read here
	 * rather than as branches beside Agents — the sibling arrangement made a reader assemble the
	 * agent themselves out of three lists that never named each other.
	 *
	 * The connection column is the honest one. `channels.status` is the only thing the runtime will
	 * say about a channel, and `registered` in it means "someone called `channels.register`", not
	 * "the transport is up". So a registered channel is reported as registered and never as
	 * connected, and the note under the list says what is missing rather than leaving a green dot to
	 * imply it was checked.
	 */
	let {
		agents = [],
		command,
		onopenSource
	}: {
		agents?: ReadonlyArray<StudioAgent>;
		command: (name: string, input: Readonly<Record<string, string>>) => Promise<unknown>;
		onopenSource?: ((path: string) => void) | undefined;
	} = $props();

	/**
	 * Every channel's last read, held as one cell.
	 *
	 * A read either lands or fails per channel, and both halves plus the in-flight flag change on the
	 * same click — three independent cells only made a single refresh three writes.
	 */
	let connections = $state<{
		readonly reads: Readonly<Record<string, ChannelStatus>>;
		readonly failures: Readonly<Record<string, string>>;
		readonly pending: boolean;
	}>({ reads: {}, failures: {}, pending: false });

	const channelNames = $derived(agents.flatMap((agent) => agent.channels.map(({ name }) => name)));

	/** Reads every channel's status in one pass, so the list is never half-answered. */
	const readConnections = async (): Promise<void> => {
		connections = { ...connections, pending: true };
		const results = await Promise.all(
			channelNames.map(async (channel) => {
				try {
					return {
						channel,
						status: await Effect.runPromise(
							Schema.decodeUnknownEffect(ChannelStatusSchema)(
								await command('channels.status', { channel })
							)
						)
					};
				} catch (cause) {
					return { channel, failure: cause instanceof Error ? cause.message : String(cause) };
				}
			})
		);
		connections = {
			reads: Object.fromEntries(
				results.flatMap((result) => ('status' in result ? [[result.channel, result.status]] : []))
			) as Readonly<Record<string, ChannelStatus>>,
			failures: Object.fromEntries(
				results.flatMap((result) => ('failure' in result ? [[result.channel, result.failure]] : []))
			) as Readonly<Record<string, string>>,
			pending: false
		};
	};

	// The read is the browser's: server rendering must not issue a Bolt command, and a reader who
	// opens Agents has already asked the question the read answers.
	onMount(() => {
		if (channelNames.length > 0) void readConnections();
	});
</script>

{#snippet sectionHeading(label: string, count: number)}
	<h3 class="text-overline">
		{label} ({count})
	</h3>
{/snippet}

{#snippet connectionChip(channel: string)}
	{@const failure = connections.failures[channel]}
	{@const status = connections.reads[channel]}
	<span
		class={cn(
			'shrink-0 rounded-full px-2 py-0.5 text-tiny font-semibold',
			failure !== undefined
				? 'bg-destructive/10 text-destructive'
				: status === undefined
					? 'bg-muted text-muted-foreground'
					: status.registered
						? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
						: 'bg-muted text-muted-foreground'
		)}
		data-testid="studio-channel-connection"
		data-channel={channel}
		role="status"
	>
		{failure !== undefined
			? 'Status unavailable'
			: status === undefined
				? connections.pending
					? 'Reading…'
					: 'Not read'
				: status.registered
					? 'Registered'
					: 'Never registered'}
	</span>
{/snippet}

<Scroll name="Agents panel" class="p-4 sm:p-6">
	<Stack gap="md">
		<Inline gap="sm">
			<div
				class={cn(
					'flex size-6 items-center justify-center rounded-md border',
					AGENT_STYLES.iconWrapperClass
				)}
			>
				<ProductIcon name="agent" class={cn('size-3.5', AGENT_STYLES.iconClass)} />
			</div>
			<h2 class="text-sm font-medium text-foreground">Agents ({agents.length})</h2>
		</Inline>
		<p class="max-w-xl text-xs leading-relaxed text-muted-foreground">
			An agent, the channels it is reached on, and the tools it may call — read together, because
			none of the three means anything on its own.
		</p>

		{#if agents.length === 0}
			<Stack gap="sm" align="center" justify="center" class="py-12 text-muted-foreground">
				<ProductIcon name="agent" class="size-8 opacity-30" />
				<p class="text-xs">No agents declared</p>
			</Stack>
		{:else}
			<Stack gap="sm">
				{#each agents as agent (agent.name)}
					<Stack
						gap="md"
						class="rounded-lg border border-border/60 bg-card p-4 shadow-card"
						data-testid="studio-agent-card"
					>
						<Inline align="start" justify="between" gap="sm">
							<Inline gap="sm" class="min-w-0">
								<div
									class={cn(
										'flex size-6 shrink-0 items-center justify-center rounded-md border',
										AGENT_STYLES.iconWrapperClass
									)}
								>
									<ProductIcon name="agent" class={cn('size-3.5', AGENT_STYLES.iconClass)} />
								</div>
								<div class="min-w-0">
									<p class="truncate font-mono text-sm font-semibold text-foreground">
										{agent.name}
									</p>
									<p class="text-meta">
										Workspace agent. The manifest projects its name and nothing else — its prompt
										and skills never reach a reader.
									</p>
								</div>
							</Inline>
							<span
								class="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-tiny font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
							>
								Declared
							</span>
						</Inline>

						<Stack as="section" gap="sm">
							<Inline gap="sm" align="center" class="min-h-7">
								{@render sectionHeading('Channels', agent.channels.length)}
								{#if agent.channels.length > 0}
									<Button
										type="button"
										size="sm"
										variant="ghost"
										class="ml-auto h-6 shrink-0 gap-1 px-2 text-micro"
										disabled={connections.pending}
										onclick={() => void readConnections()}
									>
										<Icon icon="lucide:refresh-cw" class="size-3" />
										Re-read status
									</Button>
								{/if}
							</Inline>
							{#if agent.channels.length === 0}
								<p class="text-meta">
									No channel is declared for this agent, so it is reachable only through the
									runtime's own agent commands.
								</p>
							{:else}
								<Stack gap="none" class="divide-y divide-border/50 border-y border-border/50">
									{#each agent.channels as channel (channel.name)}
										{@const status = connections.reads[channel.name]}
										{@const failure = connections.failures[channel.name]}
										<Inline as="article" gap="sm" align="start" class="px-1 py-2">
											<Icon
												icon="lucide:radio"
												class="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
											/>
											<Stack gap="none" grow class="min-w-0">
												<Inline gap="sm" align="center">
													<span class="truncate font-mono text-xs font-medium text-foreground">
														{channel.name}
													</span>
													{@render connectionChip(channel.name)}
												</Inline>
												<span class="text-micro text-muted-foreground">
													{#if failure !== undefined}
														{failure}
													{:else if status === undefined}
														The runtime has not been asked yet.
													{:else}
														{status.received} received · {status.replied} replied · transport not reported
													{/if}
												</span>
											</Stack>
											{#if channel.sourcePath !== undefined}
												<button
													type="button"
													class="flex shrink-0 items-center gap-1 text-micro text-brand hover:underline"
													onclick={() => onopenSource?.(channel.sourcePath ?? '')}
												>
													<Icon icon="lucide:arrow-right-circle" class="size-3" />
													View source
												</button>
											{/if}
										</Inline>
									{/each}
								</Stack>
								<p class="max-w-3xl text-micro leading-relaxed text-amber-500" role="status">
									{CHANNEL_CONNECTION_UNREPORTABLE}
								</p>
							{/if}
						</Stack>

						<Stack as="section" gap="sm">
							{@render sectionHeading('Custom tools', agent.tools.length)}
							{#if agent.tools.length === 0}
								<p class="max-w-3xl text-xs leading-relaxed text-muted-foreground">None.</p>
							{:else}
								<Stack gap="none" class="divide-y divide-border/50 border-y border-border/50">
									{#each agent.tools as tool (tool.name)}
										<Inline as="article" gap="sm" align="start" class="px-1 py-2">
											<Icon
												icon="lucide:wrench"
												class="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
											/>
											<Stack gap="none" grow class="min-w-0">
												<span class="truncate font-mono text-xs font-medium text-foreground">
													{tool.name}
												</span>
												<span class="truncate font-mono text-micro text-muted-foreground">
													{tool.sourcePath}
												</span>
											</Stack>
											<button
												type="button"
												class="flex shrink-0 items-center gap-1 text-micro text-brand hover:underline"
												onclick={() => onopenSource?.(tool.sourcePath)}
											>
												<Icon icon="lucide:arrow-right-circle" class="size-3" />
												View source
											</button>
										</Inline>
									{/each}
								</Stack>
								<p class="max-w-3xl text-micro leading-relaxed text-muted-foreground">
									The compiler names a tool after its file and replaces the description its author
									wrote, so the filename is the whole of what can be said about one here.
								</p>
							{/if}
						</Stack>

						<p class="max-w-3xl text-micro leading-relaxed text-muted-foreground">
							{AGENT_BINDING_NOTE}
						</p>
					</Stack>
				{/each}
			</Stack>
		{/if}
	</Stack>
</Scroll>
