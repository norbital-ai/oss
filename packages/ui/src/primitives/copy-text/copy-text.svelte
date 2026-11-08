<!--
@component
A readonly value as selectable text, with a copy button on hover or focus (always shown on touch) that copies `text`.
-->
<script lang="ts">
	import Icon from '@iconify/svelte';
	import { onDestroy, type Snippet } from 'svelte';
	import { cn, uiText } from '../utils.js';

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
	const t = uiText();
	let copied = $state(false);
	let reset: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	onDestroy(() => {
		disposed = true;
		clearTimeout(reset);
	});
	/** A hidden field works where the async clipboard is unavailable or denied (an embedded page). */
	function legacyCopy(): boolean {
		const area = document.createElement('textarea');
		area.value = text;
		area.setAttribute('readonly', '');
		area.style.position = 'fixed';
		area.style.inset = '0 auto auto -9999px';
		document.body.appendChild(area);
		area.select();
		try {
			return document.execCommand('copy');
		} catch {
			return false;
		} finally {
			area.remove();
		}
	}
	async function copy() {
		let ok = false;
		try {
			await navigator.clipboard.writeText(text);
			ok = true;
		} catch {
			ok = legacyCopy();
		}
		if (disposed) return;
		clearTimeout(reset);
		copied = ok;
		reset = undefined;
		if (ok)
			reset = setTimeout(() => {
				copied = false;
				reset = undefined;
			}, 1500);
	}
</script>

<span
	{id}
	data-readonly
	class={cn(
		'group/copy inline-flex max-w-full min-w-0 items-start gap-1 text-sm text-foreground',
		className
	)}
>
	<span class="min-w-0 break-words whitespace-pre-wrap select-text"
		>{#if children}{@render children()}{:else}{text}{/if}</span
	>
	{#if text !== ''}
		<button
			type="button"
			onclick={copy}
			aria-label={t('copy')}
			title={t('copy')}
			class="relative inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity [--hit-target:0px] group-hover/copy:opacity-100 before:absolute before:-inset-2.5 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(hover:none)]:opacity-100"
		>
			<Icon icon={copied ? 'lucide:check' : 'lucide:copy'} class="size-3.5" />
		</button>
		<span class="sr-only" aria-live="polite">{copied ? t('copied') : ''}</span>
	{/if}
</span>
