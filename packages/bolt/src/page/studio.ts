/**
 * What a host needs to serve Studio's own browser bundle: the Schema-decoded shell transport (`base` selects the host's
 * authenticated endpoint), the event stream, the preview frame the agent panel shares, the wire types, and the slot that
 * mounts the bundle.
 */
export { shell_api } from '../shell/runtime.ts';
export type { ShellApi } from '../shell/api-types.ts';
export { studio_events } from '../shell/studio/events.ts';
export {
	MERGE_SUMMARY,
	PHASES,
	StudioOp,
	suggest_message,
	type StudioView
} from '../shell/studio/model.ts';
export type { StudioProps } from '../shell/studio/slot.ts';
export { impact_lines, step_name } from '../protocol/migration-impact.ts';
export { default as StudioSlot } from '../shell/studio/StudioSlot.svelte';
export { default as PreviewFrame } from '../shell/preview/PreviewFrame.svelte';
export { default as TestResults } from '../shell/preview/TestResults.svelte';
