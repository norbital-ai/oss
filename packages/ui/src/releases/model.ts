/** The monitoring fields shared by Workspace Studio and Command Center. */
export type ReleaseBuild = Readonly<{
	commit: string;
	at: string;
	status: 'built' | 'failed';
	message: string;
	deployed: boolean;
	live: boolean;
	lines: number;
	diagnostics: number;
}>;
/** A published commit, its current-live status and the checkpoint used for rollback. */
export type ReleaseVersion = Readonly<{
	commit: string;
	at: string;
	message: string;
	current: boolean;
	checkpoint?: string | null;
	rollback?: string;
	undo?: true;
	discards?: string;
	replaced?: true;
}>;
/** An environment's selected release and its optional public URL. */
export type ReleaseEnvironment = Readonly<{ name: string; release: string; url: string | null }>;
/** A source change and the exact commit and artifact served by its preview. */
export type ReleaseChange = Readonly<{
	id: string;
	title: string;
	state: 'open' | 'merged' | 'closed';
	head: string;
	updatedAt: string;
	preview: Readonly<{
		commit: string;
		artifact: string;
		url: string | null;
		stale: boolean;
		shelved?: boolean;
	}> | null;
}>;
/** One commit's build, publications, source changes and preview references in the release timeline. */
export type ReleaseEntry = Readonly<{
	commit: string;
	at: string;
	message: string;
	build: ReleaseBuild | null;
	publications: readonly ReleaseVersion[];
	changes: readonly ReleaseChange[];
	previews: readonly ReleaseChange[];
}>;

/** The same source-and-data rollback prerequisites wherever a version is displayed. */
export function rollbackReason(release: ReleaseVersion): string | null {
	if (release.current) return 'This commit is already live.';
	if (release.replaced) return 'Before the last reset — can’t roll back to this';
	if (release.checkpoint == null) return 'This version has no checkpoint to roll back to';
	return null;
}

/** A commit has one row, while every publication and preview reference remains visible inside it. */
export function timelineEntries(
	builds: readonly ReleaseBuild[],
	releases: readonly ReleaseVersion[],
	changes: readonly ReleaseChange[] = []
): readonly ReleaseEntry[] {
	const commits = new Set([
		...builds.map((build) => build.commit),
		...releases.map((release) => release.commit),
		...changes.flatMap((change) => [
			change.head,
			...(change.preview ? [change.preview.commit] : [])
		])
	]);
	return [...commits]
		.map((commit): ReleaseEntry => {
			const build = builds.find((value) => value.commit === commit) ?? null;
			const publications = releases
				.filter((release) => release.commit === commit)
				.sort((a, b) => b.at.localeCompare(a.at));
			const own = changes.filter((change) => change.head === commit);
			const previews = changes.filter((change) => change.preview?.commit === commit);
			const at =
				[
					...(build ? [build.at] : []),
					...publications.map((release) => release.at),
					...own.map((change) => change.updatedAt),
					...previews.map((change) => change.updatedAt)
				]
					.sort()
					.at(-1) ?? '';
			return {
				commit,
				at,
				message: publications[0]?.message || build?.message || own[0]?.title || commit.slice(0, 12),
				build,
				publications,
				changes: own,
				previews
			};
		})
		.sort((a, b) => b.at.localeCompare(a.at) || a.commit.localeCompare(b.commit));
}
