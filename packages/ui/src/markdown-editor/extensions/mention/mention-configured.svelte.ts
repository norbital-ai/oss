/**
 * @file mention-configured.svelte.ts
 * @description Configured Tiptap Mention extension with Svelte NodeView for badge rendering
 */

import type {
	AnyExtension,
	Editor,
	NodeViewRenderer,
	NodeViewRendererProps,
	Range
} from '@tiptap/core';
import type { MentionOptions } from '@tiptap/extension-mention';
import Mention from '@tiptap/extension-mention';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { PluginKey } from '@tiptap/pm/state';
import type { SuggestionOptions } from '@tiptap/suggestion';
import type { Node as ProsemirrorNode } from 'prosemirror-model';
import { mount } from 'svelte';
import type { Instance } from 'tippy.js';
import * as TippyModule from 'tippy.js';
import { Schema } from 'effect';
import MentionTagView from './mention-tag-view.svelte';

const tippy = TippyModule.default;

// =================================================================================
// TYPE DEFINITIONS
// =================================================================================

// Declare module augmentation for custom commands
declare module '@tiptap/core' {
	interface Commands<ReturnType> {
		mention: {
			/**
			 * Remove a specific mention by ID
			 */
			removeMention: (id: string) => ReturnType;
			/**
			 * Clear all mention nodes from the document
			 */
			clearAllMentions: () => ReturnType;
		};
	}
}

const MentionItemSchema = Schema.Struct({
	id: Schema.mutableKey(Schema.String),
	type: Schema.mutableKey(
		Schema.Literals([
			'collection',
			'column',
			'route',
			'template',
			'workspace',
			'folder',
			'file',
			'user'
		])
	),
	label: Schema.mutableKey(Schema.String),
	description: Schema.mutableKey(Schema.String),
	icon: Schema.mutableKey(Schema.String),
	metadata: Schema.mutableKey(Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))),
	parentId: Schema.mutableKey(Schema.optionalKey(Schema.String))
});
export type MentionItem = typeof MentionItemSchema.Type;

interface ConfiguredMentionOptions {
	/** Callback when a mention is deleted */
	onMentionDelete?: (id: string) => void;
	/** The element that will contain the mention menu */
	menuElement?: HTMLElement | null;
	/** Callback to update the search query */
	onQueryChange?: (query: string) => void;
	/** Callback to receive the command function for inserting mentions */
	onCommandReady?: (command: (item: MentionItem) => void) => void;
	/** Metadata items for enriching mentions */
	metadataItems?: MentionItem[];
	/** Callback when the mention menu visibility changes */
	onMenuVisibilityChange?: (visible: boolean) => void;
	/** Callback when a navigation key is pressed (returns true if handled) */
	onKeyDown?: (key: string) => boolean;
}

interface MentionCommandPayload {
	editor: Editor;
	range: Range;
	props: MentionItem;
}

interface MentionCommandContext {
	editor: Editor;
	range: Range;
	command: (payload: MentionCommandPayload) => void;
}

// =================================================================================
// CONFIGURED MENTION EXTENSION
// =================================================================================

type ExtendedMentionOptions = MentionOptions & ConfiguredMentionOptions;

export const ConfiguredMention = Mention.extend<ExtendedMentionOptions>({
	addOptions(): ExtendedMentionOptions {
		const parentOptions = this.parent?.() as ExtendedMentionOptions | undefined;
		const suggestionConfig: Partial<SuggestionOptions<MentionItem>> = {
			char: '@',
			pluginKey: new PluginKey('mention'),
			allowSpaces: true,
			command: ({ editor, range, props: item }) => {
				// Insert the mention node inline at the exact position
				editor
					.chain()
					.focus()
					.insertContentAt(range, [
						{
							type: 'mention',
							attrs: {
								id: item.id,
								label: item.label,
								description: item.description,
								icon: item.icon,
								metadata: item.metadata,
								itemType: item.type
							}
						},
						{
							type: 'text',
							text: ' '
						}
					])
					.run();
			},
			allow: ({ state, range }) => {
				const from = state.doc.resolve(range.from);
				const type = state.schema.nodes[from.parent.type.name];
				const isTextNode = !!type && !!type.contentMatch.matchType(state.schema.nodes.text);

				if (!isTextNode) {
					return false;
				}

				// Check for double spaces
				const text = state.doc.textBetween(range.from, range.to, '\0', '\0');
				const query = text.substring(1);
				if (query.includes('  ') || query.includes('\u200B')) {
					return false;
				}

				return true;
			},
			render: () => {
				let popup: Instance | null = null;
				let dummy: HTMLElement;
				let currentEditor: Editor | null = null;
				const notifyCommandReady = (
					props: MentionCommandContext,
					opts: ExtendedMentionOptions | undefined
				) => {
					opts?.onCommandReady?.((item) => {
						props.command({ editor: props.editor, range: props.range, props: item });
					});
				};

				// Helper to get options from the editor at runtime
				const getOptions = (editor: Editor): ExtendedMentionOptions | undefined => {
					const mentionExtension = editor.extensionManager.extensions.find(
						(ext: AnyExtension) => ext.name === 'mention'
					);
					return mentionExtension?.options as ExtendedMentionOptions | undefined;
				};

				return {
					onStart: (props) => {
						currentEditor = props.editor;
						const opts = getOptions(props.editor);
						const menuElement = opts?.menuElement;
						if (!menuElement) {
							return;
						}

						notifyCommandReady(props, opts);

						menuElement.style.display = 'block';

						// Notify that menu is now visible
						opts?.onMenuVisibilityChange?.(true);

						// Initialize with empty query
						opts?.onQueryChange?.('');

						// Create dummy element for tippy positioning
						dummy = document.createElement('div');
						document.body.appendChild(dummy);

						popup = tippy(dummy, {
							getReferenceClientRect: () => props.clientRect?.() ?? new DOMRect(),
							appendTo: document.body,
							content: menuElement,
							showOnCreate: true,
							interactive: true,
							trigger: 'manual',
							placement: 'bottom-start',
							maxWidth: 400
						});

						popup.show();
					},

					onUpdate: (props) => {
						const opts = getOptions(props.editor);

						notifyCommandReady(props, opts);

						// Update query for filtering
						opts?.onQueryChange?.(props.query);

						popup?.setProps({
							getReferenceClientRect: () => props.clientRect?.() ?? new DOMRect()
						});
					},

					onKeyDown: (props) => {
						if (!currentEditor) return false;
						const opts = getOptions(currentEditor);
						const { key } = props.event;

						// Handle Escape to close the menu
						if (key === 'Escape') {
							return true;
						}

						// Handle navigation keys - delegate to the tree menu via callback
						if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(key)) {
							// Call the onKeyDown callback if provided
							const handled = opts?.onKeyDown?.(key) ?? false;
							if (handled) {
								props.event.preventDefault();
								props.event.stopPropagation();
								return true;
							}
						}

						return false;
					},

					onExit: () => {
						if (!currentEditor) return;
						const opts = getOptions(currentEditor);
						const menuElement = opts?.menuElement;
						if (!menuElement) return;

						popup?.destroy();
						dummy?.remove();
						menuElement.style.display = 'none';

						// Notify that menu is now hidden
						opts?.onMenuVisibilityChange?.(false);
					}
				};
			}
		};
		return {
			...parentOptions,
			HTMLAttributes: {},
			renderText({ node }) {
				return node.attrs.description || node.attrs.label || `@${node.attrs.id}`;
			},
			renderHTML({ node }) {
				// OPTIMIZED: Store only id + type for minimal DB footprint
				// Other attributes resolved at parse time from metadata service
				const attrs: Record<string, string> = {
					'data-type': 'mention',
					'data-id': node.attrs.id,
					'data-item-type': node.attrs.itemType
				};

				return ['span', attrs, `@${node.attrs.label || node.attrs.id}`];
			},
			deleteTriggerWithBackspace: true,
			onMentionDelete: undefined as ConfiguredMentionOptions['onMentionDelete'],
			menuElement: null as ConfiguredMentionOptions['menuElement'],
			onQueryChange: undefined as ConfiguredMentionOptions['onQueryChange'],
			suggestion: suggestionConfig
		} as ExtendedMentionOptions;
	},

	addAttributes() {
		// Get parent attributes and merge with our custom ones
		const parentAttrs = this.parent?.() || {};

		return {
			...parentAttrs,
			// These attributes are used by the NodeView.
			description: {
				default: null,
				renderHTML: () => ({}) // NOT persisted (optimized storage)
			},
			icon: {
				default: null,
				renderHTML: () => ({}) // NOT persisted (optimized storage)
			},
			metadata: {
				default: null,
				renderHTML: () => ({}) // NOT persisted (optimized storage)
			},
			itemType: {
				default: null,
				renderHTML: (attributes) => {
					// This IS persisted (minimal storage - just type)
					if (!attributes.itemType) return {};
					return { 'data-item-type': attributes.itemType };
				}
			}
		};
	},

	addNodeView(): NodeViewRenderer {
		return (props: NodeViewRendererProps) => {
			const dom = document.createElement('span');
			dom.setAttribute('contenteditable', 'false');
			dom.style.display = 'inline-block';
			dom.style.verticalAlign = 'middle';

			const opts = this.options;
			const componentProps = $state({
				editor: props.editor,
				node: props.node,
				getPos: props.getPos,
				onDelete: opts.onMentionDelete,
				metadataItems: opts.metadataItems || []
			});

			mount(MentionTagView, {
				target: dom,
				props: componentProps
			});

			return {
				dom,
				update: (updatedNode: ProsemirrorNode) => {
					if (updatedNode.type.name !== this.name) {
						return false;
					}
					componentProps.node = updatedNode;
					return true;
				}
			};
		};
	},

	addCommands() {
		return {
			/**
			 * Remove a specific mention by ID
			 */
			removeMention:
				(id: string) =>
				({
					state,
					tr,
					dispatch
				}: {
					state: EditorState;
					tr: Transaction;
					dispatch?: (tr: Transaction) => void;
				}) => {
					// Collect all positions of mention nodes with this ID
					const nodesToDelete: Array<{ pos: number; size: number }> = [];
					state.doc.descendants((node: ProsemirrorNode, pos: number) => {
						if (node.type.name === this.name && node.attrs.id === id) {
							nodesToDelete.push({ pos, size: node.nodeSize });
						}
					});

					// Delete in reverse order to avoid position shifting issues
					nodesToDelete.reverse().forEach(({ pos, size }) => {
						tr.delete(pos, pos + size);
					});

					if (nodesToDelete.length > 0 && dispatch) {
						dispatch(tr);
						return true;
					}

					return false;
				},

			/**
			 * Clear all mention nodes from the document
			 */
			clearAllMentions:
				() =>
				({
					state,
					tr,
					dispatch
				}: {
					state: EditorState;
					tr: Transaction;
					dispatch?: (tr: Transaction) => void;
				}) => {
					// Collect all mention positions
					const nodesToDelete: Array<{ pos: number; size: number }> = [];
					state.doc.descendants((node: ProsemirrorNode, pos: number) => {
						if (node.type.name === this.name) {
							nodesToDelete.push({ pos, size: node.nodeSize });
						}
					});

					// Delete in reverse order to avoid position shifting issues
					nodesToDelete.reverse().forEach(({ pos, size }) => {
						tr.delete(pos, pos + size);
					});

					if (nodesToDelete.length > 0 && dispatch) {
						dispatch(tr);
						return true;
					}

					return false;
				}
		};
	},

	addKeyboardShortcuts() {
		return {
			Backspace: () => {
				const { state } = this.editor;
				const { selection } = state;
				const { $from: from } = selection;

				// Check if cursor is right after a mention
				const nodeBeforeCursor = from.nodeBefore;
				if (nodeBeforeCursor && nodeBeforeCursor.type.name === this.name) {
					// Get the mention's ID
					const mentionId = nodeBeforeCursor.attrs.id;

					// Call the onDelete callback
					const opts = this.options;
					if (opts.onMentionDelete && mentionId) {
						opts.onMentionDelete(mentionId);
					}

					// Delete the node
					return this.editor.commands.deleteNode(this.name);
				}

				return false;
			},
			Delete: () => {
				const { state } = this.editor;
				const { selection } = state;
				const { $from: from } = selection;

				// Check if cursor is right before a mention
				const nodeAfterCursor = from.nodeAfter;
				if (nodeAfterCursor && nodeAfterCursor.type.name === this.name) {
					// Get the mention's ID
					const mentionId = nodeAfterCursor.attrs.id;

					// Call the onDelete callback
					const opts = this.options;
					if (opts.onMentionDelete && mentionId) {
						opts.onMentionDelete(mentionId);
					}

					// Delete the node
					return this.editor.commands.deleteNode(this.name);
				}

				return false;
			}
		};
	}
});
