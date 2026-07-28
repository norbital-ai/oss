import type { FileTreeEntry } from './file-tree.types';

/** Cursor / VS Code–style Iconify ids for workspace file tree rows. */
export function getDefaultFileTreeEntryIcon(
	entry: FileTreeEntry,
	context: { open: boolean }
): string {
	if (entry.type === 'directory') {
		return getDirectoryIcon(entry.name, context.open);
	}
	return getFileIconForPath(entry.path);
}

export function getFileIconForPath(relativePath: string): string {
	const fileName = relativePath.split('/').pop()?.toLowerCase() ?? '';

	if (fileName === 'package.json') return 'vscode-icons:file-type-npm';
	if (fileName === 'tsconfig.json') return 'vscode-icons:file-type-tsconfig';
	if (fileName.endsWith('.svelte')) return 'vscode-icons:file-type-svelte';
	if (fileName.endsWith('.tsx')) return 'vscode-icons:file-type-reactts';
	if (fileName.endsWith('.ts') || fileName.endsWith('.mts') || fileName.endsWith('.cts')) {
		return 'vscode-icons:file-type-typescript';
	}
	if (fileName.endsWith('.jsx')) return 'vscode-icons:file-type-reactjs';
	if (fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')) {
		return 'vscode-icons:file-type-js';
	}
	if (fileName.endsWith('.json')) return 'vscode-icons:file-type-json';
	if (fileName.endsWith('.md') || fileName.endsWith('.mdx')) {
		return 'vscode-icons:file-type-markdown';
	}
	if (fileName.endsWith('.css')) return 'vscode-icons:file-type-css';
	if (fileName.endsWith('.scss')) return 'vscode-icons:file-type-scss';
	if (fileName.endsWith('.html')) return 'vscode-icons:file-type-html';
	if (fileName.endsWith('.sql')) return 'vscode-icons:file-type-sql';
	if (fileName.endsWith('.yaml') || fileName.endsWith('.yml')) {
		return 'vscode-icons:file-type-yaml';
	}
	if (fileName.endsWith('.svg')) return 'vscode-icons:file-type-svg';
	return 'vscode-icons:default-file';
}

function getDirectoryIcon(name: string, open: boolean): string {
	const lower = name.toLowerCase();
	if (lower === 'node_modules') return 'vscode-icons:folder-node';
	if (lower === 'apps' || lower === 'modules' || lower === 'lib') {
		return open ? 'vscode-icons:folder-src-open' : 'vscode-icons:folder-src';
	}
	return open ? 'vscode-icons:default-folder-opened' : 'vscode-icons:default-folder';
}
