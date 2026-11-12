<!--
@component
Markdown as plain text with the `/` block menu and `@` mentions, and an optional Write/Preview switch.
-->
<script lang="ts" module>
	import type { ReadError } from '../client/contract.js';
	import type { Effect as EffectType } from 'effect';
	import type { CommandItem } from './command-menu.js';

	/**
	 * Markdown as text (a textarea, no rich editor) with the command menu: `/` at a line's start offers `commands`
	 * (the Markdown blocks by default), `@` offers `mentions(query)`. `preview` adds a Write/Preview switch; `readonly`
	 * renders the text only (`ReadonlyMarkdown`).
	 */
	export type MarkdownEditorProps = {
		value: string;
		on_change?(next: string): void;
		readonly?: boolean;
		preview?: boolean;
		/** The `/` rows, or a scoped search provider; `[]` turns `/` off. */
		commands?:
			| readonly CommandItem[]
			| ((query: string) => EffectType.Effect<readonly CommandItem[], ReadError | Error>);
		/** Where `/` counts: a line's start (Markdown blocks), or only as the text's first character (an agent command). */
		command_start?: 'line' | 'text' | 'word';
		mentions?(query: string): EffectType.Effect<readonly CommandItem[], ReadError | Error>;
		placeholder?: string;
		rows?: number;
		id?: string;
		disabled?: boolean;
		invalid?: boolean;
		class?: string;
		'aria-label'?: string;
		onkeydown?(event: KeyboardEvent): void;
		onpaste?(event: ClipboardEvent): void;
		/** The textarea, bindable: a page inserts at its caret (`selectionStart`) or focuses it. */
		textarea?: HTMLTextAreaElement | null;
	};
</script>

<script lang="ts">
	import { Effect } from 'effect';
	import Textarea from '../primitives/textarea/textarea.svelte';
	import TabStrip from '../primitives/tabs/tab-strip.svelte';
	import { cn } from '../primitives/utils.js';
	import CommandMenu from './command-menu.svelte';
	import { filterItems, type CommandTrigger } from './command-menu.js';
	import { BLOCKS } from './markdown.js';
	import ReadonlyMarkdown from './readonly-markdown.svelte';

	let {
		value,
		on_change,
		readonly = false,
		preview = false,
		commands = BLOCKS,
		command_start = 'line',
		mentions,
		placeholder,
		rows = 8,
		id,
		disabled = false,
		invalid = false,
		class: className,
		'aria-label': ariaLabel,
		onkeydown,
		onpaste,
		textarea: ta = $bindable(null)
	}: MarkdownEditorProps = $props();
	let tab = $state<'write' | 'preview'>('write');
	const commandItems = (query: string) =>
		typeof commands === 'function' ? commands(query) : Effect.succeed(filterItems(commands, query));
	const triggers = $derived<CommandTrigger[]>([
		...(typeof commands !== 'function' && commands.length === 0
			? []
			: [
					{
						char: '/',
						start: command_start,
						spaces: typeof commands === 'function',
						items: commandItems
					}
				]),
		...(mentions === undefined
			? []
			: [{ char: '@', start: 'word' as const, spaces: true, items: mentions }])
	]);
</script>

{#if readonly}
	<ReadonlyMarkdown {value} class={className} />
{:else}
	<div class={cn('flex min-w-0 flex-col gap-1.5', className)} data-markdown-editor>
		{#if preview}
			<TabStrip
				label="Markdown"
				value={tab}
				items={[
					{ name: 'write', title: 'Write' },
					{ name: 'preview', title: 'Preview' }
				]}
				on_value_change={(next) => (tab = next === 'preview' ? 'preview' : 'write')}
			/>
		{/if}
		{#if tab === 'preview' && preview}
			<ReadonlyMarkdown {value} class="min-h-16 rounded-sm border px-3 py-2" />
		{:else}
			<Textarea
				bind:ref={ta}
				{id}
				{value}
				{rows}
				{placeholder}
				{disabled}
				{onkeydown}
				{onpaste}
				aria-label={ariaLabel}
				aria-invalid={invalid ? 'true' : undefined}
				class="field-sizing-fixed"
				oninput={(e) => on_change?.(e.currentTarget.value)}
			/>
			<CommandMenu textarea={ta} {triggers} />
		{/if}
	</div>
{/if}
