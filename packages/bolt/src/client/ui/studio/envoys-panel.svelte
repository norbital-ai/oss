<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '@iconify/svelte';
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { ProductIcon } from '@norbital-ai/ui/product-icon';
	import { FEATURE_COLOR_STYLES } from '@norbital-ai/ui/feature-colors';
	import { cn } from '@norbital-ai/ui/utils';
	import {
		ENVOY_CONNECTION_UNREPORTABLE,
		type StudioEnvoy,
		type StudioTool
	} from '#lib/client/ui/studio/studio-state.js';
	import type { SystemClientApi } from '#lib/client/system-client.js';

	/**
	 * Envoys, and the tools this workspace authored, on a single page.
	 *
	 * **This used to be an assembly job and is not one any more.** It merged agents, channels and
	 * tools into one tree because none of the three meant anything alone — and the tree always had
	 * exactly one node at the top, the agent the compiler synthesized, with every channel and every
	 * tool hung beneath it. An envoy *is* an agent on a transport, so the row is the envoy and there
	 * is nothing above it to assemble.
	 *
	 * Tools moved out from under it rather than moving with it, and that is the substantive change.
	 * A tool reaches a turn when a **policy** the subject holds names it, so "whose tool is this" has
	 * no single answer, and hanging it under an agent asserted one. They are listed as what they are:
	 * what this workspace authored, granted elsewhere.
	 *
	 * The status column is the honest one, and the honesty rule is kept verbatim. `envoys.status`
	 * reports traffic receipts; it says nothing about the host's transport connection and nothing
	 * about which sender addresses are linked to identities. The chip therefore describes the read,
	 * while the note under the list says what was not checked.
	 */
	let {
		envoys = [],
		tools = [],
		system,
		onopenSource
	}: {
		envoys?: ReadonlyArray<StudioEnvoy>;
		tools?: ReadonlyArray<StudioTool>;
		system: SystemClientApi;
		onopenSource?: ((path: string) => void) | undefined;
	} = $props();
	const agentStyles = $derived(FEATURE_COLOR_STYLES.agents);
	let browserReady = $state(false);
	onMount(() => {
		browserReady = true;
	});

	const connectionQueries = $derived(
		browserReady
			? envoys.map((envoy) => ({
					name: envoy.name,
					query: system.envoys.status({ envoy: envoy.name })
				}))
			: []
	);
	const connectionQuery = (envoy: string) =>
		connectionQueries.find(({ name }) => name === envoy)?.query;

	// The read starts at the browser lifecycle boundary: server rendering must not issue a Bolt
	// command, and a reader who opens Envoys has already asked the question the read answers.
</script>

{#snippet sectionHeading(label: string, count: number)}
	<h3 class="text-overline">
		{label} ({count})
	</h3>
{/snippet}

{#snippet connectionChip(envoy: string)}
	{@const query = connectionQuery(envoy)}
	{@const failure = query?.error}
	{@const status = query?.current}
	<span
		class={cn(
			'shrink-0 rounded-full px-2 py-0.5 text-tiny font-semibold',
			failure !== undefined
				? 'bg-destructive/10 text-destructive'
				: status === undefined
					? 'bg-muted text-muted-foreground'
					: 'bg-primary/10 text-primary'
		)}
		data-testid="studio-envoy-connection"
		data-envoy={envoy}
		role="status"
	>
		{failure !== undefined
			? 'Status unavailable'
			: status === undefined
				? query?.loading
					? 'Reading…'
					: 'Not read'
				: 'Traffic read'}
	</span>
{/snippet}

<Scroll name="Envoys panel" class="p-4 sm:p-6">
	<Stack gap="md">
		<Inline gap="sm">
			<div
				class={cn(
					'flex size-6 items-center justify-center rounded-md border',
					agentStyles.iconWrapperClass
				)}
			>
				<ProductIcon name="agent" class={cn('size-3.5', agentStyles.iconClass)} />
			</div>
			<h2 class="text-sm font-medium text-foreground">Envoys ({envoys.length})</h2>
		</Inline>
		<p class="max-w-xl text-xs leading-relaxed text-muted-foreground">
			An agent this workspace exposes on a transport, with its own identity and its own declared
			policies. Pairing connects the transport; sender registration is a separate, per-person proof
			of a messaging address.
		</p>

		{#if envoys.length === 0}
			<Stack gap="sm" align="center" justify="center" class="py-12 text-muted-foreground">
				<ProductIcon name="agent" class="size-8 opacity-30" />
				<p class="text-xs">No envoys declared</p>
			</Stack>
		{:else}
			<Inline gap="sm" align="center" class="min-h-7">
				{@render sectionHeading('Declared', envoys.length)}
			</Inline>
			<Stack gap="sm">
				{#each envoys as envoy (envoy.name)}
					{@const query = connectionQuery(envoy.name)}
					{@const status = query?.current}
					{@const failure = query?.error}
					<Stack
						gap="sm"
						class="rounded-lg border border-border/60 bg-card p-4 shadow-card"
						data-testid="studio-envoy-card"
					>
						<Inline align="start" justify="between" gap="sm">
							<Inline gap="sm" class="min-w-0">
								<div
									class={cn(
										'flex size-6 shrink-0 items-center justify-center rounded-md border',
										agentStyles.iconWrapperClass
									)}
								>
									<ProductIcon name="agent" class={cn('size-3.5', agentStyles.iconClass)} />
								</div>
								<div class="min-w-0">
									<p class="truncate font-mono text-sm font-semibold text-foreground">
										{envoy.name}
									</p>
									<p class="text-meta">
										{envoy.transport} ·
										{envoy.audience === 'public'
											? 'anyone who can reach the transport'
											: 'senders matched to a workspace account'}
									</p>
								</div>
							</Inline>
							{@render connectionChip(envoy.name)}
						</Inline>
						<Inline gap="sm" align="center" class="min-w-0">
							<span class="text-micro text-muted-foreground">
								{#if failure !== undefined}
									{failure instanceof Error ? failure.message : String(failure)}
								{:else if status === undefined}
									The runtime has not been asked yet.
								{:else}
									{status.received} received · {status.replied} replied · transport not reported
								{/if}
							</span>
							{#if envoy.sourcePath !== undefined}
								<button
									type="button"
									class="ml-auto shrink-0 text-micro text-brand hover:underline"
									onclick={() => onopenSource?.(envoy.sourcePath ?? '')}
								>
									<Inline as="span" gap="xs">
										<Icon icon="lucide:arrow-right-circle" class="size-3" />
										View source
									</Inline>
								</button>
							{/if}
						</Inline>
					</Stack>
				{/each}
			</Stack>
			<p class="max-w-3xl text-micro leading-relaxed text-amber-500" role="status">
				{ENVOY_CONNECTION_UNREPORTABLE}
			</p>
		{/if}

		<Stack as="section" gap="sm" class="border-t pt-4">
			{@render sectionHeading('Workspace tools', tools.length)}
			<p class="max-w-xl text-xs leading-relaxed text-muted-foreground">
				Listed here, granted elsewhere. A tool reaches a turn when a policy the subject holds names
				it under <code>capabilities.tools</code> — so authoring one offers it to nobody until a policy
				says so, and there is no agent it belongs to.
			</p>
			{#if tools.length === 0}
				<p class="max-w-3xl text-xs leading-relaxed text-muted-foreground">None.</p>
			{:else}
				<Stack gap="none" class="divide-y divide-border/50 border-y border-border/50">
					{#each tools as tool (tool.name)}
						<Inline as="article" gap="sm" align="start" class="px-1 py-2">
							<Icon icon="lucide:wrench" class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
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
								class="shrink-0 text-micro text-brand hover:underline"
								onclick={() => onopenSource?.(tool.sourcePath)}
							>
								<Inline as="span" gap="xs">
									<Icon icon="lucide:arrow-right-circle" class="size-3" />
									View source
								</Inline>
							</button>
						</Inline>
					{/each}
				</Stack>
				<p class="max-w-3xl text-micro leading-relaxed text-muted-foreground">
					The compiler names a tool after its file and replaces the description its author wrote, so
					the filename is the whole of what can be said about one here.
				</p>
			{/if}
		</Stack>
	</Stack>
</Scroll>
