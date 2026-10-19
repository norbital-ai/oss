import { getContext, setContext } from 'svelte';
import type { RecordView, RepresentationLoader } from './types.js';
const RECORD_VIEW = Symbol('ui.views.recordView');
/** Set by `RecordShell` for its body: the record it shows, the scrubbed revision while one is picked. */
export const provideRecordView = (v: { readonly current: RecordView | null }) =>
	setContext(RECORD_VIEW, v);
/** The record the nearest `RecordShell` shows (`current` is the scrubbed revision while one is picked); absent outside one. */
export const useRecordView = () =>
	getContext<{ readonly current: RecordView | null } | undefined>(RECORD_VIEW);
const REPRESENTATIONS = Symbol('ui.views.representations');
/** The workspace's representations per collection (the generated registry), set by the shell above every page. */
export const provideRepresentations = (map: {
	readonly [collection: string]: RepresentationLoader;
}) => setContext(REPRESENTATIONS, map);
export const representations = () =>
	getContext<{ readonly [c: string]: RepresentationLoader } | undefined>(REPRESENTATIONS);
