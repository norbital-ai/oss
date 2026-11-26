<!--
@component
Markdown edited as it reads (WYSIWYG): type Markdown shortcuts (`# `, `- `, `1. `, `> `, `**bold**`, ``` `code` ```) or use
the toolbar; a pasted link links the selection. With `upload`, pictures pasted, dropped or picked are stored and shown
in place. The value in and out is Markdown, so `ReadonlyMarkdown` shows it the same way. The engine loads on first use.
@example
<RichMarkdownEditor value={notes} on_change={(next) => (notes = next)} upload={(file) => store(file)} />
-->
<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Effect } from 'effect';
	import { untrack } from 'svelte';
	import { watch } from '../behaviors/index.js';
	import { fork } from '../effect/index.js';
	import { Button } from '../primitives/button/index.js';
	import { cn, ui_text, use_controls } from '../primitives/utils.js';
	import { toast } from '../toast/toast.svelte.js';
	import ReadonlyMarkdown from './readonly-markdown.svelte';
	import type { Editor } from './rich-markdown.js';

	let {
		value,
		on_change,
		placeholder = '',
		readonly,
		disabled = false,
		invalid = false,
		id,
		class: className,
		'aria-label': ariaLabel,
		upload
	}: {
		/** The Markdown shown and edited. */
		value: string;
		/** Called with the Markdown after each edit. */
		on_change?(next: string): void;
		/** Shown while the document is empty. */
		placeholder?: string;
		/** Shows the text as read (an enclosing readonly form sets it). */
		readonly?: boolean;
		/** The editor stays, muted and inert (an enclosing disabled form sets it). */
		disabled?: boolean;
		/** Marks the editor as holding a refused value. */
		invalid?: boolean;
		/** The id on the editable document, for `<label for>`. */
		id?: string;
		/** Classes on the editor's frame. */
		class?: string;
		/** The editor's accessible name when no label names it. */
		'aria-label'?: string;
		/** Stores a picture and answers the URL it is shown by; without it the editor takes no pictures. */
		upload?(file: File): Effect.Effect<string, Error>;
	} = $props();
	const t = ui_text();
	const controls = use_controls();
	const shown = $derived(readonly ?? controls.readonly);
	const inert = $derived(disabled || controls.disabled);

	let editor = $state.raw<Editor | null>(null);
	/** Bumped on each transaction: the toolbar reads the selection's marks through it. */
	let revision = $state(0);
	let uploading = $state(0);
	let picker = $state<HTMLInputElement | null>(null);
	/** The Markdown this editor last wrote: a value that differs came from outside (a reset, a reload) and replaces it. */
	let written = untrack(() => value);

	function addPictures(files: readonly File[], at: number | null): boolean {
		const send = upload;
		const live = editor;
		if (send === undefined || live === null || files.length === 0) return false;
		uploading += files.length;
		for (const file of files)
			fork(
				send(file).pipe(
					Effect.tap((src) =>
						Effect.sync(() => {
							const image = { type: 'image', attrs: { src, alt: file.name } };
							if (at === null) live.chain().focus().insertContent(image).run();
							else live.chain().focus().insertContentAt(at, image).run();
						})
					),
					Effect.ensuring(Effect.sync(() => (uploading -= 1)))
				),
				(error) => toast.error(`${t('uploadFailed')}: ${error.message}`)
			);
		return true;
	}

	const mount = (element: HTMLElement) => {
		let live: Editor | null = null;
		let gone = false;
		const initial = untrack(() => ({
			value,
			placeholder,
			editable: !inert,
			label: ariaLabel,
			id
		}));
		void import('./rich-markdown.js').then(({ rich_markdown }) => {
			if (gone) return;
			live = rich_markdown(element, initial, {
				on_markdown: (markdown) => {
					written = markdown;
					on_change?.(markdown);
				},
				on_transaction: () => (revision += 1),
				on_pictures: addPictures
			});
			editor = live;
		});
		return () => {
			gone = true;
			live?.destroy();
			editor = null;
		};
	};
	watch(
		() => value,
		(next) => {
			if (editor === null || next === written) return;
			written = next;
			editor.commands.setContent(next, { contentType: 'markdown', emitUpdate: false });
		}
	);
	watch(
		() => inert,
		(off) => editor?.setEditable(!off)
	);

	type Tool = {
		readonly label: string;
		readonly icon: string;
		readonly active: (e: Editor) => boolean;
		readonly run: (e: Editor) => void;
	};
	const tools: readonly Tool[] = [
		{
			label: t('bold'),
			icon: 'lucide:bold',
			active: (e) => e.isActive('bold'),
			run: (e) => e.chain().focus().toggleBold().run()
		},
		{
			label: t('italic'),
			icon: 'lucide:italic',
			active: (e) => e.isActive('italic'),
			run: (e) => e.chain().focus().toggleItalic().run()
		},
		{
			label: t('strikethrough'),
			icon: 'lucide:strikethrough',
			active: (e) => e.isActive('strike'),
			run: (e) => e.chain().focus().toggleStrike().run()
		},
		{
			label: t('heading'),
			icon: 'lucide:heading',
			active: (e) => e.isActive('heading'),
			run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run()
		},
		{
			label: t('bulletList'),
			icon: 'lucide:list',
			active: (e) => e.isActive('bulletList'),
			run: (e) => e.chain().focus().toggleBulletList().run()
		},
		{
			label: t('numberedList'),
			icon: 'lucide:list-ordered',
			active: (e) => e.isActive('orderedList'),
			run: (e) => e.chain().focus().toggleOrderedList().run()
		},
		{
			label: t('quote'),
			icon: 'lucide:text-quote',
			active: (e) => e.isActive('blockquote'),
			run: (e) => e.chain().focus().toggleBlockquote().run()
		},
		{
			label: t('codeBlock'),
			icon: 'lucide:square-code',
			active: (e) => e.isActive('codeBlock'),
			run: (e) => e.chain().focus().toggleCodeBlock().run()
		}
	];
	const active = $derived.by(() => {
		void revision;
		const live = editor;
		return live === null ? tools.map(() => false) : tools.map((tool) => tool.active(live));
	});
</script>

{#if shown}
	<ReadonlyMarkdown {value} class={className} />
{:else}
	<div
		class={cn(
			'flex min-w-0 flex-col rounded-control border border-input bg-background shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
			invalid && 'border-destructive ring-destructive/20',
			inert && 'opacity-60',
			className
		)}
		data-rich-markdown-editor
	>
		<div
			class="flex items-center gap-0.5 border-b border-border px-1 py-0.5"
			role="toolbar"
			aria-label={ariaLabel}
		>
			{#each tools as tool, index (tool.icon)}
				<Button
					variant={active[index] ? 'secondary' : 'ghost'}
					size="icon"
					class="size-7"
					aria-label={tool.label}
					aria-pressed={active[index]}
					hint={tool.label}
					disabled={inert || editor === null}
					onclick={() => editor && tool.run(editor)}
				>
					<Icon icon={tool.icon} class="size-3.5" />
				</Button>
			{/each}
			{#if upload !== undefined}
				<Button
					variant="ghost"
					size="icon"
					class="size-7"
					aria-label={t('addImage')}
					hint={t('addImage')}
					disabled={inert || editor === null || uploading > 0}
					onclick={() => picker?.click()}
				>
					<Icon
						icon={uploading > 0 ? 'lucide:loader-circle' : 'lucide:image-plus'}
						class={cn('size-3.5', uploading > 0 && 'animate-spin')}
					/>
				</Button>
				<input
					bind:this={picker}
					type="file"
					accept="image/*"
					multiple
					class="hidden"
					onchange={(event) => {
						addPictures([...(event.currentTarget.files ?? [])], null);
						event.currentTarget.value = '';
					}}
				/>
			{/if}
		</div>
		<div class="min-h-24 px-3 py-2 text-sm" {@attach mount}></div>
	</div>
{/if}

<style>
	/* the placeholder of an empty document, as tiptap marks it */
	:global(.rich-markdown p.is-editor-empty:first-child::before) {
		content: attr(data-placeholder);
		float: left;
		height: 0;
		pointer-events: none;
		color: var(--color-muted-foreground);
	}
	:global(.rich-markdown img) {
		max-height: 24rem;
		border-radius: var(--radius-control, 0.375rem);
	}
</style>
