<!--
@component
Borderless Linear-style WYSIWYG Markdown editor: no static toolbar — formats text via a floating bubble menu on
selection and inserts blocks via a floating `/` slash command menu, plus standard Markdown shortcuts (`# `, `- `,
`1. `, `> `, `**bold**`, `` `code` ``). With `upload`, pictures pasted, dropped or inserted from `/` are stored and
shown in place. The value in and out is Markdown, so `ReadonlyMarkdown` shows it the same way.
@example
<RichMarkdownEditor value={notes} autofocus on_change={(next) => (notes = next)} upload={(file) => store(file)} />
-->
<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Effect } from 'effect';
	import { untrack } from 'svelte';
	import {
		create_dismiss,
		create_floating,
		create_listbox,
		portal,
		watch
	} from '../behaviors/index.js';
	import { fork } from '../effect/index.js';
	import { Button } from '../primitives/button/index.js';
	import { cn, ui_text, use_controls } from '../primitives/utils.js';
	import { toast } from '../toast/toast.svelte.js';
	import ReadonlyMarkdown from './readonly-markdown.svelte';
	import type { Editor } from './rich-markdown.js';

	let {
		value,
		on_change,
		placeholder,
		readonly,
		disabled = false,
		invalid = false,
		autofocus = false,
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
		/** Focuses the editor at the end of its content once mounted. */
		autofocus?: boolean;
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
	const resolvedPlaceholder = $derived(placeholder ?? t('slashCommands'));

	let editor = $state.raw<Editor | null>(null);
	/** Bumped on each transaction so bubble marks and `/` slash state react immediately. */
	let revision = $state(0);
	let focused = $state(false);
	let uploading = $state(0);
	let picker = $state<HTMLInputElement | null>(null);
	let rootEl = $state<HTMLElement | null>(null);
	let bubbleEl = $state<HTMLElement | null>(null);
	let linkEditing = $state(false);
	let linkDraft = $state('');
	/** The Markdown this editor last wrote: a value that differs came from outside (a reset, a reload) and replaces it. */
	let written = untrack(() => value);

	type SlashMatch = {
		readonly from: number;
		readonly to: number;
		readonly query: string;
		readonly rect: DOMRect;
	};
	let slashDismissedAt = $state<number | null>(null);
	let slash = $state.raw<SlashMatch | null>(null);
	let bubbleAnchor = $state.raw<DOMRect | null>(null);

	type SlashItem = {
		readonly id: string;
		readonly label: string;
		readonly icon: string;
		readonly keywords: string;
		readonly run: (e: Editor) => void;
	};
	const allSlashItems = $derived.by<readonly SlashItem[]>(() => [
		{
			id: 'h1',
			label: t('heading1'),
			icon: 'lucide:heading-1',
			keywords: 'h1 heading title',
			run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run()
		},
		{
			id: 'h2',
			label: t('heading2'),
			icon: 'lucide:heading-2',
			keywords: 'h2 heading subtitle',
			run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run()
		},
		{
			id: 'h3',
			label: t('heading3'),
			icon: 'lucide:heading-3',
			keywords: 'h3 heading section',
			run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run()
		},
		{
			id: 'bullets',
			label: t('bulletList'),
			icon: 'lucide:list',
			keywords: 'ul bullet list',
			run: (e) => e.chain().focus().toggleBulletList().run()
		},
		{
			id: 'numbers',
			label: t('numberedList'),
			icon: 'lucide:list-ordered',
			keywords: 'ol numbered ordered list',
			run: (e) => e.chain().focus().toggleOrderedList().run()
		},
		{
			id: 'quote',
			label: t('quote'),
			icon: 'lucide:text-quote',
			keywords: 'quote blockquote callout',
			run: (e) => e.chain().focus().toggleBlockquote().run()
		},
		{
			id: 'code',
			label: t('codeBlock'),
			icon: 'lucide:square-code',
			keywords: 'code block snippet',
			run: (e) => e.chain().focus().toggleCodeBlock().run()
		},
		{
			id: 'divider',
			label: t('divider'),
			icon: 'lucide:minus',
			keywords: 'hr divider line rule',
			run: (e) => e.chain().focus().setHorizontalRule().run()
		},
		...(upload !== undefined
			? [
					{
						id: 'image',
						label: t('addImage'),
						icon: 'lucide:image-plus',
						keywords: 'image photo picture upload',
						run: () => picker?.click()
					}
				]
			: [])
	]);

	const slashItems = $derived.by(() => {
		const q = slash?.query.trim().toLowerCase() ?? '';
		if (!q) return allSlashItems;
		return allSlashItems.filter(
			(item) => item.label.toLowerCase().includes(q) || item.keywords.includes(q)
		);
	});
	const slashOpen = $derived(slash !== null && slashItems.length > 0 && !inert);

	const lb = create_listbox({
		items: () => slashItems.map((item) => ({ value: item.id, label: item.label })),
		focus: 'virtual',
		filter: false,
		on_activate: (selected) => {
			const item = slashItems.find((entry) => entry.id === selected.value);
			if (item !== undefined) pickSlash(item);
		}
	});
	const activeSlashIndex = $derived(
		lb.active === undefined ? -1 : slashItems.findIndex((item) => item.id === lb.active)
	);

	watch(
		() => slashItems,
		(items) => {
			if (slash === null || items.length === 0) return;
			if (!items.some((item) => item.id === lb.active)) {
				const first = items[0];
				if (first !== undefined) lb.highlight(first.id);
			}
		}
	);

	function pickSlash(item: SlashItem): void {
		const live = editor;
		const match = slash;
		if (live === null || match === null) return;
		slash = null;
		slashDismissedAt = null;
		live.chain().focus().deleteRange({ from: match.from, to: match.to }).run();
		item.run(live);
	}

	function rectAtPos(live: Editor, pos: number): DOMRect {
		try {
			const coords = live.view.coordsAtPos(pos);
			return new DOMRect(
				coords.left,
				coords.top,
				Math.max(1, coords.right - coords.left),
				Math.max(16, coords.bottom - coords.top)
			);
		} catch {
			return live.view.dom.getBoundingClientRect();
		}
	}

	function selectionRect(live: Editor): DOMRect | null {
		const sel = typeof window !== 'undefined' ? window.getSelection() : null;
		if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
			const rect = sel.getRangeAt(0).getBoundingClientRect();
			if (rect.width > 0 || rect.height > 0) return rect;
		}
		const { from, to } = live.state.selection;
		if (from === to) return null;
		const start = rectAtPos(live, from);
		const end = rectAtPos(live, to);
		return new DOMRect(
			Math.min(start.left, end.left),
			Math.min(start.top, end.top),
			Math.max(1, Math.abs(end.right - start.left)),
			Math.max(16, Math.max(start.bottom, end.bottom) - Math.min(start.top, end.top))
		);
	}

	function syncOverlays(live: Editor | null): void {
		if (live === null || inert) {
			slash = null;
			bubbleAnchor = null;
			linkEditing = false;
			return;
		}
		const { selection } = live.state;
		const { empty, from, to } = selection;
		const resolvedFrom = selection.$from;

		// 1. Floating `/` slash command menu when collapsed in a normal textblock (not codeBlock)
		if (empty && !live.isActive('codeBlock')) {
			const before = resolvedFrom.parent.textBetween(0, resolvedFrom.parentOffset, undefined, '\ufffc');
			const match = /(?:^|\s)(\/[^\s/]*)$/.exec(before);
			if (match !== null) {
				const token = match[1] ?? '/';
				const tokenFrom = from - token.length;
				if (slashDismissedAt !== tokenFrom) {
					slash = {
						from: tokenFrom,
						to: from,
						query: token.slice(1),
						rect: rectAtPos(live, tokenFrom)
					};
					bubbleAnchor = null;
					linkEditing = false;
					return;
				}
			} else {
				slashDismissedAt = null;
			}
		} else {
			slashDismissedAt = null;
		}
		slash = null;

		// 2. Floating bubble menu on non-empty text selection (not codeBlock)
		if (!empty && from < to && !live.isActive('codeBlock')) {
			const text = live.state.doc.textBetween(from, to, ' ').trim();
			if (text.length > 0 && (focused || linkEditing)) {
				bubbleAnchor = selectionRect(live);
				return;
			}
		}
		bubbleAnchor = null;
		linkEditing = false;
	}

	function handleKeyDown(event: KeyboardEvent): boolean {
		if (!slashOpen || event.isComposing) return false;
		if (
			event.key === 'ArrowDown' ||
			event.key === 'ArrowUp' ||
			event.key === 'Home' ||
			event.key === 'End'
		) {
			lb.input_attrs(true).onkeydown(event);
			event.preventDefault();
			return true;
		}
		if (event.key === 'Enter' || event.key === 'Tab') {
			const item = slashItems[activeSlashIndex] ?? slashItems[0];
			if (item !== undefined) {
				event.preventDefault();
				pickSlash(item);
				return true;
			}
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			slashDismissedAt = slash?.from ?? null;
			slash = null;
			return true;
		}
		return false;
	}

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
			placeholder: resolvedPlaceholder,
			editable: !inert,
			autofocus,
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
				on_transaction: () => {
					revision += 1;
					syncOverlays(live);
				},
				on_focus: (next) => {
					if (next) {
						focused = true;
						syncOverlays(live);
					} else {
						// Keep bubble menu alive while moving focus into its inline link input.
						queueMicrotask(() => {
							if (bubbleEl?.contains(document.activeElement)) return;
							focused = false;
							syncOverlays(live);
						});
					}
				},
				on_keydown: handleKeyDown,
				on_pictures: addPictures
			});
			editor = live;
			if (initial.autofocus && initial.editable) focused = true;
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
		(off) => {
			editor?.setEditable(!off);
			if (off) syncOverlays(null);
		}
	);

	type BubbleTool = {
		readonly id: string;
		readonly label: string;
		readonly icon: string;
		readonly active: (e: Editor) => boolean;
		readonly run: (e: Editor) => void;
	};
	const bubbleTools: readonly BubbleTool[] = [
		{
			id: 'bold',
			label: t('bold'),
			icon: 'lucide:bold',
			active: (e) => e.isActive('bold'),
			run: (e) => e.chain().focus().toggleBold().run()
		},
		{
			id: 'italic',
			label: t('italic'),
			icon: 'lucide:italic',
			active: (e) => e.isActive('italic'),
			run: (e) => e.chain().focus().toggleItalic().run()
		},
		{
			id: 'strike',
			label: t('strikethrough'),
			icon: 'lucide:strikethrough',
			active: (e) => e.isActive('strike'),
			run: (e) => e.chain().focus().toggleStrike().run()
		},
		{
			id: 'code',
			label: t('inlineCode'),
			icon: 'lucide:code',
			active: (e) => e.isActive('code'),
			run: (e) => e.chain().focus().toggleCode().run()
		},
		{
			id: 'heading',
			label: t('heading'),
			icon: 'lucide:heading',
			active: (e) => e.isActive('heading'),
			run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run()
		},
		{
			id: 'quote',
			label: t('quote'),
			icon: 'lucide:text-quote',
			active: (e) => e.isActive('blockquote'),
			run: (e) => e.chain().focus().toggleBlockquote().run()
		},
		{
			id: 'bullets',
			label: t('bulletList'),
			icon: 'lucide:list',
			active: (e) => e.isActive('bulletList'),
			run: (e) => e.chain().focus().toggleBulletList().run()
		}
	];
	const bubbleActive = $derived.by(() => {
		void revision;
		const live = editor;
		return live === null ? bubbleTools.map(() => false) : bubbleTools.map((tool) => tool.active(live));
	});
	const linkActive = $derived.by(() => {
		void revision;
		return editor?.isActive('link') ?? false;
	});

	function openLinkEditor(): void {
		const live = editor;
		if (live === null) return;
		const current = live.getAttributes('link')['href'];
		linkDraft = typeof current === 'string' ? current : '';
		linkEditing = true;
	}

	function applyLink(): void {
		const live = editor;
		linkEditing = false;
		if (live === null) return;
		const href = linkDraft.trim();
		if (href === '') {
			live.chain().focus().extendMarkRange('link').unsetLink().run();
		} else {
			const normalized = /^(https?:\/\/|mailto:|\/|#)/i.test(href) ? href : `https://${href}`;
			live.chain().focus().extendMarkRange('link').setLink({ href: normalized }).run();
		}
	}

	const bubbleOpen = $derived(bubbleAnchor !== null && !slashOpen && !inert);
	const bubbleFloating = create_floating({
		open: () => bubbleOpen,
		anchor: () => {
			const rect = bubbleAnchor;
			return rect === null ? null : { getBoundingClientRect: () => rect };
		},
		side: () =>
			bubbleAnchor !== null &&
			rootEl !== null &&
			bubbleAnchor.top - rootEl.getBoundingClientRect().top < 44
				? 'bottom'
				: 'top',
		align: 'center',
		side_offset: 8,
		padding: 8,
		flip: true,
		escape: false,
		outside: false
	});

	const slashFloating = create_floating({
		open: () => slashOpen,
		anchor: () => {
			const rect = slash?.rect ?? null;
			return rect === null ? null : { getBoundingClientRect: () => rect };
		},
		side: 'bottom',
		align: 'start',
		side_offset: 4,
		padding: 8,
		flip: true,
		escape: false,
		outside: false
	});

	const slashDismiss = create_dismiss({
		open: () => slashOpen,
		on_dismiss: () => {
			if (slash !== null) {
				slashDismissedAt = slash.from;
				slash = null;
			}
		}
	});
</script>

{#if shown}
	<ReadonlyMarkdown {value} class={className} />
{:else}
	<div
		bind:this={rootEl}
		class={cn(
			'flex min-h-48 min-w-0 flex-1 flex-col bg-transparent',
			invalid && 'rounded-control ring-2 ring-destructive/40',
			inert && 'opacity-60',
			className
		)}
		data-rich-markdown-editor
	>
		<div class="flex min-h-0 flex-1 flex-col text-sm" {@attach mount}></div>
		{#if upload !== undefined}
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

	{#if bubbleOpen}
		<div {@attach portal()} class="contents">
			<div
				bind:this={bubbleEl}
				{@attach bubbleFloating.content}
				style={bubbleFloating.style}
				class="z-50 flex items-center gap-0.5 rounded-control border border-border bg-popover p-1 text-popover-foreground shadow-deep"
				data-rich-bubble-menu
				role="group"
				aria-label={ariaLabel ?? t('bold')}
			>
				{#if linkEditing}
					<input
						type="url"
						bind:value={linkDraft}
						placeholder={t('linkUrl')}
						aria-label={t('link')}
						class="h-7 w-48 rounded-sm border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:border-ring"
						onkeydown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								applyLink();
							} else if (e.key === 'Escape') {
								e.preventDefault();
								linkEditing = false;
								editor?.commands.focus();
							}
						}}
					/>
					<Button
						variant="ghost"
						size="icon"
						class="size-7"
						aria-label={t('save')}
						onmousedown={(e) => e.preventDefault()}
						onclick={applyLink}
					>
						<Icon icon="lucide:check" class="size-3.5" />
					</Button>
				{:else}
					{#each bubbleTools as tool, index (tool.id)}
						<Button
							variant={bubbleActive[index] ? 'secondary' : 'ghost'}
							size="icon"
							class="size-7"
							aria-label={tool.label}
							aria-pressed={bubbleActive[index]}
							hint={tool.label}
							disabled={inert || editor === null}
							onmousedown={(e) => e.preventDefault()}
							onclick={() => editor && tool.run(editor)}
						>
							<Icon icon={tool.icon} class="size-3.5" />
						</Button>
					{/each}
					<Button
						variant={linkActive ? 'secondary' : 'ghost'}
						size="icon"
						class="size-7"
						aria-label={t('link')}
						aria-pressed={linkActive}
						hint={t('link')}
						disabled={inert || editor === null}
						onmousedown={(e) => e.preventDefault()}
						onclick={openLinkEditor}
					>
						<Icon icon="lucide:link" class="size-3.5" />
					</Button>
				{/if}
			</div>
		</div>
	{/if}

	{#if slashOpen}
		<div {@attach portal()} class="contents">
			<div
				{@attach slashFloating.content}
				{@attach slashDismiss.surface}
				style={slashFloating.style}
				class="z-50 w-56 max-w-[calc(100vw-2rem)] rounded-control border border-border bg-popover p-1 text-popover-foreground shadow-deep"
				data-rich-slash-menu
			>
				<ul id={lb.id} role="listbox" class="max-h-64 overflow-auto">
					{#each slashItems as item, i (item.id)}
						{@const opt = lb.option_attrs(item.id)}
						<li
							id={opt.id}
							role="option"
							aria-selected={i === activeSlashIndex}
							data-highlighted={opt['data-highlighted']}
							data-slash-item={item.id}
						>
							<button
								type="button"
								tabindex="-1"
								class={cn(
									'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
									i === activeSlashIndex && 'bg-accent text-accent-foreground'
								)}
								onmousedown={(e) => e.preventDefault()}
								onmousemove={() => lb.highlight(item.id)}
								onclick={() => pickSlash(item)}
							>
								<Icon icon={item.icon} class="size-4 shrink-0 text-muted-foreground" />
								<span class="truncate">{item.label}</span>
							</button>
						</li>
					{/each}
				</ul>
			</div>
		</div>
	{/if}
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
