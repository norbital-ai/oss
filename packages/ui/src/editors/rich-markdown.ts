// The WYSIWYG Markdown editor's engine (tiptap), loaded on first use: a page that never edits Markdown never fetches it.
import { Editor } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';

export type { Editor };

/** What the editor tells its owner: each edit as Markdown, each transaction/selection/focus change, key interception, and pictures. */
export type RichMarkdownHooks = {
	readonly on_markdown: (markdown: string) => void;
	readonly on_transaction: () => void;
	readonly on_focus?: (focused: boolean) => void;
	readonly on_keydown?: (event: KeyboardEvent) => boolean;
	/** Pictures pasted or dropped at a document position; `false` leaves the event to the editor (no pictures taken). */
	readonly on_pictures: (files: readonly File[], at: number | null) => boolean;
};

const pictures = (list: FileList | null | undefined): File[] =>
	[...(list ?? [])].filter((file) => file.type.startsWith('image/'));

/** A Markdown document edited as it reads: marks, headings, lists, quotes, code, links and pictures. */
export const rich_markdown = (
	element: HTMLElement,
	options: {
		readonly value: string;
		readonly placeholder: string;
		readonly editable: boolean;
		readonly autofocus?: boolean;
		readonly label: string | undefined;
		readonly id: string | undefined;
	},
	hooks: RichMarkdownHooks
): Editor =>
	new Editor({
		element,
		extensions: [
			StarterKit.configure({ link: { openOnClick: false, autolink: true, linkOnPaste: true } }),
			Image,
			Markdown,
			Placeholder.configure({ placeholder: options.placeholder })
		],
		content: options.value,
		contentType: 'markdown',
		editable: options.editable,
		autofocus: options.autofocus && options.editable ? 'end' : false,
		editorProps: {
			attributes: {
				class:
					'rich-markdown prose prose-sm max-w-none dark:prose-invert min-h-full flex-1 focus:outline-none',
				role: 'textbox',
				'aria-multiline': 'true',
				...(options.label === undefined ? {} : { 'aria-label': options.label }),
				...(options.id === undefined ? {} : { id: options.id })
			},
			handleKeyDown: (_view, event) => hooks.on_keydown?.(event) ?? false,
			handlePaste: (_view, event) => {
				const files = pictures(event.clipboardData?.files);
				return files.length > 0 && hooks.on_pictures(files, null);
			},
			handleDrop: (view, event) => {
				const files = pictures(event.dataTransfer?.files);
				if (files.length === 0) return false;
				const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null;
				return hooks.on_pictures(files, at);
			}
		},
		onUpdate: ({ editor }) => hooks.on_markdown(editor.getMarkdown()),
		onTransaction: () => hooks.on_transaction(),
		onFocus: () => hooks.on_focus?.(true),
		onBlur: () => hooks.on_focus?.(false)
	});
