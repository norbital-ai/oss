// @vitest-environment happy-dom
import './setup-happy-dom.js';
import { flushSync, mount, unmount } from 'svelte';
import { writable } from 'svelte/store';
import { expect, it } from '@effect/vitest';
import Controlled from './fixtures/editor/controlled.svelte';

it.each(['Amount expression', '金额表达式'])(
	'controlled CEL text preserves its editing node and focus: %s',
	async (label) => {
		const target = document.body.appendChild(document.createElement('div'));
		const source = writable('net');
		const component = mount(Controlled, { target, props: { source, label } });
		try {
			flushSync();
			const editor = target.querySelector<HTMLElement>('.cm-content');
			expect(editor).not.toBeNull();
			if (editor === null) throw new Error('Code editor did not render its editing node');
			editor.focus();
			source.set('net * decimal("0.05")');
			flushSync();
			expect(target.querySelector('.cm-content')).toBe(editor);
			expect(document.activeElement).toBe(editor);
			expect(editor.textContent).toBe('net * decimal("0.05")');
			expect(editor.getAttribute('aria-labelledby')).toBe('commission-expression-label');
			source.set('net * decimal("0.10")');
			flushSync();
			expect(target.querySelector('.cm-content')).toBe(editor);
			expect(editor.textContent).toBe('net * decimal("0.10")');
		} finally {
			await unmount(component);
			target.remove();
		}
	}
);
