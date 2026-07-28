// Reexport tiptap editor types.
import { Editor } from '@tiptap/core';
export {
	createFileAttachmentExtension,
	extractFileMetadata
} from './extensions/attachment/attachment-extension.svelte';
export { ConfiguredMention } from './extensions/mention/mention-configured.svelte';
export { default as MentionTreeMenu } from './extensions/mention/mention-tree-menu.svelte';
export { default as MarkdownEditor } from './markdown-editor.svelte';
export { default as ReadonlyMarkdown } from './readonly-markdown.svelte';
export { Editor };
