<script lang="ts">
	import { Button } from '@norbital-ai/ui/button';
	import { Cluster, Imposter, Inline } from '@norbital-ai/ui/layout';

	let {
		message = '',
		level = 'notice',
		actionLabel,
		dismissible = false,
		fixed = false,
		onaction
	}: {
		message?: string;
		level?: 'notice' | 'warning' | 'critical';
		actionLabel?: string;
		dismissible?: boolean;
		fixed?: boolean;
		onaction?: () => void;
	} = $props();
	let dismissed = $state(false);
</script>

{#snippet notice()}
	<Inline justify="end">
		<Cluster
			gap="sm"
			class="pointer-events-auto w-full rounded-lg border border-border bg-card p-3 text-card-foreground shadow-lg {fixed
				? 'sm:max-w-[34rem]'
				: ''} {level === 'warning'
				? 'border-warning'
				: level === 'critical'
					? 'border-destructive'
					: ''}"
			aria-label="Billing notice"
			data-level={level}
		>
			<div class="min-w-0 flex-1">
				<strong class="text-sm text-foreground">
					{level === 'critical' ? 'Billing action required' : 'Billing notice'}
				</strong>
				<p class="mt-1 text-meta">{message}</p>
			</div>
			<Cluster gap="xs">
				{#if actionLabel && onaction}
					<Button type="button" size="sm" variant="outline" onclick={onaction}>{actionLabel}</Button
					>
				{/if}
				{#if dismissible}
					<Button
						type="button"
						size="sm"
						variant="ghost"
						aria-label="Dismiss billing notice"
						onclick={() => (dismissed = true)}
					>
						Dismiss
					</Button>
				{/if}
			</Cluster>
		</Cluster>
	</Inline>
{/snippet}

{#if message && !dismissed}
	{#if fixed}
		<!-- Viewport-pinned above the workspace chrome. -->
		<Imposter
			position="fixed"
			layer="modal"
			placement="top"
			class="pointer-events-none px-4 pt-[calc(3.25rem+env(safe-area-inset-top)+1rem)] sm:px-6 sm:pt-6"
		>
			{@render notice()}
		</Imposter>
	{:else}
		{@render notice()}
	{/if}
{/if}
