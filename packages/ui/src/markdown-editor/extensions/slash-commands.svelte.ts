/**
 * Factory that creates a `/` slash-command Tiptap extension.
 *
 * The extension renders a command palette via tippy.js when the user types `/`.
 * Navigation state (`visibleFlags`, `selectedIndex`) and the menu DOM element
 * (`menuRef`) are owned by the caller so that a Svelte Command.Root can render
 * the menu content reactively.
 */
import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import type { Instance } from 'tippy.js';
import * as TippyModule from 'tippy.js';

export interface CommandItem {
	title: string;
	description?: string;
	icon: string;
	shortcut?: string;
	keywords?: string[];
	command: (opts: {
		editor: import('@tiptap/core').Editor;
		range: import('@tiptap/core').Range;
	}) => void;
}

export interface SlashCommandState {
	flatItems: CommandItem[];
	visibleFlags: boolean[];
	selectedIndex: number;
	menuRef: HTMLDivElement | null;
}

export function createSlashCommands(stateAccessor: {
	get: () => SlashCommandState;
	setFlags: (flags: boolean[]) => void;
	setIndex: (index: number) => void;
}) {
	return Extension.create({
		name: 'slashCommands',
		addOptions() {
			return { suggestion: { char: '/' } as const };
		},
		addProseMirrorPlugins() {
			return [
				Suggestion<CommandItem>({
					editor: this.editor,
					pluginKey: new PluginKey('slashCommands'),
					allowSpaces: true,
					decorationClass: 'bg-primary/10 rounded-md p-1',
					char: '/',
					command: ({ editor, range, props }) => {
						props.command({ editor, range });
					},
					allow: ({ state, range }) => {
						const from = state.doc.resolve(range.from);
						const type = state.schema.nodes[from.parent.type.name];
						if (!type?.contentMatch.matchType(state.schema.nodes.text)) return false;
						const text = state.doc.textBetween(range.from, range.to, '\0', '\0');
						const query = text.substring(1);
						return !query.includes('  ') && !query.includes('\u200B');
					},
					render: () => {
						let popup: Instance | null = null;
						let dummy: HTMLElement;
						let currEditor: import('@tiptap/core').Editor;
						let currRange: import('@tiptap/core').Range;

						const { get, setFlags, setIndex } = stateAccessor;

						const visibleIndices = () =>
							get()
								.visibleFlags.map((v, i) => (v ? i : -1))
								.filter((i) => i !== -1);

						const navigateItems = (direction: -1 | 1) => {
							const indices = visibleIndices();
							if (indices.length === 0) return;
							const currentIdx = indices.indexOf(get().selectedIndex);
							if (currentIdx === -1) {
								setIndex(direction === 1 ? indices[0] : indices[indices.length - 1]);
							} else {
								setIndex(indices[(currentIdx + direction + indices.length) % indices.length]);
							}
						};

						const selectCurrentItem = () => {
							const s = get();
							if (!s.visibleFlags[s.selectedIndex]) return false;
							const item = s.flatItems[s.selectedIndex];
							if (item && currEditor && currRange) {
								item.command({ editor: currEditor, range: currRange });
								return true;
							}
							return false;
						};

						return {
							onStart: (props) => {
								const s = get();
								if (!s.menuRef) return;
								setFlags(s.flatItems.map(() => true));
								setIndex(s.flatItems.length > 0 ? 0 : -1);
								s.menuRef.style.display = 'block';
								dummy = document.createElement('div');
								document.body.appendChild(dummy);
								popup = TippyModule.default(dummy, {
									getReferenceClientRect: () => props.clientRect?.() ?? new DOMRect(),
									appendTo: document.body,
									content: s.menuRef,
									showOnCreate: true,
									interactive: true,
									trigger: 'manual',
									placement: 'bottom-start'
								});
								popup?.show();
								currEditor = props.editor;
								currRange = props.range;
							},
							onUpdate: (props) => {
								const s = get();
								const query = props.query.trim().toLowerCase();
								const flags = s.flatItems.map((item) => {
									const searchable = [item.title, item.description, ...(item.keywords ?? [])]
										.filter((value): value is string => Boolean(value))
										.join(' ')
										.toLowerCase();
									return query === '' || searchable.includes(query);
								});
								setFlags(flags);
								if (!flags[s.selectedIndex]) {
									const firstVisible = flags.findIndex((v) => v);
									setIndex(firstVisible);
								}
								popup?.setProps({
									getReferenceClientRect: () => props.clientRect?.() ?? new DOMRect()
								});
								currEditor = props.editor;
								currRange = props.range;
							},
							onKeyDown: (props) => {
								const { event } = props;
								switch (event.key) {
									case 'ArrowDown':
										event.preventDefault();
										event.stopPropagation();
										navigateItems(1);
										return true;
									case 'ArrowUp':
										event.preventDefault();
										event.stopPropagation();
										navigateItems(-1);
										return true;
									case 'Enter':
										event.preventDefault();
										event.stopPropagation();
										return selectCurrentItem();
									case 'Escape':
									case 'Tab':
										event.preventDefault();
										event.stopPropagation();
										const text = currEditor.state.doc.textBetween(currRange.from, currRange.to);
										currEditor.chain().focus().insertContentAt(currRange, `${text}\u200B`).run();
										return true;
								}
								return false;
							},
							onExit: () => {
								popup?.destroy();
								dummy?.remove();
								const s = get();
								if (s.menuRef) s.menuRef.style.display = 'none';
							}
						};
					}
				})
			];
		}
	});
}
