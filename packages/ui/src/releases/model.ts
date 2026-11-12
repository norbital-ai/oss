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
