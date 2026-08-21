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
		ENVOY_CONNECTION_UNREPORTABLE,
		EnvoyStatusSchema,
		type EnvoyStatus,
		type StudioEnvoy,
		type StudioTool
	} from './studio-state.js';

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
	 * The connection column is the honest one, and the honesty rule is kept verbatim. `envoys.status`
	 * is the only thing the runtime will say about an envoy, and `registered` in it means "someone
	 * called `envoys.register`", not "the transport is up". So a registered envoy is reported as
	 * registered and never as connected, and the note under the list says what was not checked
	 * rather than leaving a green dot to imply it was.
	 */
	let {
		envoys = [],
		tools = [],
		command,
		onopenSource
	}: {
		envoys?: ReadonlyArray<StudioEnvoy>;
		tools?: ReadonlyArray<StudioTool>;
		command: (name: string, input: Readonly<Record<string, string>>) => Promise<unknown>;
		onopenSource?: ((path: string) => void) | undefined;
	} = $props();

	/**
	 * Every envoy's last read, held as one cell.
	 *
	 * A read either lands or fails per envoy, and both halves plus the in-flight flag change on the
	 * same click — three independent cells only made a single refresh three writes.
	 */
	let connections = $state<{
		readonly reads: Readonly<Record<string, EnvoyStatus>>;
		readonly failures: Readonly<Record<string, string>>;
		readonly pending: boolean;
	}>({ reads: {}, failures: {}, pending: false });

	/** Reads every envoy's status in one pass, so the list is never half-answered. */
	const readConnections = async (): Promise<void> => {
		connections = { ...connections, pending: true };
		const results = await Promise.all(
			envoys.map(async ({ name }) => {
				try {
					return {
						envoy: name,
						status: await Effect.runPromise(
							Schema.decodeUnknownEffect(EnvoyStatusSchema)(
								await command('envoys.status', { envoy: name })
							)
						)
					};
				} catch (cause) {
					return { envoy: name, failure: cause instanceof Error ? cause.message : String(cause) };
				}
			})
		);
		connections = {
			reads: Object.fromEntries(
				results.flatMap((result) => ('status' in result ? [[result.envoy, result.status]] : []))
			) as Readonly<Record<string, EnvoyStatus>>,
			failures: Object.fromEntries(
				results.flatMap((result) => ('failure' in result ? [[result.envoy, result.failure]] : []))
			) as Readonly<Record<string, string>>,
			pending: false
		};
	};

	// The read is the browser's: server rendering must not issue a Bolt command, and a reader who
	// opens Envoys has already asked the question the read answers.
	onMount(() => {
		if (envoys.length > 0) void readConnections();
	});
</script>

{#snippet sectionHeading(label: string, count: number)}
	<h3 class="text-overline">
		{label} ({count})
	</h3>
{/snippet}

{#snippet connectionChip(envoy: string)}
	{@const failure = connections.failures[envoy]}
	{@const status = connections.reads[envoy]}
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
		data-testid="studio-envoy-connection"
		data-envoy={envoy}
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

<Scroll name="Envoys panel" class="p-4 sm:p-6">
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
			<h2 class="text-sm font-medium text-foreground">Envoys ({envoys.length})</h2>
		</Inline>
		<p class="max-w-xl text-xs leading-relaxed text-muted-foreground">
			An agent this workspace exposes on a transport, with its own identity and its own declared
			policies. What it may do is those policies; this page is where it is reached.
		</p>

		{#if envoys.length === 0}
			<Stack gap="sm" align="center" justify="center" class="py-12 text-muted-foreground">
				<ProductIcon name="agent" class="size-8 opacity-30" />
				<p class="text-xs">No envoys declared</p>
			</Stack>
		{:else}
			<Inline gap="sm" align="center" class="min-h-7">
				{@render sectionHeading('Declared', envoys.length)}
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
			</Inline>
			<Stack gap="sm">
				{#each envoys as envoy (envoy.name)}
					{@const status = connections.reads[envoy.name]}
					{@const failure = connections.failures[envoy.name]}
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
										AGENT_STYLES.iconWrapperClass
									)}
								>
									<ProductIcon name="agent" class={cn('size-3.5', AGENT_STYLES.iconClass)} />
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
									{failure}
								{:else if status === undefined}
									The runtime has not been asked yet.
								{:else}
									{status.received} received · {status.replied} replied · transport not reported
								{/if}
							</span>
							{#if envoy.sourcePath !== undefined}
								<button
									type="button"
									class="ml-auto flex shrink-0 items-center gap-1 text-micro text-brand hover:underline"
									onclick={() => onopenSource?.(envoy.sourcePath ?? '')}
								>
									<Icon icon="lucide:arrow-right-circle" class="size-3" />
									View source
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
				it under <code>capabilities.tools</code> — so authoring one offers it to nobody until a
				policy says so, and there is no agent it belongs to.
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
					The compiler names a tool after its file and replaces the description its author wrote, so
					the filename is the whole of what can be said about one here.
				</p>
			{/if}
		</Stack>
	</Stack>
</Scroll>
