import './dom.ts';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { flushSync, mount, unmount } from 'svelte';
import { expect, it, vi } from 'vitest';
import RichMarkdownEditor from '../src/editors/rich-markdown-editor.svelte';
import { rich_markdown } from '../src/editors/rich-markdown.js';
import { mount_edge } from '../src/effect/index.js';

it('edits Markdown as it reads and gives Markdown back', () => {
	const element = document.body.appendChild(document.createElement('div'));
	const written: string[] = [];
	const editor = rich_markdown(
		element,
		{
			value: '# Pour\n\nSlab **L6** cast.',
			placeholder: '',
			editable: true,
			label: undefined,
			id: undefined
		},
		{ on_markdown: (md) => written.push(md), on_transaction: () => {}, on_pictures: () => false }
	);
	expect(element.querySelector('h1')?.textContent).toBe('Pour');
	expect(element.querySelector('strong')?.textContent).toBe('L6');
	editor.chain().focus('end').insertContent(' Cubes next.').run();
	expect(written.at(-1)).toBe('# Pour\n\nSlab **L6** cast. Cubes next.');
	editor.destroy();
});

it('renders borderless without a static toolbar, supports autofocus and stores pasted pictures', async () => {
	const dispose = mount_edge(ManagedRuntime.make(Layer.empty));
	const target = document.body.appendChild(document.createElement('div'));
	let value = 'Before';
	const view = mount(RichMarkdownEditor, {
		target,
		props: {
			value,
			autofocus: true,
			on_change: (next: string) => (value = next),
			upload: () => Effect.succeed('/files/picture-1')
		}
	});
	await vi.waitFor(() => expect(target.querySelector('[contenteditable]')).not.toBeNull());
	flushSync();
	expect(target.querySelector('[role="toolbar"]')).toBeNull();
	const content = target.querySelector('[contenteditable]');
	expect(document.activeElement).toBe(content);
	const transfer = new DataTransfer();
	transfer.items.add(
		new File([new Uint8Array([137, 80, 78, 71])], 'site.png', { type: 'image/png' })
	);
	content?.dispatchEvent(
		new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
	);
	await vi.waitFor(() => expect(value).toContain('![site.png](/files/picture-1)'));
	expect(target.querySelector('img')?.getAttribute('src')).toBe('/files/picture-1');
	unmount(view);
	await dispose();
});

it('opens floating slash menu on `/` and floating bubble menu on text selection', async () => {
	const dispose = mount_edge(ManagedRuntime.make(Layer.empty));
	const target = document.body.appendChild(document.createElement('div'));
	let value = '';
	const view = mount(RichMarkdownEditor, {
		target,
		props: {
			value,
			autofocus: true,
			on_change: (next: string) => (value = next)
		}
	});
	await vi.waitFor(() => expect(target.querySelector('[contenteditable]')).not.toBeNull());
	flushSync();
	const content = target.querySelector<HTMLElement>('[contenteditable]');
	if (!content) throw new Error('Expected contenteditable element');

	// Trigger `/` slash command by typing `/h2` via text insertion
	const p = content.querySelector('p');
	if (!p) throw new Error('Expected paragraph');
	p.textContent = '/h2';
	const sel = window.getSelection();
	if (sel) {
		const range = document.createRange();
		range.setStart(p.firstChild ?? p, 3);
		range.collapse(true);
		sel.removeAllRanges();
		sel.addRange(range);
	}
	content.dispatchEvent(new InputEvent('input', { bubbles: true }));
	await vi.waitFor(() => expect(document.querySelector('[data-rich-slash-menu]')).not.toBeNull());
	const h2Button = document.querySelector<HTMLButtonElement>('[data-slash-item="h2"] button');
	expect(h2Button).not.toBeNull();
	h2Button?.click();
	flushSync();
	await vi.waitFor(() => expect(content.querySelector('h2')).not.toBeNull());
	expect(document.querySelector('[data-rich-slash-menu]')).toBeNull();

	// Insert text inside the heading and select a word to trigger the floating bubble menu
	const h2 = content.querySelector('h2');
	if (!h2) throw new Error('Expected h2');
	h2.textContent = 'Pour checklist';
	content.dispatchEvent(new InputEvent('input', { bubbles: true }));
	await vi.waitFor(() => expect(value).toContain('Pour checklist'));
	if (sel && h2.firstChild) {
		const range = document.createRange();
		range.setStart(h2.firstChild, 0);
		range.setEnd(h2.firstChild, 4);
		sel.removeAllRanges();
		sel.addRange(range);
		document.dispatchEvent(new Event('selectionchange'));
	}
	await vi.waitFor(() => expect(document.querySelector('[data-rich-bubble-menu]')).not.toBeNull());
	const boldButton = document.querySelector<HTMLButtonElement>(
		'[data-rich-bubble-menu] button[aria-label="Bold"]'
	);
	expect(boldButton).not.toBeNull();
	boldButton?.click();
	flushSync();
	await vi.waitFor(() => expect(value).toContain('**Pour**'));

	unmount(view);
	await dispose();
});
