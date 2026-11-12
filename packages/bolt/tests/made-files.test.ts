// @vitest-environment happy-dom
import './setup-happy-dom.ts';
import { expect, it, vi } from '@effect/vitest';
import { flushSync, mount, unmount } from 'svelte';
import Attachments from '../src/shell/agent/Attachments.svelte';

it('requests image previews, preserves original downloads and recovers when an image fails', async () => {
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(Attachments, {
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
			file_href: (id: string) => `/files/${id}?token=fixture`,
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
		const doc = target.querySelector('[data-attachment="report.docx"]');
		expect(doc?.textContent).toContain('report.docx');
		expect(
			target.querySelector(
				'[data-attachment="pending.txt"] a, [data-attachment="pending.txt"] button'
			)
		).toBeNull();
		image.dispatchEvent(new Event('error'));
		flushSync();
		expect(target.querySelector('[data-attachment="photo.png"] img')).toBeNull();
		expect(target.querySelector('[data-attachment="photo.png"]')?.textContent).toContain(
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
	const view = mount(Attachments, {
		target,
		props: {
			rail: true,
			files: [{ id: 'pdf', name: 'report.pdf', mime: 'application/pdf' }],
			file_href: () => 'about:blank',
			t: (key: string) => key
		}
	});
	try {
		flushSync();
		expect(document.querySelector('iframe[title="report.pdf"]')).toBeNull();
		const preview = target.querySelector<HTMLButtonElement>('button[aria-label="Preview report.pdf"]');
		if (preview === null) throw new Error('The PDF preview button did not render');
		preview.click();
		await vi.waitFor(() => expect(document.querySelector('iframe[title="report.pdf"]')).not.toBeNull());
		const frame = document.querySelector<HTMLIFrameElement>('iframe[title="report.pdf"]');
		if (frame === null) throw new Error('The PDF viewer did not open');
		expect(frame.title).toBe('report.pdf');
		expect(frame.getAttribute('src')?.split('#')[0]).toBe('about:blank');
		frame.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await vi.waitFor(() => expect(document.querySelector('iframe[title="report.pdf"]')).toBeNull());
	} finally {
		await unmount(view);
		target.remove();
	}
});
