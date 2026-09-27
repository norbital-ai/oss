<!--
@component
Markdown as plain text with the `/` block menu and `@` mentions, and an optional Write/Preview switch.
-->
<script lang="ts" module>
	import type { CommandItem } from './command-menu.js';

	/**
	 * Markdown as text (a textarea, no rich editor) with the command menu: `/` at a line's start offers `commands`
	 * (the Markdown blocks by default), `@` offers `mentions(query)`. `preview` adds a Write/Preview switch; `readonly`
	 * renders the text only (`ReadonlyMarkdown`).
	 */
	export type MarkdownEditorProps = {
		value: string;
		onChange?(next: string): void;
		readonly?: boolean;
		preview?: boolean;
		/** The `/` rows; `[]` turns `/` off. */
		commands?: readonly CommandItem[];
		/** Where `/` counts: a line's start (Markdown blocks), or only as the text's first character (an agent command). */
		commandStart?: 'line' | 'text';
		mentions?(query: string): readonly CommandItem[] | PromiseLike<readonly CommandItem[]>;
		placeholder?: string;
		rows?: number;
		id?: string;
		disabled?: boolean;
		invalid?: boolean;
		class?: string;
		'aria-label'?: string;
		onkeydown?(event: KeyboardEvent): void;
		onpaste?(event: ClipboardEvent): void;
	};
</script>

<script lang="ts">
	import Textarea from '../primitives/textarea/textarea.svelte';
	import { cn } from '../primitives/utils.js';
	import CommandMenu from './command-menu.svelte';
	import { filterItems, type CommandTrigger } from './command-menu.js';
	import { BLOCKS } from './markdown.js';
	import ReadonlyMarkdown from './readonly-markdown.svelte';

	let {
		value, onChange, readonly = false, preview = false, commands = BLOCKS, commandStart = 'line', mentions, placeholder, rows = 8, id, disabled = false,
		invalid = false, class: className, 'aria-label': ariaLabel, onkeydown, onpaste
	}: MarkdownEditorProps = $props();
	let ta = $state<HTMLTextAreaElement | null>(null);
	let tab = $state<'write' | 'preview'>('write');
	const triggers = $derived<CommandTrigger[]>([
		...(commands.length === 0 ? [] : [{ char: '/', start: commandStart, items: (q: string) => filterItems(commands, q) }]),
		...(mentions === undefined ? [] : [{ char: '@', start: 'word' as const, items: mentions }])
	]);
</script>

{#if readonly}
	<ReadonlyMarkdown {value} class={className} />
{:else}
	<div class={cn('flex min-w-0 flex-col gap-1.5', className)} data-markdown-editor>
		{#if preview}
			<div class="flex gap-1 self-start rounded-sm border bg-muted/40 p-0.5 text-xs font-medium" role="tablist">
				{#each ['write', 'preview'] as const as t (t)}
					<button type="button" role="tab" aria-selected={tab === t} onclick={() => (tab = t)}
						class={cn('rounded-sm px-2.5 py-1 capitalize', tab === t ? 'bg-background shadow-xs' : 'text-muted-foreground hover:text-foreground')}>{t}</button>
				{/each}
			</div>
		{/if}
		{#if tab === 'preview' && preview}
			<ReadonlyMarkdown {value} class="min-h-16 rounded-sm border px-3 py-2" />
		{:else}
			<Textarea bind:ref={ta} {id} {value} {rows} {placeholder} {disabled} {onkeydown} {onpaste} aria-label={ariaLabel} aria-invalid={invalid ? 'true' : undefined}
				class="field-sizing-fixed" oninput={(e) => onChange?.(e.currentTarget.value)} />
			<CommandMenu textarea={ta} {triggers} />
		{/if}
	</div>
{/if}
