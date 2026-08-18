<script lang="ts">
	import { Button } from '@norbital-ai/ui/button';
	import { Cluster, Inline } from '@norbital-ai/ui/layout';

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

{#if message && !dismissed}
	<Inline
		justify="end"
		class={fixed
			? 'pointer-events-none fixed inset-x-4 top-[calc(3.25rem+env(safe-area-inset-top)+1rem)] z-50 sm:inset-x-auto sm:top-6 sm:right-6 sm:w-[min(34rem,calc(100vw-3rem))]'
			: ''}
	>
		<Cluster
			gap="sm"
			class="pointer-events-auto w-full rounded-lg border border-border bg-card p-3 text-card-foreground shadow-lg {level ===
			'warning'
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
				<p class="mt-1 text-xs text-muted-foreground">{message}</p>
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
{/if}
