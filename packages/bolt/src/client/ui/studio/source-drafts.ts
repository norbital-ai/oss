/** The authored files whose working copies differ from the host snapshot. */
export type SourceDrafts = Readonly<Record<string, string>>;

/** Reads the working copy when one exists, otherwise the current host source. */
export const sourceDraftValue = (
	drafts: SourceDrafts,
	sourceFiles: Readonly<Record<string, string>>,
	path: string
): string => (Object.hasOwn(drafts, path) ? (drafts[path] ?? '') : (sourceFiles[path] ?? ''));

/** Replaces one working copy, removing it again when the author restores the host value. */
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

/** Captures the exact multi-file patch submitted by one commit attempt. */
export const sourceCommitFiles = (drafts: SourceDrafts): Readonly<Record<string, string>> => ({
	...drafts
});

/**
 * Drops only the working copies that were actually committed and have not changed since.
 *
 * The editor remains writable while the host processes a commit. An edit made during that request
 * must stay dirty for the next commit instead of being cleared with the older submitted value.
 */
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
