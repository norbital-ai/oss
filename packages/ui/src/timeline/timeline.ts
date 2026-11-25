import type { GlyphName } from '../primitives/icon/Glyph.svelte';
import type { BadgeVariant } from '../primitives/badge/badge.svelte';
import type { ApprovalView } from '../client/contract.js';
import type { Checkpoint } from '../record/history.js';

/** What a revision did to the record. */
export type RevisionAction = 'create' | 'update' | 'move' | 'delete' | 'restore' | 'rollback';
/** What a timeline entry records: an approval move, an upcoming step, or what a revision did to the record. */
export type TimelineAction = ApprovalView['log'][number]['move'] | RevisionAction | 'step';
/** Semantic tone of a timeline node's ring and icon. */
export type TimelineTone = 'default' | 'brand' | 'info' | 'success' | 'warning' | 'danger';
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
	rollback: 'rotateCcw',
	step: 'fieldTime'
};
/** One entry on a vertical timeline: an icon node, a header line (title and/or quiet metadata parts), and optional payload or body below. */
export type TimelineEntry = {
	/** Stable list key for this entry. */
	readonly key: string;
	/** Optional group label (e.g. a formatted day) clustering consecutive entries that share the same day under one header on the rail. */
	readonly group?: string;
	/** Built-in action glyph (approvals and record history); optional when `icon` is given. */
	readonly action?: TimelineAction;
	/** Iconify icon name (e.g. `lucide:calendar`) for domain timelines; overrides `action`. */
	readonly icon?: string;
	/** Semantic ring and icon colour for domain entries (`default` muted, `brand`, `info`, `success`, `warning`, `danger`). */
	readonly tone?: TimelineTone;
	/** Visual progression for upcoming/active approval steps; absent for past entries. */
	readonly status?: 'active' | 'changes' | 'future';
	/** Primary headline shown above or beside `line` for domain timelines (date, version, subject). */
	readonly title?: string;
	/** Quiet label parts joined with ` · ` (what, who, when). */
	readonly line?: readonly string[];
	/** The payload that matters, quoted: a decision's reason. */
	readonly quote?: string | null;
	/** Quiet notes under the line (changed fields, a rollback), each tagged `data-note={kind}`. */
	readonly notes?: readonly { readonly kind: string; readonly text: string; readonly warn?: boolean }[];
	/** A short mark at the line's end ("Current", "In force"); pass `variant` to render as a `Badge`. */
	readonly mark?: { readonly text: string; readonly warn?: boolean; readonly variant?: BadgeVariant };
	/** The entry the view shows now. */
	readonly current?: boolean;
	/** Disclosure state when the entry expands in place; omit for always-open or header-only entries. */
	readonly expanded?: boolean;
	/** Toggles an expandable entry in place. */
	readonly ontoggle?: () => void;
	/** Picking the entry (opens a record or selects a revision). */
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
