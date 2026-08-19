<script lang="ts">
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { ProductIcon } from '@norbital-ai/ui/product-icon';
	import { cn } from '@norbital-ai/ui/utils';
	import type { EnvironmentVariable, ManifestSection } from './studio-state.js';

	/**
	 * The environment this workspace declares in its root `+env.ts`.
	 *
	 * Names and whether each is configured, never a value. `secrets.status` is the only surface a
	 * browser has onto the vault — there is deliberately no read command — so this page cannot show
	 * a value even by mistake, and it does not pretend to by rendering a masked placeholder. The
	 * Value column the manifest's own environment panel carries is therefore a Status column here:
	 * showing an empty Value cell for every row would read as "the vault is empty".
	 *
	 * The read is the shell's, not this pane's: the navigator needs the same answer to count the
	 * Environment branch, and one vault read serving both is what keeps the count and the list from
	 * disagreeing.
	 */
	let {
		section,
		entries = [],
		failure
	}: {
		section: ManifestSection;
		entries?: ReadonlyArray<EnvironmentVariable>;
		failure?: string | undefined;
	} = $props();

	const missing = $derived(entries.filter((entry) => !entry.configured).length);
</script>

<Scroll name="Environment panel" class="p-4 sm:p-6">
	<Stack gap="md">
		<Inline gap="sm">
			<ProductIcon name={section.icon} class="size-4 text-muted-foreground" />
			<div>
				<h2 class="text-sm font-medium text-foreground">{section.label} ({entries.length})</h2>
				<p class="mt-0.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
					{section.summary}
				</p>
			</div>
		</Inline>

		{#if failure !== undefined}
			<p class="text-xs text-destructive" role="alert">Vault status unavailable: {failure}</p>
		{:else if entries.length === 0}
			<Stack gap="sm" align="center" justify="center" class="py-12 text-muted-foreground">
				<ProductIcon name={section.icon} class="size-8 opacity-30" />
				<p class="text-xs">No runtime configuration defined</p>
			</Stack>
		{:else}
			<div class="rounded-lg border border-border/60 bg-card shadow-card">
				<h3 class="text-overline border-b border-border/60 px-4 py-2.5">
					Declared names ({entries.length}) · {missing} not set
				</h3>
				<!-- stupidity:allow UI3 -- compact manifest key/status matrix is not record data -->
				<table class="w-full text-left">
					<thead class="border-b border-border/40">
						<tr class="text-overline">
							<th class="px-4 py-2 font-medium">Key</th>
							<th class="px-4 py-2 font-medium">Status</th>
							<th class="px-4 py-2 font-medium">Declared as</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-border/30">
						{#each entries as entry (entry.name)}
							<tr class="text-xs hover:bg-accent/30">
								<td class="px-4 py-2 font-mono font-medium text-foreground">{entry.name}</td>
								<td class="px-4 py-2">
									<span
										class={cn(
											'rounded-full px-2 py-0.5 text-tiny font-semibold',
											entry.configured
												? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
												: 'bg-muted text-muted-foreground'
										)}
									>
										{entry.configured ? 'Set' : 'Not set'}
									</span>
								</td>
								<td class="max-w-xs px-4 py-2 text-muted-foreground">
									<span class="block truncate">{entry.label}</span>
									{#if entry.description !== undefined}
										<span class="block truncate text-micro">{entry.description}</span>
									{:else if !entry.configured && entry.default !== undefined}
										<span class="block truncate font-mono text-micro">
											falls back to {entry.default}
										</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="max-w-2xl text-micro leading-relaxed text-muted-foreground">
				Values live in the vault and are readable only by server-side code — this host exposes no
				read command, so a value cannot appear here even by mistake.
			</p>
		{/if}
	</Stack>
</Scroll>
