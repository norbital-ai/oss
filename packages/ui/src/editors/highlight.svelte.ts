import { lazy } from '../utilities/lazy.svelte.js';

const parser = lazy(() => import('./highlight-tokens.js'));

/**
 * An expression as highlighted tokens on one line: each line break becomes a space. Plain text until the JavaScript
 * parser has loaded (with the first highlighted line), then highlighted.
 */
export const highlighted_line = (code: string): { text: string; class: string }[] =>
	parser()?.highlighted_line(code) ?? [{ text: code.replace(/\r?\n/g, ' '), class: '' }];
