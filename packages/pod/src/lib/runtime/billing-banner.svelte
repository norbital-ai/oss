<script lang="ts">
	import Icon from '@iconify/svelte';
	import type { WorkspaceBillingSummary } from '@norbital-ai/platform-utils/runtime/binding';
	import { Button } from '@norbital-ai/ui/button';
	import { onDestroy } from 'svelte';

	let {
		billing,
		isAdmin,
		navigate
	}: {
		billing?: WorkspaceBillingSummary;
		isAdmin: boolean;
		navigate: (href: string) => void;
	} = $props();

	let dismissed = $state(false);
	let reappearTimer: ReturnType<typeof setTimeout> | undefined;

	const notice = $derived.by(() => {
		if (!billing) return null;

		if (['past_due', 'unpaid', 'incomplete', 'incomplete_expired'].includes(billing.status)) {
			return {
				message: 'Your billing needs attention. Update your payment details to resolve it.',
				action: 'Manage billing'
			};
		}
		if (billing.hasPaymentMethod) return null;
		if (billing.status === 'trialing' && billing.currentPeriodEnd) {
			const trialEnd = new Date(billing.currentPeriodEnd).toLocaleDateString(undefined, {
				day: 'numeric',
				month: 'short',
				year: 'numeric'
			});
			return {
				message: `Your free trial ends ${trialEnd}. Add a payment method to keep your workspace active.`,
				action: 'Add payment method'
			};
		}
		return {
			message: 'No payment method is on file. Add one to avoid an interruption.',
			action: 'Add payment method'
		};
	});

	onDestroy(() => clearTimeout(reappearTimer));
</script>

{#if notice && !dismissed}
	<div
		class="pointer-events-none fixed inset-x-3 top-[calc(3.25rem+env(safe-area-inset-top)+0.75rem)] z-50 flex justify-end sm:inset-x-auto sm:right-4 sm:w-[min(34rem,calc(100vw-2rem))] md:top-4"
	>
		<div
			class="pointer-events-auto grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-2 rounded-lg border border-border bg-popover p-2 text-sm text-foreground shadow-md sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]"
			role="status"
			aria-live="polite"
		>
			<div
				class="col-start-1 row-start-1 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
			>
				<Icon icon="lucide:credit-card" class="size-4" aria-hidden="true" />
			</div>
			<p class="col-start-2 row-start-1 min-w-0 leading-5">{notice.message}</p>
			{#if isAdmin}
				<Button
					type="button"
					variant="outline"
					size="sm"
					class="col-start-2 col-end-4 row-start-2 w-fit shrink-0 sm:col-start-3 sm:col-end-4 sm:row-start-1"
					onclick={() => navigate('/org-settings?section=billing')}
				>
					{notice.action}
				</Button>
			{/if}
			<Button
				type="button"
				variant="ghost"
				size="icon"
				class="col-start-3 row-start-1 size-7 shrink-0 text-muted-foreground sm:col-start-4"
				aria-label="Dismiss billing notice"
				onclick={() => {
					dismissed = true;
					const now = new Date();
					const tomorrow = new Date(now);
					tomorrow.setHours(24, 0, 0, 0);
					clearTimeout(reappearTimer);
					reappearTimer = setTimeout(() => {
						dismissed = false;
					}, tomorrow.getTime() - now.getTime());
				}}
			>
				<Icon icon="lucide:x" class="size-4" aria-hidden="true" />
			</Button>
		</div>
	</div>
{/if}
