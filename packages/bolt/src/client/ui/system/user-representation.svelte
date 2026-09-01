<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Grid, Inline, Stack } from '@norbital-ai/ui/layout';

	let { record }: { record: Record<string, unknown> | null; close: () => void } = $props();
	const text = (name: string): string | undefined => {
		const value = record?.[name];
		return typeof value === 'string' && value.trim() !== '' ? value : undefined;
	};
	const name = $derived(text('name') ?? text('email') ?? 'Workspace member');
	const initials = $derived(
		name
			.split(/\s+/u)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase())
			.join('') || '?'
	);
	const team = $derived(text('team') ?? text('team_name') ?? text('team_id'));
</script>

<Stack gap="lg" class="p-5">
	<Inline gap="md" align="center">
		<div
			class="flex size-12 shrink-0 items-center justify-center rounded-full bg-brand/10 text-sm font-bold text-brand"
		>
			{initials}
		</div>
		<Stack gap="xs" class="min-w-0">
			<p class="truncate text-base font-semibold text-foreground">{name}</p>
			<p class="truncate text-sm text-muted-foreground">{text('email') ?? 'No email recorded'}</p>
		</Stack>
	</Inline>

	<Stack gap="sm">
		<h3 class="text-sm font-semibold text-foreground">Access and membership</h3>
		<Grid as="dl" gap="md" tracks="minmax(7rem,auto) minmax(0,1fr)" class="text-sm">
			<dt class="text-muted-foreground">
				<Inline align="center" gap="sm">
				<Icon icon="lucide:shield-check" class="size-4" /> Role
				</Inline>
			</dt>
			<dd class="capitalize text-foreground">{text('role') ?? text('access') ?? 'Member'}</dd>
			<dt class="text-muted-foreground">
				<Inline align="center" gap="sm">
				<Icon icon="lucide:circle-dot" class="size-4" /> Status
				</Inline>
			</dt>
			<dd class="capitalize text-foreground">{text('status') ?? 'Active'}</dd>
			<dt class="text-muted-foreground">
				<Inline align="center" gap="sm">
				<Icon icon="lucide:users" class="size-4" /> Team
				</Inline>
			</dt>
			<dd class="text-foreground">{team ?? 'Not assigned'}</dd>
		</Grid>
	</Stack>

	<Stack gap="xs" class="rounded-lg border bg-muted/30 p-4">
		<p class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Identity</p>
		<p class="break-all font-mono text-xs text-foreground">{text('id') ?? 'No identifier'}</p>
	</Stack>
</Stack>
