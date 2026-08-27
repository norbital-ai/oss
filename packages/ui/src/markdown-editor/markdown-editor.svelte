<script lang="ts">
	import { Editor, type EditorOptions } from '@tiptap/core';
	import BubbleMenu from '@tiptap/extension-bubble-menu';
	import Placeholder from '@tiptap/extension-placeholder';
	import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
	import TaskItem from '@tiptap/extension-task-item';
	import TaskList from '@tiptap/extension-task-list';
	import StarterKit from '@tiptap/starter-kit';
	import { onDestroy, onMount } from 'svelte';
	import * as Command from '#lib/command';
	import * as Dialog from '#lib/dialog';
	import { Input } from '#lib/input';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import type { MessageVars } from '@norbital-ai/std/i18n';
	import { Inline, SCROLL_AXIS_CLASSES } from '#lib/layout';
	import * as ToggleGroup from '#lib/toggle-group';
	import { cn } from '#lib/utils';
	import { createFileAttachmentExtension } from './extensions/attachment/attachment-extension.svelte';
	import {
		ConfiguredMention
	} from './extensions/mention/mention-configured.svelte';
	import type { MentionItem } from './extensions/mention/mention-item.js';
	import MentionTreeMenu from './extensions/mention/mention-tree-menu.svelte';
	import { createSlashCommands, type CommandItem } from './extensions/slash-commands.svelte';
	import Icon from '@iconify/svelte';
	import { buttonVariants } from '#lib/button';
	import type { IFileUploadClient } from '#lib/file-upload';
	import { Markdown } from '@tiptap/markdown';
	import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
	import { createLowlight } from 'lowlight';
	import bash from 'highlight.js/lib/languages/bash';
	import css from 'highlight.js/lib/languages/css';
	import diff from 'highlight.js/lib/languages/diff';
	import go from 'highlight.js/lib/languages/go';
	import javascript from 'highlight.js/lib/languages/javascript';
	import json from 'highlight.js/lib/languages/json';
	import markdown from 'highlight.js/lib/languages/markdown';
	import python from 'highlight.js/lib/languages/python';
	import sql from 'highlight.js/lib/languages/sql';
	import typescript from 'highlight.js/lib/languages/typescript';
	import xml from 'highlight.js/lib/languages/xml';
	import yaml from 'highlight.js/lib/languages/yaml';
	import { watch } from 'runed';

	const { t } = useI18n<UiKeys>();

	// The tenant-facing set, not lowlight's `common` (~37 grammars, each with its sibling imports).
	// Fenced blocks for anything outside it still render; only the highlighting pass falls back.
	const lowlight = createLowlight({
		bash,
		css,
		diff,
		go,
		javascript,
		json,
		markdown,
		python,
		sql,
		typescript,
		xml,
		yaml
	});

	type MarkName = 'bold' | 'italic' | 'underline' | 'strike' | 'link';
	const MARK_NAMES: MarkName[] = ['bold', 'italic', 'underline', 'strike', 'link'];
	type SlashCommandDefinition = {
		title: string;
		description?: string;
		icon: string;
		keywords?: string[];
		insertText?: string;
		onSelect?: () => void;
	};

	// ─── Props ────────────────────────────────────────────────────────
	type Props = {
		value: string;
		onValueChange?: (content: string) => void;
		onAttachmentsChange?: (attachments: Array<{ name: string; url: string; type: string }>) => void;
		/** When set, inserts files via the TipTap attachment extension, then clears itself. */
		filesToAttach?: FileList | File[] | null;
		type?: 'default' | 'input' | 'textarea';
		heightMode?: 'auto' | 'fill';
		readonly?: boolean;
		placeholder?: string;
		class?: string;
		autofocus?: boolean;
		controlProps?: Record<string, unknown>;
		onEditorKeyDown?: (event: KeyboardEvent) => boolean | void;
		syncExternalValue?: boolean;
		enableMentions?: boolean;
		mentionItems?: MentionItem[];
		slashCommandGroups?: Array<{ title: string; items: SlashCommandDefinition[] }>;
		useDefaultSlashCommands?: boolean;
		fileAttachmentClient?: IFileUploadClient;
	};

	let {
		value,
		onValueChange,
		onAttachmentsChange,
		filesToAttach = $bindable(null),
		class: className,
		autofocus = false,
		controlProps,
		onEditorKeyDown,
		enableMentions = false,
		mentionItems = [],
		slashCommandGroups = [],
		useDefaultSlashCommands = true,
		syncExternalValue = false,
		fileAttachmentClient = undefined,
		type = 'default',
		heightMode: heightModeProp,
		readonly = false,
		placeholder: placeholderProp
	}: Props = $props();

	const placeholder = $derived(
		placeholderProp ??
			(type === 'input' ? t('misc.markdownInputPlaceholder') : t('misc.markdownPlaceholder'))
	);
	const isInput = $derived(type === 'input');
	const isTextarea = $derived(type === 'textarea');
	const isInteractive = $derived(!readonly);
	const heightMode = $derived(heightModeProp ?? (type === 'default' ? 'fill' : 'auto'));

	const editorKeyDownBridge = $derived({ handler: onEditorKeyDown ?? null });

	// ─── Element refs ─────────────────────────────────────────────────
	let editor: Editor | null = $state(null);
	const refs = $state({
		editorMount: null as HTMLDivElement | null,
		commandMenu: null as HTMLDivElement | null,
		bubbleMenu: null as HTMLDivElement | null,
		mentionMenu: null as HTMLDivElement | null
	});

	// ─── Bubble menu state ────────────────────────────────────────────
	let activeMarks = $state<Partial<Record<MarkName, boolean>>>({});

	// ─── Link dialog state ────────────────────────────────────────────
	let linkDialogOpen = $state(false);
	let linkDraft = $state('');

	function openLinkDialog(): void {
		const href = editor?.getAttributes('link').href;
		linkDraft = typeof href === 'string' ? href : '';
		linkDialogOpen = true;
	}

	function applyLink(): void {
		const url = linkDraft;
		linkDialogOpen = false;
		if (url === '') {
			editor?.chain().focus().extendMarkRange('link').unsetLink().run();
		} else {
			editor?.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
		}
	}

	// ─── Mention state ────────────────────────────────────────────────
	const mention = $state({
		query: '',
		visible: false,
		keyHandler: null as ((key: string) => boolean) | null,
		command: null as ((item: MentionItem) => void) | null
	});

	// ─── Command menu state ───────────────────────────────────────────
	const commandMenu = $state({
		selectedIndex: 0,
		visibleFlags: [] as boolean[]
	});

	type CommandGroup = { title: string; items: CommandItem[] };

	const COMMAND_GROUPS: CommandGroup[] = $derived.by(() => {
		const customGroups = slashCommandGroups.map((group) => ({
			title: group.title,
			items: group.items.map((item): CommandItem => ({
				title: item.title,
				description: item.description,
				icon: item.icon,
				keywords: item.keywords,
				command: ({ editor, range }) => {
					const chain = editor.chain().focus().deleteRange(range);
					if (item.insertText) chain.insertContent(item.insertText);
					chain.run();
					item.onSelect?.();
				}
			}))
		}));
		const mediaGroup: CommandGroup | null = fileAttachmentClient
			? {
					title: t('misc.markdownMedia'),
					items: [
						{
							title: t('misc.markdownInsertImage'),
							icon: 'lucide:image',
							command: ({ editor, range }) => {
								const input = document.createElement('input');
								input.type = 'file';
								input.accept = 'image/*';
								input.onchange = () => {
									const file = input.files?.[0];
									if (!file) return;
									editor.chain().focus().deleteRange(range).setFileAttachment({ file }).run();
								};
								input.click();
							}
						},
						{
							title: t('misc.markdownAttachFiles'),
							icon: 'lucide:paperclip',
							command: ({ editor, range }) => {
								const input = document.createElement('input');
								input.type = 'file';
								input.multiple = true;
								input.onchange = () => {
									const files = input.files;
									if (!files?.length) return;
									editor.chain().focus().deleteRange(range).run();
									Array.from(files).forEach((file) => {
										editor.chain().focus().setFileAttachment({ file }).run();
									});
								};
								input.click();
							}
						}
					]
				}
			: null;

		const defaultGroups: CommandGroup[] = [
			{
				title: t('misc.markdownTypography'),
				items: [
					{
						title: t('misc.markdownHeading1'),
						icon: 'lucide:heading-1',
						command: ({ editor, range }) =>
							editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run()
					},
					{
						title: t('misc.markdownHeading2'),
						icon: 'lucide:heading-2',
						command: ({ editor, range }) =>
							editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run()
					},
					{
						title: t('misc.markdownHeading3'),
						icon: 'lucide:heading-3',
						command: ({ editor, range }) =>
							editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run()
					},
					{
						title: t('misc.markdownText'),
						icon: 'lucide:text',
						command: ({ editor, range }) =>
							editor.chain().focus().deleteRange(range).setNode('paragraph').run()
					}
				]
			},
			{
				title: t('misc.markdownLists'),
				items: [
					{
						title: t('misc.markdownBulletedList'),
						icon: 'lucide:list',
						command: ({ editor, range }) =>
							editor.chain().focus().deleteRange(range).toggleBulletList().run()
					},
					{
						title: t('misc.markdownNumberedList'),
						icon: 'lucide:list-ordered',
						command: ({ editor, range }) =>
							editor.chain().focus().deleteRange(range).toggleOrderedList().run()
					},
					{
						title: t('misc.markdownChecklist'),
						icon: 'lucide:check-square',
						command: ({ editor, range }) =>
							editor.chain().focus().deleteRange(range).toggleTaskList().run()
					}
				]
			},
			...(mediaGroup ? [mediaGroup] : []),
			{
				title: t('misc.markdownAdvancedBlocks'),
				items: [
					{
						title: t('misc.markdownBlockquote'),
						icon: 'lucide:quote',
						command: ({ editor, range }) =>
							editor.chain().focus().deleteRange(range).toggleWrap('blockquote').run()
					},
					{
						title: t('misc.markdownHorizontalRule'),
						icon: 'lucide:minus',
						command: ({ editor, range }) =>
							editor.chain().focus().deleteRange(range).setNode('horizontalRule').run()
					}
				]
			}
		];
		return [...customGroups, ...(useDefaultSlashCommands ? defaultGroups : [])];
	});

	// ─── Command menu derived state ───────────────────────────────────
	const flatItems: CommandItem[] = $derived(COMMAND_GROUPS.flatMap((g) => g.items));

	const groupStartIndices: number[] = $derived.by(() => {
		const arr: number[] = [];
		let offset = 0;
		for (const g of COMMAND_GROUPS) {
			arr.push(offset);
			offset += g.items.length;
		}
		return arr;
	});

	const groupVisible = $derived(
		COMMAND_GROUPS.map((g, gi) =>
			g.items.some((_, ii) => commandMenu.visibleFlags[groupStartIndices[gi] + ii])
		)
	);

	const commandItems = $derived.by(() => {
		const items: Array<{
			value: string;
			label: string;
			disabled?: boolean;
			_type: 'group' | 'item' | 'separator';
			_groupTitle?: string;
			_item?: CommandItem;
			_idx?: number;
		}> = [];

		COMMAND_GROUPS.forEach((group, gi) => {
			if (!groupVisible[gi]) return;
			items.push({
				value: `__group_${group.title}`,
				label: group.title,
				disabled: true,
				_type: 'group',
				_groupTitle: group.title
			});
			group.items.forEach((item, ii) => {
				const idx = groupStartIndices[gi] + ii;
				if (!commandMenu.visibleFlags[idx]) return;
				items.push({
					value: String(idx),
					label: item.title,
					_type: 'item',
					_item: item,
					_idx: idx
				});
			});
			if (gi < COMMAND_GROUPS.length - 1) {
				const hasNextVisibleGroup = COMMAND_GROUPS.slice(gi + 1).some(
					(_, ngi) => groupVisible[gi + 1 + ngi]
				);
				if (hasNextVisibleGroup) {
					items.push({ value: `__sep_${gi}`, label: '', disabled: true, _type: 'separator' });
				}
			}
		});

		return items;
	});

	function handleCommandSelect(val: string) {
		const item = commandItems.find((i) => i.value === val && i._type === 'item');
		if (item?._item && editor && refs.commandMenu) {
			const { from, to } = editor.state.selection;
			item._item.command({ editor, range: { from, to } });
			refs.commandMenu.style.display = 'none';
		}
	}

	// ─── Slash command extension (factory) ────────────────────────────
	const SlashCommands = $derived(
		createSlashCommands({
			get: () => ({
				flatItems,
				visibleFlags: commandMenu.visibleFlags,
				selectedIndex: commandMenu.selectedIndex,
				menuRef: refs.commandMenu
			}),
			setFlags: (flags: boolean[]) => {
				commandMenu.visibleFlags = flags;
			},
			setIndex: (index: number) => {
				commandMenu.selectedIndex = index;
			}
		})
	);

	// ─── Extensions (computed once per variant change) ────────────────
	const extensions = $derived.by(() => {
		const base: unknown[] = [
			StarterKit.configure({
				heading: isInput ? false : { levels: [1, 2, 3] },
				blockquote: isInput ? false : undefined,
				horizontalRule: isInput ? false : undefined,
				bulletList: isInput ? false : undefined,
				orderedList: isInput ? false : undefined,
				hardBreak: isInput ? false : undefined,
				paragraph: isInput ? { HTMLAttributes: { class: 'p-0 m-0' } } : undefined,
				codeBlock: false,
				link: { openOnClick: false }
			}),
			CodeBlockLowlight.configure({ lowlight }),
			Markdown.configure({ markedOptions: { breaks: false } }),
			Placeholder.configure({ placeholder })
		];

		if (!isInput) {
			base.push(
				TaskList,
				TaskItem.configure({ nested: true }),
				Table.configure({ resizable: false }),
				TableRow,
				TableHeader,
				TableCell
			);
			if (fileAttachmentClient) {
				base.push(
					createFileAttachmentExtension({
						client: fileAttachmentClient,
						translate: t as (key: string, vars?: MessageVars) => string
					})
				);
			}
		}

		base.push(
			BubbleMenu.configure({
				element: refs.bubbleMenu,
				shouldShow: ({ editor, state }) => {
					if (!editor.isFocused || !editor.isEditable || state.selection.empty) {
						if (refs.bubbleMenu) refs.bubbleMenu.style.display = 'none';
						return false;
					}
					const { from } = state.selection;
					const name = state.doc.nodeAt(from)?.type.name ?? '';
					const hide = name === 'customCodeBlock' || name === 'fileAttachment';
					if (refs.bubbleMenu) refs.bubbleMenu.style.display = hide ? 'none' : 'flex';
					return !hide;
				}
			})
		);

		if (!isInput) {
			base.push(SlashCommands);
		}

		if (enableMentions && !isInput) {
			base.push(
				ConfiguredMention.configure({
					menuElement: refs.mentionMenu,
					onQueryChange: (q: string) => (mention.query = q),
					onCommandReady: (cmd) => (mention.command = cmd),
					onMenuVisibilityChange: (v: boolean) => (mention.visible = v),
					onKeyDown: (key: string) => mention.keyHandler?.(key) ?? false,
					metadataItems: mentionItems
				})
			);
		}

		return base as EditorOptions['extensions'];
	});

	// ─── Editor initialization ────────────────────────────────────────
	onMount(() => {
		if (!refs.editorMount || !refs.bubbleMenu) throw new Error('Editor elements not found');
		if (!isInput && !refs.commandMenu) throw new Error('Command menu element not found');
		if (enableMentions && !isInput && !refs.mentionMenu)
			throw new Error('Mention menu element not found');

		if (refs.commandMenu) refs.commandMenu.style.display = 'none';
		refs.bubbleMenu.style.display = 'none';
		if (refs.mentionMenu) refs.mentionMenu.style.display = 'none';

		editor = new Editor({
			element: refs.editorMount,
			editable: !readonly,
			contentType: 'markdown',
			editorProps: {
				attributes: {
					class: cn('tiptap h-full max-w-none', !isInput && SCROLL_AXIS_CLASSES.both)
				},
				handleKeyDown: (_view, event) => {
					if (mention.visible || refs.commandMenu?.style.display === 'block') return false;
					return editorKeyDownBridge.handler?.(event) === true;
				}
			},
			extensions,
			content: value,
			onCreate: ({ editor: createdEditor }) => {
				if (typeof value === 'string' && value.trim() && createdEditor.markdown) {
					createdEditor.commands.setContent(value, {
						contentType: 'markdown',
						emitUpdate: false
					});
				}
				if (autofocus) createdEditor.commands.focus('end');
			},
			onTransaction: (props) => {
				const next: Partial<Record<MarkName, boolean>> = {};
				for (const name of MARK_NAMES) next[name] = props.editor.isActive(name);
				activeMarks = next;
			},
			onUpdate: (event) => {
				const md = event.editor.getMarkdown();
				onValueChange?.(md);
				if (onAttachmentsChange) {
					const attachments: Array<{ name: string; url: string; type: string }> = [];
					event.editor.state.doc.descendants((node) => {
						if (node.type.name !== 'fileAttachment') return true;
						const url = node.attrs.url as string | null | undefined;
						if (!url) return true;
						attachments.push({
							name: (node.attrs.name as string) ?? 'attachment',
							url,
							type: (node.attrs.type as string) ?? 'application/octet-stream'
						});
						return true;
					});
					onAttachmentsChange(attachments);
				}
			}
		});
	});

	// ─── Reactive watchers ────────────────────────────────────────────
	watch(
		() => ({ editor, readonly, placeholder }),
		() => {
			if (!editor) return;
			if (editor.isEditable !== !readonly) editor.setEditable(!readonly);
			const pe = editor.extensionManager.extensions.find((e) => e.name === 'placeholder');
			if (pe) {
				pe.options.placeholder = placeholder;
				editor.view.dispatch(editor.state.tr);
			}
		}
	);

	watch(
		() => [value, editor, syncExternalValue] as const,
		([newValue, currentEditor, shouldSync]) => {
			if (!shouldSync || !currentEditor) return;
			const editorContent = currentEditor.getMarkdown();
			if (newValue !== editorContent) {
				currentEditor.commands.setContent(newValue ?? '', { contentType: 'markdown' });
			}
		}
	);

	watch(
		() => [filesToAttach, editor, fileAttachmentClient] as const,
		([pending, currentEditor, client]) => {
			if (!pending) return;
			if (!client) {
				filesToAttach = null;
				return;
			}
			if (!currentEditor) return;
			const files = Array.from(pending);
			filesToAttach = null;
			for (const file of files) {
				currentEditor.chain().focus().setFileAttachment({ file }).run();
			}
		}
	);

	onDestroy(() => editor?.destroy());
</script>

<!-- ─── Slash Command Menu (popover, hidden by default) ─────────── -->
{#if !isInput}
	<Command.Root
		shouldFilter={false}
		class="hidden w-[min(30rem,calc(100vw-2rem))] rounded-xl border bg-popover p-1 shadow-deep"
		bind:ref={refs.commandMenu}
		value={String(commandMenu.selectedIndex)}
		items={commandItems}
		onValueChange={handleCommandSelect}
	>
		<Command.List class="max-h-80" itemHeight={44} gap={2}>
			{#snippet itemSnippet({ item })}
				{@const itemType = item._type as 'group' | 'item' | 'separator'}
				{#if itemType === 'group'}
					<div class="px-2 py-1.5 text-xs font-medium text-muted-foreground">
						{item._groupTitle}
					</div>
				{:else if itemType === 'separator'}
					<div class="-mx-1 my-1 h-px bg-border"></div>
				{:else}
					{@const cmdItem = item._item as CommandItem}
					<Inline justify="between" gap="md" class="px-2 py-1.5">
						<Inline gap="sm" class="min-w-0">
							<Icon icon={cmdItem.icon} class="size-4 shrink-0 text-muted-foreground" />
							<div class="min-w-0 text-left">
								<div class="truncate text-sm text-foreground">{cmdItem.title}</div>
								{#if cmdItem.description}
									<div class="truncate text-meta">{cmdItem.description}</div>
								{/if}
							</div>
						</Inline>
						{#if cmdItem.shortcut}
							<span class="text-meta">{cmdItem.shortcut}</span>
						{/if}
					</Inline>
				{/if}
			{/snippet}
			{#if commandItems.filter((i) => i._type === 'item').length === 0}
				<Command.Empty>{t('misc.commandNoResults')}</Command.Empty>
			{/if}
		</Command.List>
	</Command.Root>
{/if}

<!-- ─── Main editor wrapper ──────────────────────────────────────── -->
<div
	{...controlProps}
	onclick={() => {
		if (isInteractive) editor?.commands.focus();
	}}
	role="textbox"
	tabindex={isInteractive ? 0 : -1}
	aria-multiline={!isInput}
	aria-readonly={readonly || undefined}
	class={cn(
		'rich-text-editor-wrapper relative transition-colors',
		'ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:outline-none',
		{
			'w-full': type === 'default',
			'flex h-8 w-full items-center rounded-md border border-input bg-background px-3 text-sm':
				isInput,
			'flex w-full rounded-md border border-input bg-background p-2 text-sm': isTextarea,
			[SCROLL_AXIS_CLASSES.both]: isTextarea,
			'resize-y': isTextarea && isInteractive,
			'resize-none': isTextarea && !isInteractive,
			'cursor-not-allowed opacity-50': readonly && (isInput || isTextarea)
		},
		{
			'h-full': !isInput && heightMode === 'fill',
			'min-h-[80px]': isTextarea && heightMode === 'auto'
		},
		className
	)}
>
	<div bind:this={refs.editorMount} class="h-full w-full"></div>
</div>

<!-- ─── Bubble Menu (inline formatting toolbar) ──────────────────── -->
<ToggleGroup.Root
	bind:ref={refs.bubbleMenu}
	type="multiple"
	class="hidden rounded-md border bg-background p-1 shadow-md"
	value={Object.entries(activeMarks)
		.filter(([, v]) => v)
		.map(([k]) => k)}
>
	<ToggleGroup.Item
		value="bold"
		onclick={(e: MouseEvent) => {
			e.preventDefault();
			editor?.chain().focus().toggleMark('bold').run();
		}}
		class={buttonVariants({ variant: 'ghost', size: 'icon' })}
		><Icon icon="lucide:bold" /></ToggleGroup.Item
	>
	<ToggleGroup.Item
		value="italic"
		onclick={(e: MouseEvent) => {
			e.preventDefault();
			editor?.chain().focus().toggleMark('italic').run();
		}}
		class={buttonVariants({ variant: 'ghost', size: 'icon' })}
		><Icon icon="lucide:italic" /></ToggleGroup.Item
	>
	<ToggleGroup.Item
		value="underline"
		onclick={(e: MouseEvent) => {
			e.preventDefault();
			editor?.chain().focus().toggleUnderline().run();
		}}
		class={buttonVariants({ variant: 'ghost', size: 'icon' })}
		><Icon icon="lucide:underline" /></ToggleGroup.Item
	>
	<ToggleGroup.Item
		value="strike"
		onclick={(e: MouseEvent) => {
			e.preventDefault();
			editor?.chain().focus().toggleMark('strike').run();
		}}
		class={buttonVariants({ variant: 'ghost', size: 'icon' })}
		><Icon icon="lucide:strikethrough" /></ToggleGroup.Item
	>
	<ToggleGroup.Item
		value="link"
		onclick={(e: MouseEvent) => {
			e.preventDefault();
			openLinkDialog();
		}}
		class={buttonVariants({ variant: 'ghost', size: 'icon' })}
		><Icon icon="lucide:link" /></ToggleGroup.Item
	>
</ToggleGroup.Root>

<!-- ─── Mention Menu (hidden by default, shown by Tippy.js) ──────── -->
{#if enableMentions && !isInput}
	<div bind:this={refs.mentionMenu} class="hidden">
		<MentionTreeMenu
			items={mentionItems}
			query={mention.query}
			mentionCommand={mention.command}
			isVisible={mention.visible}
			onKeyHandlerReady={(handler) => (mention.keyHandler = handler)}
			onSelect={() => {
				/* handled by ConfiguredMention */
			}}
		/>
	</div>
{/if}

<!-- ─── Link dialog (app-surface dialog instead of a native prompt) ── -->
<Dialog.Root bind:open={linkDialogOpen}>
	<Dialog.Content class="max-w-sm">
		<Dialog.Header>
			<Dialog.Title>{t('misc.markdownInsertLink')}</Dialog.Title>
		</Dialog.Header>
		<Input
			type="url"
			placeholder="https://…"
			bind:value={linkDraft}
			onkeydown={(event: KeyboardEvent) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					applyLink();
				}
			}}
		/>
		<Dialog.Footer>
			<Dialog.Close>{t('common.cancel')}</Dialog.Close>
			<button type="button" class={buttonVariants()} onclick={() => applyLink()}>
				{t('common.apply')}
			</button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<style>
	:global(.rich-text-editor-wrapper .tiptap) {
		width: 100%;
		height: 100%;
		max-width: none;
	}
	:global(.rich-text-editor-wrapper .tiptap:focus-visible) {
		outline: none;
	}
	:global(.rich-text-editor-wrapper[class*='h-full'] .tiptap) {
		padding: 0.5rem 1rem;
	}

	:global(.rich-text-editor-wrapper .tiptap p) {
		line-height: 1.75;
	}
	:global(.rich-text-editor-wrapper .tiptap p:not(:first-child)) {
		margin-top: 1.5rem;
	}
	:global(
		.rich-text-editor-wrapper[aria-multiline='false'] .tiptap p,
		.rich-text-editor-wrapper[class*='min-h-'] .tiptap p
	) {
		margin: 0;
		line-height: inherit;
	}

	:global(.rich-text-editor-wrapper .tiptap h1) {
		font-size: 2.25rem;
		font-weight: 700;
		line-height: 2.5rem;
	}
	:global(.rich-text-editor-wrapper .tiptap h2) {
		margin-top: 2.5rem;
		padding-bottom: 0.5rem;
		font-size: 1.875rem;
		font-weight: 600;
		line-height: 2.25rem;
	}
	:global(.rich-text-editor-wrapper .tiptap h3) {
		margin-top: 2rem;
		font-size: 1.5rem;
		font-weight: 600;
		line-height: 2rem;
	}
	:global(
		.rich-text-editor-wrapper .tiptap h1:first-child,
		.tiptap h2:first-child,
		.tiptap h3:first-child
	) {
		margin-top: 0;
	}

	:global(.rich-text-editor-wrapper .tiptap a) {
		color: var(--primary);
		font-weight: 500;
		text-decoration-line: underline;
		text-underline-offset: 4px;
		cursor: pointer;
	}
	:global(.rich-text-editor-wrapper .tiptap code) {
		background-color: var(--muted);
		position: relative;
		border-radius: 0.25rem;
		padding: 0.1rem 0.3rem;
		font-family: var(--font-mono);
		font-size: 0.875rem;
	}

	:global(.rich-text-editor-wrapper .tiptap .tableWrapper) {
		margin-top: 1rem;
		width: fit-content;
		max-width: 100%;
		margin-right: auto;
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		background: var(--background);
	}
	:global(.rich-text-editor-wrapper .tiptap table) {
		width: max-content;
		min-width: max-content;
		border-collapse: separate;
		border-spacing: 0;
		font-size: 0.75rem;
		line-height: 1rem;
	}
	:global(.rich-text-editor-wrapper .tiptap th) {
		height: 2.375rem;
		padding: 0.5rem 0.75rem;
		background: var(--accent);
		text-align: left;
		font-size: 0.8125rem;
		font-weight: 500;
		vertical-align: middle;
		border-bottom: 1px solid var(--border);
	}
	:global(.rich-text-editor-wrapper .tiptap td) {
		padding: 0.625rem 0.75rem;
		vertical-align: middle;
		border-bottom: 1px solid var(--border);
	}
	:global(
		.rich-text-editor-wrapper .tiptap th:not(:last-child),
		.rich-text-editor-wrapper .tiptap td:not(:last-child)
	) {
		border-right: 1px solid var(--border);
	}
	:global(.rich-text-editor-wrapper .tiptap tbody tr:last-child td) {
		border-bottom: none;
	}
	:global(.rich-text-editor-wrapper .tiptap th p),
	:global(.rich-text-editor-wrapper .tiptap td p) {
		margin: 0;
		line-height: 1.4;
	}

	:global(.rich-text-editor-wrapper .ProseMirror p.is-editor-empty:first-child::before) {
		color: var(--muted-foreground);
		content: attr(data-placeholder);
		float: left;
		height: 0;
		pointer-events: none;
	}
	:global(.rich-text-editor-wrapper .ProseMirror-selectednode > *:first-child) {
		box-shadow: 0 0 0 3px var(--primary) !important;
		outline: none !important;
	}

	:global(.rich-text-editor-wrapper ul[data-type='taskList']) {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	:global(.rich-text-editor-wrapper ul[data-type='taskList'] li) {
		display: flex;
		margin: 0.25rem 0;
	}
	:global(.rich-text-editor-wrapper ul[data-type='taskList'] label) {
		margin-right: 0.5rem;
	}
	:global(.rich-text-editor-wrapper ul[data-type='taskList'] input[type='checkbox']) {
		accent-color: var(--primary);
		width: 1rem;
		height: 1rem;
		cursor: pointer;
	}
</style>
