<!--
@component
The page's toasts, bottom right (bottom centre on a phone, above the safe area). Mount one, in the shell.
-->
<script lang="ts">
	import Icon from '@iconify/svelte';
	import { cn, uiText } from '../primitives/utils.js';
	import { dismiss, toasts, type ToastTone } from './toast.svelte.js';

	const t = uiText();
	const ICON: { readonly [k in ToastTone]: string | null } = {
		default: null, success: 'lucide:circle-check', info: 'lucide:info', warning: 'lucide:triangle-alert', error: 'lucide:circle-x'
	};
	const TONE: { readonly [k in ToastTone]: string } = {
		default: 'border-border bg-popover text-popover-foreground',
		success: 'border-success/30 bg-popover text-success',
		info: 'border-info/30 bg-popover text-info',
		warning: 'border-warning/40 bg-popover text-warning-foreground dark:text-warning',
		error: 'border-destructive/30 bg-popover text-destructive'
	};
</script>

<section
	aria-label={t('notifications')}
	class="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:inset-x-auto sm:right-0 sm:items-end sm:pr-6 sm:pb-6"
	data-toaster
>
	<ol class="flex w-full max-w-sm flex-col gap-2" aria-live="polite">
		{#each toasts as toast (toast.id)}
			<li
				role={toast.tone === 'error' ? 'alert' : 'status'}
				data-toast={toast.tone}
				class={cn('toast pointer-events-auto flex w-full items-start gap-2.5 rounded-md border px-3.5 py-3 text-sm shadow-lg', TONE[toast.tone])}
			>
				{#if ICON[toast.tone]}<Icon icon={ICON[toast.tone]!} class="mt-0.5 size-4 shrink-0" aria-hidden="true" />{/if}
				<div class="min-w-0 flex-1">
					<p class="font-medium break-words">{toast.text}</p>
					{#if toast.description}<p class="text-muted-foreground mt-0.5 break-words">{toast.description}</p>{/if}
				</div>
				<button type="button" aria-label={t('close')} onclick={() => dismiss(toast.id)}
					class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/40 -mr-1 grid size-6 shrink-0 place-items-center rounded-sm focus-visible:ring-2 focus-visible:outline-none">
					<Icon icon="lucide:x" class="size-3.5" aria-hidden="true" />
				</button>
			</li>
		{/each}
	</ol>
</section>

<style>
	.toast {
		animation: toast-in 200ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	@keyframes toast-in {
		from { opacity: 0; transform: translateY(4px); }
	}
	@media (prefers-reduced-motion: reduce) {
		.toast { animation: none; }
	}
</style>
