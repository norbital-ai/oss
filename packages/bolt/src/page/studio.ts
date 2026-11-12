/**
 * What a host needs to serve Studio's own browser bundle: the Schema-decoded shell transport (`base` selects the host's
 * authenticated endpoint), the event stream, the preview frame the agent panel shares, the wire types, and the slot that
 * mounts the bundle.
 */
export { shell_api } from '../shell/runtime.ts';
export { ShellError, type ShellApi } from '../shell/api-types.ts';
export { studio_events } from '../shell/studio/events.ts';
export {
	MERGE_SUMMARY,
	PHASES,
	elapsed_text,
	language_of,
	suggest_message,
	type PhaseState,
	type StudioChangeSet,
	type StudioDiagnostic,
	type StudioFile,
	type StudioLogLine,
	type StudioOp,
	type StudioPhase,
	type StudioRelease,
	type StudioView
} from '../shell/studio/model.ts';
export type { StudioMount, StudioProps } from '../shell/studio/slot.ts';
export type { StudioTestRun } from '../shell/studio/test-results.ts';
export type { StudioTab } from '../shell/nav.ts';
export { impact_lines, step_name } from '../protocol/migration-impact.ts';
export { default as StudioSlot } from '../shell/studio/StudioSlot.svelte';
export { default as PreviewFrame } from '../shell/preview/PreviewFrame.svelte';
export { default as TestResults } from '../shell/preview/TestResults.svelte';
