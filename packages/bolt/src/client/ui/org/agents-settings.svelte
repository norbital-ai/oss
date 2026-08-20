<script lang="ts">
	import { onMount } from 'svelte';
	import { Bound, Cluster, Cover, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { workspaceSession } from '../../session.js';
	import ChannelPairing from './channel-pairing.svelte';

	/**
	 * The Agents surface: who answers in this workspace, and on which channels each one is reachable.
	 *
	 * A channel here is a way to reach an agent — Telegram, WhatsApp, the in-app agent. It is not a
	 * collection's integration, which syncs records for one collection and lives under that
	 * collection's own tab in Workspace Studio. The two were previously shown together and read as
	 * one thing; keeping them on separate surfaces is what stops that.
	 *
	 * Every state on this page is one the runtime actually published. `workspace.manifest` names the
	 * agents and the channels, `channels.status` reports each channel's registration and traffic, and
	 * where a command answers with neither — a failure, or a field the projection never carried — the
	 * page says so rather than filling the gap with a default that would read as "connected".
	 *
	 */
	/**
	 * The transport is the session's, named rather than reached for.
	 *
	 * It used to arrive as a `command` prop the host shell threaded down, which was correct while the
	 * host owned the shell. The workspace client owns it now, and one declared session is what every
	 * surface reads — a second channel handed down beside it would be two ways to say the same thing.
	 */
	const { transport } = workspaceSession();

	/** Exactly the projection `workspace.manifest` publishes for a channel. */
	type DeclaredChannel = {
		readonly name: string;
		readonly agent: string;
		readonly transport: string;
		readonly audience: string;
	};
	/** Exactly what `channels.status` returns. */
	type ChannelStatus = {
		readonly channel: string;
		readonly registered: boolean;
		readonly received: number;
		readonly replied: number;
	};

	let agents = $state<ReadonlyArray<string>>([]);
	let channels = $state<ReadonlyArray<DeclaredChannel>>([]);
	let statuses = $state<Record<string, ChannelStatus>>({});
	// Kept beside the statuses rather than folded into them: a channel whose status could not be read
	// has no registration state at all, and a record that can hold both would let the page render a
	// `registered: false` it never received.
	let statusErrors = $state<Record<string, string>>({});
	let loading = $state(true);
	let error = $state<string | null>(null);
	let activeTab = $state('channels');

	/**
	 * How long one status read may take before this page says so.
	 *
	 * Not a preference, and not defensive decoration. `transport.command` is a bare `fetch` with no
	 * timeout of its own (`browser-transport.ts`), and the reads below were awaited with no signal —
	 * so a command that never settled left its card reading "Checking" indefinitely, reporting
	 * neither a status nor a failure. That is the one outcome this surface's whole premise forbids:
	 * a state the runtime never published, rendered as though it had. A bound does not fix whatever
	 * stalled upstream; it makes the stall say its own name instead of impersonating a slow page.
	 */
	const STATUS_DEADLINE_MS = 15_000;

	/**
	 * A channel names the agent that answers on it, and the manifest now carries that binding, so the
	 * page groups by it rather than inferring it from there being only one agent to infer.
	 */
	const channelsByAgent = $derived.by(() => {
		const grouped = new Map<string, Array<DeclaredChannel>>(agents.map((agent) => [agent, []]));
		for (const declared of channels) {
			grouped.set(declared.agent, [...(grouped.get(declared.agent) ?? []), declared]);
		}
		return grouped;
	});

	/** One array off an untyped command response, or nothing when the key is absent or not a list. */
	const rowsOf = (value: unknown, key: string): ReadonlyArray<unknown> => {
		if (value === null || typeof value !== 'object') return [];
		const rows = Reflect.get(value, key);
		return Array.isArray(rows) ? rows : [];
	};

	/** One string field off an untyped row, or nothing when it is absent or not a string. */
	const stringOf = (value: unknown, key: string): string | undefined => {
		if (value === null || typeof value !== 'object') return undefined;
		const field = Reflect.get(value, key);
		return typeof field === 'string' && field.length > 0 ? field : undefined;
	};

	/**
	 * Reads the workspace's agents and channels, then each channel's connection state.
	 *
	 * The manifest is read field by field rather than asserted with a cast. `command` answers
	 * `unknown`, and the channel projection is a hand-built object literal in `dispatch.ts` rather
	 * than a schema the wire enforces — so a cast would let a projection that stopped carrying
	 * `transport` or `audience` render the word "undefined" onto a page whose whole premise is that
	 * it states only what the runtime actually published. A channel missing a field is dropped.
	 *
	 * The statuses are fetched together rather than in sequence: they are independent reads, and one
	 * slow channel should not hold up the rest of the list. Each writes its own key, so a failure
	 * lands against the channel it belongs to instead of failing the page.
	 */
	const load = async (): Promise<void> => {
		loading = true;
		error = null;
		try {
			const summary = await transport.command('workspace.manifest', {});
			agents = rowsOf(summary, 'agents').flatMap((entry) => {
				const name = stringOf(entry, 'name');
				return name === undefined ? [] : [name];
			});
			channels = rowsOf(summary, 'channels').flatMap((entry) => {
				const name = stringOf(entry, 'name');
				const agent = stringOf(entry, 'agent');
				const transport = stringOf(entry, 'transport');
				const audience = stringOf(entry, 'audience');
				return name === undefined ||
					agent === undefined ||
					transport === undefined ||
					audience === undefined
					? []
					: [{ name, agent, transport, audience }];
			});
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Unable to read the workspace manifest.';
			loading = false;
			return;
		}
		loading = false;
		await Promise.all(channels.map(({ name }) => readStatus(name)));
	};

	/**
	 * One channel's connection state, or the reason there is none, inside the deadline.
	 *
	 * The signal is handed to the command rather than raced beside it, so a read this page has
	 * stopped waiting for also stops costing a request — a race would leave the fetch running
	 * unobserved behind a card that already reported it as unanswered.
	 *
	 * A timeout is reported as a timeout and not as whatever `AbortSignal` happens to name its
	 * reason. The distinction matters to whoever reads the card: "the runtime did not answer" is a
	 * fact about this workspace's runtime, while `signal timed out` is a fact about the browser and
	 * tells an operator nothing they can act on.
	 */
	const readStatus = async (channel: string): Promise<void> => {
		const deadline = AbortSignal.timeout(STATUS_DEADLINE_MS);
		try {
			statuses[channel] = (await transport.command(
				'channels.status',
				{ channel },
				deadline
			)) as ChannelStatus;
		} catch (cause) {
			statusErrors[channel] = deadline.aborted
				? `The runtime did not answer within ${Math.round(STATUS_DEADLINE_MS / 1000)}s.`
				: cause instanceof Error
					? cause.message
					: 'The runtime did not report this channel.';
		}
	};

	// The read is the browser's, as it is in `studio/agents-panel.svelte`: server rendering must not
	// issue a Bolt command, and a reader who opens Agents has already asked the question it answers.
	// It ran at component init here, which happens on the server too under any host that renders this
	// surface — `workspaceSession()` throws there rather than returning a session to command with.
	onMount(() => {
		void load();
	});
</script>

{#snippet channelEntry(declared: DeclaredChannel)}
	{@const status = statuses[declared.name]}
	{@const failure = statusErrors[declared.name]}
	<Stack as="article" gap="sm">
		<Inline align="start" justify="between" gap="md">
			<div>
				<!-- A step below the agent's own name: inside an agent's card the channel is the detail,
				     and at the same size the two read as siblings. -->
				<h4 class="text-sm font-medium">{declared.name}</h4>
				<p class="text-meta">Declared in the workspace source.</p>
			</div>
		</Inline>
		<!-- Outside the status block on purpose. The transport and the audience are declared in the
		     workspace source, so they are known whether or not `channels.status` answered; folding them
		     in would hide what the channel *is* behind a failure to read how it is *doing*. -->
		<Grid as="dl" gap="sm" minimum="compact" class="border-t pt-4 text-xs">
			<Stack gap="xs">
				<dt class="font-medium text-foreground">Transport</dt>
				<dd class="text-muted-foreground">{declared.transport}</dd>
			</Stack>
			<Stack gap="xs">
				<dt class="font-medium text-foreground">Audience</dt>
				<dd class="text-muted-foreground">
					{declared.audience === 'public'
						? 'Public — anyone who can reach the transport.'
						: declared.audience === 'authenticated'
							? 'Authenticated — senders matched to a workspace account.'
							: declared.audience}
				</dd>
			</Stack>
		</Grid>
		<!--
			Whether this channel is connected is the *host's* answer, and it is the only one shown.
			
			There used to be a second status here, taken from `channels.status.registered`, and the two
			would have contradicted each other on every card: that flag means "something once called
			`channels.register`", nothing ever does, so it read "Not registered" beside a live paired
			session. Worse, the honest fix is not to start writing it — a connection is host state, and
			a marker row in the tenant database recording that a socket was once up would be exactly
			the state this design keeps out of the tenant, and would stay true after an unpair.
			
			So the runtime is asked what only it knows — how much traffic this channel carried — and the
			host is asked what only it knows. Neither answers for the other.
		-->
		<ChannelPairing channel={declared.name} provider={declared.transport} />
		{#if failure !== undefined}
			<!-- The message is shown verbatim: an operator who sees a blank card concludes the channel is
			     idle, when the runtime in fact refused to answer for it. -->
			<p class="border-t pt-4 text-xs text-destructive">{failure}</p>
		{:else if status !== undefined}
			<Grid as="dl" gap="sm" minimum="compact" class="border-t pt-4 text-xs">
				<Stack gap="xs">
					<dt class="font-medium text-foreground">Messages received</dt>
					<dd class="text-muted-foreground">{status.received}</dd>
				</Stack>
				<Stack gap="xs">
					<dt class="font-medium text-foreground">Replies sent</dt>
					<dd class="text-muted-foreground">{status.replied}</dd>
				</Stack>
			</Grid>
		{:else}
			<p class="border-t pt-4 text-meta">Reading this channel's traffic…</p>
		{/if}
	</Stack>
{/snippet}

{#snippet channelsPanel()}
	<Stack gap="md" class="h-full min-h-0">
		{#if loading}
			<p class="text-sm text-muted-foreground">Reading the workspace manifest…</p>
		{:else if error !== null}
			<p class="text-sm text-destructive" role="alert">{error}</p>
		{:else if agents.length === 0}
			<div class="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
				This workspace declares no agents.
			</div>
		{:else if channels.length === 0}
			<!-- An empty channel list is not a broken agent list: nothing is declared yet, so the
			     agent cards (which exist to carry their channels) would only echo the workspace name
			     back with nothing under it. A dotted placeholder says what is missing instead. -->
			<div class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
				No channels declared. Author a channel in the workspace source to open one.
			</div>
		{:else}
			<Stack gap="md">
				{#each [...channelsByAgent] as [agent, agentChannels] (agent)}
					<Stack as="section" gap="md" class="rounded-lg border border-border bg-card p-4 sm:p-6">
						<Inline align="start" justify="between" gap="md">
							<div>
								<h3 class="font-medium">{agent}</h3>
								<p class="text-meta">
									{#if agentChannels.length === 0}
										No channels declared
									{:else if agentChannels.length === 1}
										Reachable on 1 channel
									{:else}
										Reachable on {agentChannels.length} channels
									{/if}
								</p>
							</div>
						</Inline>
						{#if agentChannels.length === 0}
							<p class="border-t pt-4 text-meta">
								Nothing can reach this agent yet. Author a channel in the workspace to open one.
							</p>
						{:else}
							<!-- One rule between channels rather than a nested card each: a bordered box
										     inside a bordered box reads as two levels of nesting where there is only
										     one. The first channel needs none — the wrapper's own rule already
										     divides it from the agent's name. -->
							<Stack gap="md" class="border-t pt-4">
								{#each agentChannels as declared, index (declared.name)}
									<div class={index === 0 ? '' : 'border-t pt-4'}>
										{@render channelEntry(declared)}
									</div>
								{/each}
							</Stack>
						{/if}
					</Stack>
				{/each}
			</Stack>
		{/if}
	</Stack>
{/snippet}

<!-- Root navigation follows the product's page-heading rhythm, as Workspace Studio does: title, one
     line of what the page is for, then the rail. The header sits on the background, not in a card. -->
<Cover class="relative bg-background" gap="none">
	{#snippet top()}
		<Stack gap="lg" shrink={false} class="bg-background px-4 pt-4 sm:px-6 sm:pt-6">
			<Stack as="header" gap="xs">
				<h1 class="text-heading">Agents</h1>
				<p class="max-w-2xl text-meta">
					The agents this workspace declares and the channels each one is reachable on. A
					collection's own record sync is not configured here — it belongs to the collection, under
					its tab in Workspace Studio.
				</p>
			</Stack>
			<!-- Channels is the only tab the runtime can fill today, and it is still rendered as a tab strip
			     rather than as the page body: an agent's other facets belong beside it, and a surface that
			     grows a strip later moves everything the reader had already learned to find. -->
			<Cluster gap="sm" align="center" shrink={false}>
				<Tabs
					value={activeTab}
					onValueChange={(next) => {
						activeTab = next;
					}}
					showContent={false}
					variant="default"
					layout="responsive"
					animate={false}
					class="min-w-0 flex-1 !shrink"
					listClass="mx-0 w-full"
					config={[{ name: 'channels', label: 'Channels', content: '' }] satisfies TabConfig[]}
				/>
			</Cluster>
		</Stack>
	{/snippet}

	<!-- One page gutter for the whole body, matching the tab strip's own: the same left/right padding
	     as the header, and the same top gap below the triggers that the header opens with. The pane
	     renders flush inside, so its content lines up with the strip on every axis. -->
	<Inline align="stretch" gap="none" fill class="px-4 pt-4 pb-4 sm:px-6 sm:pt-6 sm:pb-6">
		<Bound size="full" grow clip class="relative min-w-0 bg-background font-sans">
			{#if activeTab === 'channels'}
				{@render channelsPanel()}
			{/if}
		</Bound>
	</Inline>
</Cover>
