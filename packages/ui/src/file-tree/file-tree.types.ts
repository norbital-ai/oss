import type { Effect } from 'effect';

export type FileTreeEntry = {
	name: string;
	type: 'directory' | 'file';
	sizeBytes: number;
	path: string;
	writable?: boolean;
};

type FileTreeIconContext = {
	open: boolean;
};

export type FileTreePresencePeer = {
	color: string;
	label: string;
};

export type FileTreeEntryBadge = {
	label: string;
	class?: string;
};

/**
 * `E` defaults to `Error`, not `never`: a Svelte component cannot infer a type parameter from its
 * props, so the default is the only value this ever takes — and `file-tree-node` handles a load
 * failure (`error instanceof Error`). With `never` that handler was unreachable by its own types.
 */
export type FileTreeProps<E = Error> = {
	entries: FileTreeEntry[];
	onToggle?: (path: string) => Effect.Effect<FileTreeEntry[], E>;
	onSelect?: (path: string, entry: FileTreeEntry) => void;
	canDelete?: (path: string, entry: FileTreeEntry) => boolean;
	onDelete?: (path: string, entry: FileTreeEntry) => void;
	deleteDisabled?: boolean;
	selectedPath?: string | null;
	presenceByPath?: Record<string, readonly FileTreePresencePeer[]>;
	getEntryIcon?: (entry: FileTreeEntry, context: FileTreeIconContext) => string;
	/** Optional trailing status badge (e.g. U/M/D). Also tints the filename when `class` is set. */
	getEntryBadge?: (entry: FileTreeEntry) => FileTreeEntryBadge | null;
	isMutedEntry?: (entry: FileTreeEntry) => boolean;
	/** Directory paths expanded when their nodes first mount. */
	defaultExpandedPaths?: readonly string[];
	variant?: 'default' | 'dark';
	class?: string;
};
