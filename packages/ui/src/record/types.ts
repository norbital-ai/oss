import type { Component } from 'svelte';
import type { Json } from '@norbital-ai/std/wire';
import type { RecordOf, InsertOf } from '../collection/types.js';
/** Native advisory capabilities of the current record; saving always rechecks the backend rules. */
export type RecordRestriction =
	| 'noGrant'
	| 'stateLocked'
	/** A read-only sync owns the field. */
	| 'syncOwned'
	| 'ownedParent'
	| 'ownedParentLocked'
	/** An open approval request holds the record; only its current approvers or (changes requested) its requester edit. */
	| 'underApproval';
/** A nested edit uses one declared parent relation and the parent's observed revision. */
export type RecordParentContext = {
	collection: string;
	id: string;
	relation: string;
	revision: number;
};
/** Read-filtered field and operation permissions, proposal eligibility and restriction reasons for one revision. */
export type RecordCapabilities = {
	collection: string;
	id: string;
	revision: number;
	fields: Readonly<
		Record<string, { writable: boolean; proposal: boolean; reasons: readonly RecordRestriction[] }>
	>;
	update: { allowed: boolean; proposal: boolean; reasons: readonly RecordRestriction[] };
	delete: { allowed: boolean; proposal: boolean; reasons: readonly RecordRestriction[] };
	moves: Readonly<Record<string, readonly string[]>>;
	proposalMoves: Readonly<Record<string, readonly string[]>>;
};
/** Why a past value is not written back by a per-record restore. */
export type RestoreSkip =
	'deletedTarget' | 'readOnly' | 'noGrant' | 'stateLocked' | 'masked' | 'definitionChanged';
/**
 * `history.preview`: what restoring past `revision` would write over the live record (`live`), field by field, and
 * what it leaves alone and why. `approval`: that field's write routes to an approval rather than committing.
 */
export type RestorePreview = {
	collection: string;
	record: string;
	revision: number;
	live: number;
	changes: readonly { field: string; current: Json; restored: Json; approval: boolean }[];
	skipped: readonly { field: string; reason: RestoreSkip; current: Json; restored: Json }[];
};
/** X-20: what a `+representation.svelte` receives, `{ view: RecordView<'<collection>'> }`. */
export type RecordView<C extends string = string> =
	| { collection: C; mode: 'view' | 'edit'; record: RecordOf<C>; capabilities?: RecordCapabilities }
	| { collection: C; mode: 'create'; values: Partial<InsertOf<C>> };
/** A collection's `+representation.svelte`, loaded on first use (its module may import `$bolt`). */
export type RepresentationLoader = () => Promise<{ default: Component<{ view: RecordView }> }>;
