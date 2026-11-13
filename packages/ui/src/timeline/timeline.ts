import type { GlyphName } from '../primitives/icon/Glyph.svelte';
import type { ApprovalView } from '../client/contract.js';
import type { Checkpoint } from '../record/history.js';

/** What a revision did to the record. */
export type RevisionAction = 'create' | 'update' | 'move' | 'delete' | 'restore' | 'rollback';
/** What a timeline entry records: an approval move, or what a revision did to the record. */
export type TimelineAction = ApprovalView['log'][number]['move'] | RevisionAction;
/** Each action's Lucide icon. */
export const TIMELINE_ICON: Readonly<Record<TimelineAction, GlyphName>> = {
	request: 'send',
	resubmit: 'sync',
	request_changes: 'messageWarning',
	approve: 'circleCheck',
	reject: 'circleX',
	withdraw: 'undo',
	supersede: 'circleSlash',
	create: 'circlePlus',
	update: 'pencil',
	move: 'arrowRight',
	delete: 'trash',
	restore: 'rotateCcw',
	rollback: 'rotateCcw'
};
/** One entry: an icon, a subtle label line, then its payload quietly below. */
export type TimelineEntry = {
	readonly key: string;
	readonly action: TimelineAction;
	/** The label line's parts, read as one line: what, who, when. */
	readonly line: readonly string[];
	/** The payload that matters, quoted: a decision's reason. */
	readonly quote?: string | null;
	/** Quiet notes under the line (changed fields, a rollback), each tagged `data-note={kind}`. */
	readonly notes?: readonly { readonly kind: string; readonly text: string; readonly warn?: boolean }[];
	/** A short mark at the line's end ("Current", "Not valid"). */
	readonly mark?: { readonly text: string; readonly warn?: boolean };
	/** The entry the view shows now. */
	readonly current?: boolean;
	/** Picking the entry (a revision opens in the record). */
	readonly onpick?: () => void;
	/** The entry's own `data-*` hooks. */
	readonly data?: Readonly<Record<`data-${string}`, string | number | boolean>>;
};
/** What a revision did: created, erased, restored, rolled back by its request, moved a state, or updated. */
export function revisionAction(c: Checkpoint, states: ReadonlySet<string>): RevisionAction {
	if (c.cause === 'erased') return 'delete';
	if (c.restored_from !== null) return c.approval === null ? 'restore' : 'rollback';
	if (c.revision === 1) return 'create';
	return c.fields.some((field) => states.has(field)) ? 'move' : 'update';
}
