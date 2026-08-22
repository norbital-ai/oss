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

export type FileTreeProps = {
	entries: FileTreeEntry[];
	onToggle?: (path: string) => Effect.Effect<FileTreeEntry[], unknown>;
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
	variant?: 'default' | 'dark';
	class?: string;
};
import type { Effect } from 'effect';
