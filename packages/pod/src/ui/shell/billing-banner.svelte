<script lang="ts">
	import Icon from '@iconify/svelte';
	import type { WorkspaceBillingSummary } from '@norbital-ai/platform-utils/runtime/binding';
	import { Button } from '@norbital-ai/ui/button';
	import { Inline, Cluster } from '@norbital-ai/ui/layout';
	import { onDestroy, onMount } from 'svelte';

	let {
		billing,
		isAdmin,
		billingHref,
		navigate
	}: {
		billing?: WorkspaceBillingSummary;
		isAdmin: boolean;
		billingHref: string | null;
		navigate: (href: string) => void;
	} = $props();

	let dismissed = $state(false);
	let resolvedBilling = $state<WorkspaceBillingSummary>();
	let reappearTimer: ReturnType<typeof setTimeout> | undefined;

	const notice = $derived.by(() => {
		if (!resolvedBilling) return null;

		if (
			['past_due', 'unpaid', 'incomplete', 'incomplete_expired'].includes(resolvedBilling.status)
		) {
			return {
				message: 'Your billing needs attention. Update your payment details to resolve it.',
				action: 'Manage billing'
			};
		}
		if (resolvedBilling.hasPaymentMethod) return null;
		if (resolvedBilling.status === 'trialing' && resolvedBilling.currentPeriodEnd) {
			const trialEnd = new Date(resolvedBilling.currentPeriodEnd).toLocaleDateString(undefined, {
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

	onMount(() => {
		if (billing) {
			resolvedBilling = billing;
			return;
		}
		void fetch('/api/billing/workspace-summary', { credentials: 'include' })
			.then(async (response) => {
				if (!response.ok) return;
				resolvedBilling = (await response.json()) as WorkspaceBillingSummary;
			})
			.catch(() => undefined);
	});

	onDestroy(() => clearTimeout(reappearTimer));
</script>

{#if notice && !dismissed}
	<!-- stupidity:allow UI15 -- viewport-fixed toast; keep offsets explicit so mobile safe-area and desktop chrome clear -->
	<Inline
		justify="end"
		class="pointer-events-none fixed inset-x-4 top-[calc(3.25rem+env(safe-area-inset-top)+1rem)] z-50 sm:inset-x-auto sm:top-6 sm:right-6 sm:w-[min(34rem,calc(100vw-3rem))]"
	>
		<Cluster
			gap="sm"
			class="pointer-events-auto rounded-lg border border-border bg-popover p-2.5 text-sm text-foreground shadow-md"
			role="status"
			aria-live="polite"
		>
			<div
				class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
			>
				<Icon icon="lucide:credit-card" class="size-4" aria-hidden="true" />
			</div>
			<p class="min-w-0 flex-1 leading-5">{notice.message}</p>
			{#if isAdmin && billingHref}
				<Button
					type="button"
					variant="outline"
					size="sm"
					class="w-fit shrink-0"
					onclick={() => navigate(billingHref)}
				>
					{notice.action}
				</Button>
			{/if}
			<Button
				type="button"
				variant="ghost"
				size="icon"
				class="size-7 shrink-0 text-muted-foreground"
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
		</Cluster>
	</Inline>
{/if}
