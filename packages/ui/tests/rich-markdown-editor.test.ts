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

it('stores a pasted picture through upload and shows it in place as Markdown', async () => {
	const dispose = mount_edge(ManagedRuntime.make(Layer.empty));
	const target = document.body.appendChild(document.createElement('div'));
	let value = 'Before';
	const view = mount(RichMarkdownEditor, {
		target,
		props: {
			value,
			on_change: (next: string) => (value = next),
			upload: () => Effect.succeed('/files/picture-1')
		}
	});
	await vi.waitFor(() => expect(target.querySelector('[contenteditable]')).not.toBeNull());
	flushSync();
	const content = target.querySelector('[contenteditable]');
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
