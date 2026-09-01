export type SourceDrafts = Readonly<Record<string, string>>;

export const sourceDraftValue = (
	drafts: SourceDrafts,
	sourceFiles: Readonly<Record<string, string>>,
	path: string
): string => (Object.hasOwn(drafts, path) ? (drafts[path] ?? '') : (sourceFiles[path] ?? ''));

export const updateSourceDrafts = (
	drafts: SourceDrafts,
	sourceFiles: Readonly<Record<string, string>>,
	path: string,
	value: string
): SourceDrafts => {
	const next = { ...drafts };
	if (value === (sourceFiles[path] ?? '')) delete next[path];
	else next[path] = value;
	return next;
};

export const sourceCommitFiles = (drafts: SourceDrafts): Readonly<Record<string, string>> => ({
	...drafts
});

export const settleSourceCommit = (
	drafts: SourceDrafts,
	committedFiles: Readonly<Record<string, string>>
): SourceDrafts => {
	const next = { ...drafts };
	for (const [path, committedValue] of Object.entries(committedFiles)) {
		if (next[path] === committedValue) delete next[path];
	}
	return next;
};
