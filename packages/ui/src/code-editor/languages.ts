import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { yaml, yamlLanguage } from '@codemirror/lang-yaml';
import type { Language } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import type { CodeEditorLanguage } from './code-editor.types.js';
import { markdownBlockDecorations } from './markdown-blocks.js';

const javascriptLanguage = javascript({ typescript: true }).language;
const jsonLanguage = json().language;

function fencedCodeLanguage(info: string): Language | null {
	const name = info.trim().split(/\s/, 1)[0]?.toLowerCase() ?? '';
	switch (name) {
		case 'json':
			return jsonLanguage;
		case 'yml':
		case 'yaml':
			return yamlLanguage;
		case 'js':
		case 'javascript':
		case 'jsx':
		case 'mjs':
		case 'cjs':
		case 'ts':
		case 'typescript':
		case 'tsx':
		case 'svelte':
			return javascriptLanguage;
		default:
			return null;
	}
}

export function languageExtension(editorLanguage: CodeEditorLanguage): Extension {
	switch (editorLanguage) {
		case 'javascript':
			return javascript({ typescript: true });
		case 'json':
			return json();
		case 'yaml':
			return yaml();
		case 'markdown':
			return [
				markdown({
					base: markdownLanguage,
					addKeymap: true,
					codeLanguages: fencedCodeLanguage
				}),
				markdownBlockDecorations()
			];
		case 'plaintext':
			return [];
		default: {
			const _never: never = editorLanguage;
			return _never;
		}
	}
}
