<!--
@component
A readonly value as selectable text, with a copy button on hover or focus (always shown on touch) that copies `text`.
-->
<script lang="ts">
	import Icon from '@iconify/svelte';
	import type { Snippet } from 'svelte';
	import { create_clipboard } from '../../behaviors/index.js';
	import { cn, ui_text } from '../utils.js';

	let {
		text,
		id,
		class: className,
		children
	}: {
		/** The plain value copied (and shown, without `children`). */
		text: string;
		id?: string;
		class?: string;
		/** A richer rendering of the same value (a link, a badge); `text` is still what is copied. */
		children?: Snippet;
	} = $props();
	const t = ui_text();
	const clipboard = create_clipboard({ text: () => text });
</script>

<span
	{id}
	data-readonly
	class={cn(
		'group/copy relative inline-flex max-w-full min-w-0 items-start gap-1 text-sm text-foreground',
		className
	)}
>
	<span class="min-w-0 break-words whitespace-pre-wrap select-text"
		>{#if children}{@render children()}{:else}{text}{/if}</span
	>
	{#if text !== ''}
		<button
			type="button"
			onclick={() => void clipboard.copy()}
			aria-label={t('copy')}
			title={t('copy')}
			class="relative inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-inset text-muted-foreground opacity-0 transition-opacity [--hit-target:0px] group-hover/copy:opacity-100 before:absolute before:-inset-2.5 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(hover:none)]:opacity-100"
		>
			<Icon icon={clipboard.copied ? 'lucide:check' : 'lucide:copy'} class="size-3.5" />
		</button>
		<span class="sr-only" aria-live="polite">{clipboard.copied ? t('copied') : ''}</span>
	{/if}
</span>
