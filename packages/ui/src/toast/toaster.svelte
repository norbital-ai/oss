<!--
@component
The page's toasts, bottom right (bottom centre on a phone, above the safe area). Mount one, in the shell.
-->
<script lang="ts">
	import Icon from '@iconify/svelte';
	import { register_control } from '../behaviors/index.js';
	import { cn, ui_text } from '../primitives/utils.js';
	import { dismiss, pause, resume, toasts, type ToastTone } from './toast.svelte.js';

	const t = ui_text();
	const ICON: { readonly [k in ToastTone]: string | null } = {
		default: null,
		success: 'lucide:circle-check',
		info: 'lucide:info',
		warning: 'lucide:triangle-alert',
		error: 'lucide:circle-x'
	};
	const TONE: { readonly [k in ToastTone]: string } = {
		default: 'border-border bg-popover text-popover-foreground',
		success: 'border-success/30 bg-popover text-success',
		info: 'border-info/30 bg-popover text-info',
		warning: 'border-tone-warning-border bg-popover text-tone-warning-text',
		error: 'border-destructive/30 bg-popover text-destructive'
	};

	$effect(() => {
		if (toasts.length === 0) return;
		return register_control({
			id: 'toaster:notifications',
			kind: 'toast',
			label: t('notifications'),
			state: () => ({
				count: toasts.length,
				messages: toasts.map((item) => item.text)
			}),
			actions: {
				dismiss: (id) => {
					if (typeof id === 'number') dismiss(id);
					else if (toasts[0] !== undefined) dismiss(toasts[0].id);
				},
				action: (id) => {
					const target = typeof id === 'number' ? toasts.find((item) => item.id === id) : toasts[0];
					target?.action?.on_click();
				}
			}
		});
	});
</script>

<section
	aria-label={t('notifications')}
	class="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:inset-x-auto sm:right-0 sm:items-end sm:pr-6 sm:pb-6"
	data-toaster
>
	<ol
		class="flex w-full max-w-sm flex-col gap-2"
		aria-live="polite"
		onpointerenter={() => pause()}
		onpointerleave={() => resume()}
		onfocusin={() => pause()}
		onfocusout={() => resume()}
	>
		{#each toasts as item (item.id)}
			{@const icon = ICON[item.tone]}
			<li
				role={item.tone === 'error' ? 'alert' : 'status'}
				data-toast={item.tone}
				class={cn(
					'toast pointer-events-auto flex w-full items-start gap-2.5 rounded-md border px-3.5 py-3 text-sm shadow-deep',
					TONE[item.tone]
				)}
			>
				{#if icon}<Icon
						{icon}
						class="mt-0.5 size-4 shrink-0"
						aria-hidden="true"
					/>{/if}
				<div class="min-w-0 flex-1">
					<p class="font-medium break-words">{item.text}</p>
					<!-- a report keeps its lines and scrolls inside the toast, never past it -->
					{#if item.description}<p
							class="text-muted-foreground mt-0.5 max-h-48 overflow-y-auto break-words whitespace-pre-line"
							data-toast-description
						>{item.description}</p>{/if}
					{#if item.action}
						<button
							type="button"
							onclick={() => {
								item.action?.on_click();
								dismiss(item.id);
							}}
							class="text-foreground mt-1.5 inline-flex items-center rounded-sm border border-border-control bg-surface-card px-2 py-0.5 text-xs font-medium hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
						>
							{item.action.label}
						</button>
					{/if}
				</div>
				<button
					type="button"
					aria-label={t('close')}
					onclick={() => dismiss(item.id)}
					class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/40 -mr-1 grid size-6 shrink-0 place-items-center rounded-sm focus-visible:ring-2 focus-visible:outline-none"
				>
					<Icon icon="lucide:x" class="size-3.5" aria-hidden="true" />
				</button>
			</li>
		{/each}
	</ol>
</section>

<style>
	.toast {
		transform-origin: bottom center;
		animation: toast-in var(--motion-base, 180ms) var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1));
	}
	@keyframes toast-in {
		from {
			opacity: 0;
			transform: translate3d(0, 6px, 0) scale(0.98);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.toast {
			animation: none;
		}
	}
</style>
