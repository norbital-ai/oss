<!--
@component
A readonly value as selectable text, with a copy button on hover or focus (always shown on touch) that copies `text`.
-->
<script lang="ts">
	import Icon from '@iconify/svelte';
	import type { Snippet } from 'svelte';
	import { cn, uiText } from '../utils.js';

	let { text, id, class: className, children }: {
		/** The plain value copied (and shown, without `children`). */
		text: string;
		id?: string;
		class?: string;
		/** A richer rendering of the same value (a link, a badge); `text` is still what is copied. */
		children?: Snippet;
	} = $props();
	const t = uiText();
	let copied = $state(false);
	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch { /* clipboard refused: the text stays selectable */ }
	}
</script>

<span {id} data-readonly class={cn('group/copy inline-flex max-w-full min-w-0 items-start gap-1 text-sm text-foreground', className)}>
	<span class="min-w-0 break-words whitespace-pre-wrap select-text">{#if children}{@render children()}{:else}{text}{/if}</span>
	{#if text !== ''}
		<button
			type="button"
			onclick={copy}
			aria-label={t('copy')}
			title={t('copy')}
			class="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover/copy:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(hover:none)]:opacity-100"
		>
			<Icon icon={copied ? 'lucide:check' : 'lucide:copy'} class="size-3.5" />
		</button>
		<span class="sr-only" aria-live="polite">{copied ? t('copied') : ''}</span>
	{/if}
</span>
