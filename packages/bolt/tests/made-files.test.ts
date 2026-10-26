// @vitest-environment happy-dom
import './setup-happy-dom.ts';
import { expect, it, vi } from '@effect/vitest';
import { flushSync, mount, unmount } from 'svelte';
import MadeFiles from '../src/shell/agent/MadeFiles.svelte';

it('requests image previews, preserves original downloads and recovers when an image fails', async () => {
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(MadeFiles, {
		target,
		props: {
			rail: true,
			files: [
				{ id: 'image', name: 'photo.png', mime: 'image/png' },
				{
					id: 'document',
					name: 'report.docx',
					mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
				},
				{ name: 'pending.txt', mime: 'text/plain' }
			],
			fileHref: (id: string) => `/files/${id}?token=fixture`,
			t: (key: string) => key
		}
	});
	try {
		flushSync();
		const image = target.querySelector('img');
		if (image === null) throw new Error('The rail image thumbnail did not render');
		const preview = new URL(image.getAttribute('src') ?? '', 'https://fixture.test');
		expect(preview.pathname).toBe('/files/image');
		expect(preview.searchParams.get('token')).toBe('fixture');
		expect(preview.searchParams.has('preview')).toBe(true);
		expect(target.querySelector('a[download="photo.png"]')?.getAttribute('href')).toBe(
			'/files/image?token=fixture'
		);
		const doc = target.querySelector('[data-made-file="report.docx"]');
		expect(doc?.textContent).toContain('report.docx');
		expect(
			target.querySelector(
				'[data-made-file="pending.txt"] a, [data-made-file="pending.txt"] button'
			)
		).toBeNull();
		image.dispatchEvent(new Event('error'));
		flushSync();
		expect(target.querySelector('[data-made-file="photo.png"] img')).toBeNull();
		expect(target.querySelector('[data-made-file="photo.png"]')?.textContent).toContain(
			'photo.png'
		);
		expect(target.querySelector('a[download="photo.png"]')?.getAttribute('href')).toBe(
			'/files/image?token=fixture'
		);
	} finally {
		await unmount(view);
		target.remove();
	}
});

it('opens a PDF viewer only on request and closes it with Escape', async () => {
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(MadeFiles, {
		target,
		props: {
			rail: true,
			files: [{ id: 'pdf', name: 'report.pdf', mime: 'application/pdf' }],
			fileHref: () => 'about:blank',
			t: (key: string) => key
		}
	});
	try {
		flushSync();
		expect(document.querySelector('[data-made-pdf-full]')).toBeNull();
		const preview = target.querySelector<HTMLButtonElement>('[data-made-preview]');
		if (preview === null) throw new Error('The PDF preview button did not render');
		preview.click();
		await vi.waitFor(() => expect(document.querySelector('[data-made-pdf-full]')).not.toBeNull());
		const frame = document.querySelector<HTMLIFrameElement>('[data-made-pdf-full]');
		if (frame === null) throw new Error('The PDF viewer did not open');
		expect(frame.title).toBe('report.pdf');
		expect(frame.getAttribute('src')?.split('#')[0]).toBe('about:blank');
		frame.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await vi.waitFor(() => expect(document.querySelector('[data-made-pdf-full]')).toBeNull());
	} finally {
		await unmount(view);
		target.remove();
	}
});
