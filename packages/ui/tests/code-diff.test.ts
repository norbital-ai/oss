import './dom.ts';
import { flushSync, mount, unmount } from 'svelte';
import { expect, it } from 'vitest';
import CodeDiff from '../src/editors/code-diff.svelte';

it('a diff counts its added and removed lines, mounts only when opened, and marks both', () => {
	const target = document.body.appendChild(document.createElement('div'));
	const props = {
		path: 'src/a.ts',
		before: 'const a = 1;\nconst b = 2;\nconst c = 3;',
		after: 'const a = 1;\nconst x = 9;\nconst y = 8;\nconst c = 3;'
	};
	const closed = mount(CodeDiff, { target, props });
	flushSync();
	expect(target.querySelector('summary')?.textContent).toContain('src/a.ts');
	expect(target.querySelector('[data-added]')?.textContent).toBe('+2');
	expect(target.querySelector('[data-removed]')?.textContent).toBe('−1');
	expect(target.querySelector('.cm-editor')).toBeNull();
	unmount(closed);
	const view = mount(CodeDiff, { target, props: { ...props, open: true } });
	flushSync();
	const editor = target.querySelector('.cm-editor');
	expect(editor?.classList.contains('cm-merge-b')).toBe(true);
	expect([...target.querySelectorAll('.cm-changedLine')].map((line) => line.textContent)).toEqual([
		'const x = 9;',
		'const y = 8;'
	]);
	expect(target.querySelector('.cm-deletedChunk')?.textContent).toContain('const b = 2;');
	unmount(view);
});
