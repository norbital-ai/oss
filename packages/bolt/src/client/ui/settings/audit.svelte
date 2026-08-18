<script lang="ts">
	import { Cluster, Stack } from '@norbital-ai/ui/layout';
	import { sortAudit, type AuditRow } from './rows.js';

	let {
		events = [],
		busy = false
	}: {
		events?: ReadonlyArray<AuditRow>;
		busy?: boolean;
	} = $props();

	const ordered = $derived(sortAudit(events));
	/**
	 * Renders a wire timestamp in the reader's own locale, falling back to the raw string.
	 *
	 * An audit entry whose timestamp cannot be parsed still has to say when it claims to have
	 * happened — printing "Invalid Date" would destroy the only evidence the row carries.
	 */
	const formatAt = (value: string): string => {
		const at = Date.parse(value);
		return Number.isNaN(at) ? value : new Date(at).toLocaleString();
	};
</script>

<Stack as="section" gap="md" aria-busy={busy}>
	<Stack as="header" gap="xs">
		<h2 class="text-lg font-semibold">Audit log</h2>
		<p class="text-sm text-muted-foreground">
			Every change to who can reach this workspace, most recent first.
		</p>
	</Stack>
	{#if ordered.length === 0}
		<div class="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
			No access changes recorded.
		</div>
	{:else}
		<!--
			A log is one list, not one card per line: the entries are read as a sequence, and giving
			each its own bordered card is the density the configurable sections above use because
			each of those is separately actionable. Nothing here is.
		-->
		<Stack as="ol" gap="none" aria-label="Audit log" class="m-0 list-none divide-y rounded-lg border bg-card p-0">
			{#each ordered as event (event.id)}
				<Cluster as="li" gap="md" align="baseline" justify="between" class="px-4 py-3">
					<Stack gap="xs">
						<span class="text-sm text-foreground" data-testid="audit-action">
							{event.action}{#if event.subject} · {event.subject}{/if}
						</span>
						<span class="text-xs text-muted-foreground">{event.actor}</span>
					</Stack>
					<time class="text-xs text-muted-foreground" datetime={event.at}>{formatAt(event.at)}</time>
				</Cluster>
			{/each}
		</Stack>
	{/if}
</Stack>
