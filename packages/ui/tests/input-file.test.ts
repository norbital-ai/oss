import './dom.ts';
import assert from 'node:assert/strict';
import { it, afterEach } from '@effect/vitest';
import type { ComponentProps } from 'svelte';
import { vi } from 'vitest';
import { browser } from './view-fixture.ts';
import { element } from './elements.ts';
import { reactive } from './kit-state.svelte.js';
const { flushSync, mount, unmount } = await import('svelte');
const { default: Input } = await import('../src/primitives/input/input.svelte');
const mounted: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of mounted.splice(0).reverse()) await close();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it.live('a file input mounts without binding value and reports its files', () =>
	browser(async () => {
		const target = document.createElement('div');
		document.body.append(target);
		let seen: FileList | null | undefined;
		const app = mount(Input, {
			target,
			props: { type: 'file', onFiles: (files: FileList | null) => (seen = files) }
		});
		try {
			flushSync();
			const input = target.querySelector<HTMLInputElement>('input[type=file]');
			assert.ok(input);
			input.dispatchEvent(new Event('change', { bubbles: true }));
			flushSync();
			assert.equal(seen, input.files);
		} finally {
			await unmount(app);
			target.remove();
		}
	})
);

it.live(
	'readonly input keeps current text while its copy control loads, then copies the current value',
	() =>
		browser(async () => {
			const copied = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
			const target = document.body.appendChild(document.createElement('div'));
			const props = reactive<ComponentProps<typeof Input>>({
				readonly: true,
				value: 0,
				id: 'readonly-value'
			});
			const app = mount(Input, { target, props });
			mounted.push(async () => {
				await unmount(app);
				target.remove();
			});
			flushSync();
			assert.equal(element(target, '#readonly-value[data-readonly]').textContent, '0');
			assert.equal(target.querySelector('input'), null);
			assert.equal(target.querySelector('button'), null);
			props.value = 'Latest value';
			flushSync();
			assert.equal(element(target, '#readonly-value').textContent, 'Latest value');
			await vi.waitFor(() => {
				flushSync();
				assert.ok(target.querySelector('button[aria-label="Copy"]'));
			});
			element<HTMLButtonElement>(target, 'button[aria-label="Copy"]').click();
			await vi.waitFor(() => assert.deepEqual(copied.mock.calls, [['Latest value']]));
			props.value = null;
			flushSync();
			assert.equal(element(target, '#readonly-value').textContent?.trim(), '—');
			assert.equal(target.querySelector('button'), null);
			props.readonly = false;
			props.value = 'Editable';
			flushSync();
			const input = element<HTMLInputElement>(target, 'input');
			input.focus();
			assert.equal(input.value, 'Editable');
			assert.equal(document.activeElement, input);
		})
);

it.live('copy feedback restarts its timer on success and clears it on rejection', () =>
	browser(async () => {
		const { default: CopyText } = await import('../src/primitives/copy-text/copy-text.svelte');
		const copied = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(CopyText, { target, props: { text: 'A value' } });
		mounted.push(async () => {
			await unmount(app);
			target.remove();
		});
		flushSync();
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const button = element<HTMLButtonElement>(target, 'button[aria-label="Copy"]');
		const announcement = element(target, '[aria-live=polite]');
		button.click();
		assert.deepEqual(copied.mock.calls, [['A value']]);
		await vi.advanceTimersByTimeAsync(0);
		flushSync();
		assert.equal(announcement.textContent, 'Copied');
		await vi.advanceTimersByTimeAsync(1000);
		button.click();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(500);
		flushSync();
		assert.equal(announcement.textContent, 'Copied', 'the previous copy cannot clear this one');
		await vi.advanceTimersByTimeAsync(999);
		flushSync();
		assert.equal(announcement.textContent, 'Copied');
		await vi.advanceTimersByTimeAsync(1);
		flushSync();
		assert.equal(announcement.textContent, '');
		button.click();
		await vi.advanceTimersByTimeAsync(0);
		flushSync();
		assert.equal(announcement.textContent, 'Copied');
		copied.mockRejectedValueOnce(new DOMException('Clipboard blocked', 'NotAllowedError'));
		button.click();
		await vi.advanceTimersByTimeAsync(0);
		flushSync();
		assert.equal(announcement.textContent, '');
		assert.equal(vi.getTimerCount(), 0);
	})
);

it.live('unmount clears copy feedback and ignores a pending clipboard completion', () =>
	browser(async () => {
		const { default: CopyText } = await import('../src/primitives/copy-text/copy-text.svelte');
		const pending = Promise.withResolvers<void>();
		const copied = vi
			.spyOn(navigator.clipboard, 'writeText')
			.mockResolvedValueOnce(undefined)
			.mockReturnValueOnce(pending.promise);
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(CopyText, { target, props: { text: 'A value' } });
		let closed = false;
		const close = async () => {
			if (closed) return;
			closed = true;
			await unmount(app);
			target.remove();
		};
		mounted.push(close);
		flushSync();
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const button = element<HTMLButtonElement>(target, 'button[aria-label="Copy"]');
		button.click();
		assert.deepEqual(copied.mock.calls, [['A value']]);
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(vi.getTimerCount(), 1);
		button.click();
		assert.deepEqual(copied.mock.calls, [['A value'], ['A value']]);
		await vi.advanceTimersByTimeAsync(0);
		await close();
		assert.equal(vi.getTimerCount(), 0);
		pending.resolve();
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(vi.getTimerCount(), 0, 'a late clipboard result must not create another timer');
	})
);
