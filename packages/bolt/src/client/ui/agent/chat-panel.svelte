<script lang="ts">
	import { Stack } from '@norbital-ai/ui/layout';

	let {
		messages = [],
		busy = false,
		error,
		disabled = false,
		onsubmit,
		oncancel,
		onretry
	}: {
		messages?: ReadonlyArray<{
			readonly id?: string;
			readonly role: string;
			readonly content: string;
		}>;
		busy?: boolean;
		error?: string;
		disabled?: boolean;
		onsubmit?: (message: string) => void;
		oncancel?: () => void;
		onretry?: () => void;
	} = $props();
	let draft = $state('');
</script>

<section
	aria-label="Agent chat"
	aria-busy={busy}
	class="flex h-full min-h-0 flex-col bg-card text-card-foreground"
>
	<header class="border-b border-border px-4 py-3 sm:px-5">
		<h2 class="text-sm font-semibold text-foreground">Agent</h2>
	</header>

	<div
		class="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5"
		aria-live="polite"
		aria-relevant="additions"
	>
		<Stack gap="sm">
			{#if messages.length === 0 && !busy}
				<p class="text-sm text-muted-foreground">Start a conversation with this workspace agent.</p>
			{/if}
			{#each messages as message, index (message.id ?? `${message.role}-${index}`)}
				<article
					data-role={message.role}
					class="rounded-lg border border-border bg-background p-3 text-sm"
				>
					<strong class="text-xs tracking-wide text-muted-foreground uppercase"
						>{message.role}</strong
					>
					<p class="mt-1 mb-0 whitespace-pre-wrap text-foreground">{message.content}</p>
				</article>
			{/each}
			{#if busy}
				<p role="status" class="text-sm text-muted-foreground">The agent is working…</p>
			{/if}
		</Stack>
	</div>

	{#if error !== undefined}
		<div
			role="alert"
			class="border-t border-destructive/30 px-4 py-2 text-sm text-destructive sm:px-5"
		>
			<p>{error}</p>
			{#if onretry}
				<button type="button" class="mt-1 underline" onclick={onretry}>Retry</button>
			{/if}
		</div>
	{/if}

	<form
		class="border-t border-border px-4 py-3 sm:px-5"
		onsubmit={(event) => {
			event.preventDefault();
			const message = draft.trim();
			if (message !== '' && !busy && !disabled) {
				onsubmit?.(message);
				draft = '';
			}
		}}
	>
		<Stack gap="sm">
			<label for="bolt-agent-message" class="text-xs font-medium text-muted-foreground"
				>Message</label
			>
			<textarea
				id="bolt-agent-message"
				bind:value={draft}
				disabled={disabled || busy}
				class="min-h-24 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
			></textarea>
			<div class="flex gap-2">
				<button
					type="submit"
					disabled={disabled || busy || draft.trim() === ''}
					class="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
				>
					Send
				</button>
				{#if busy && oncancel}
					<button
						type="button"
						onclick={oncancel}
						class="inline-flex h-9 items-center rounded-md border border-border bg-background px-3 text-sm text-foreground"
					>
						Cancel
					</button>
				{/if}
			</div>
		</Stack>
	</form>
</section>
