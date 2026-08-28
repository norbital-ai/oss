import type {
	CollectionDbClient,
	CollectionRegistry,
	CollectionRow
} from '@norbital-ai/std/collection';
import type { Component, Snippet } from 'svelte';
import type { CollectionQueryState } from '#lib/collection-query';
import type {
	CollectionInitialFilter,
	CollectionIntegrationStatus,
	CollectionPipeline
} from '#lib/collection-surface';
import type { Effect } from 'effect';

export type CollectionToolbarName<TCollections extends CollectionRegistry> = Extract<
	keyof TCollections,
	string
>;

export type CollectionToolbarActionVariant = 'default' | 'outline' | 'ghost' | 'destructive';

export interface CollectionToolbarActionProps {
	label: string;
	/** Iconify name. With `iconOnly`, the label becomes the accessible name. */
	icon?: string;
	iconOnly?: boolean;
	variant?: CollectionToolbarActionVariant;
	/** Shows a spinner and refuses re-entry while the action is in flight. */
	pending?: boolean;
	/**
	 * Why this action cannot be run right now, in the operator's words.
	 *
	 * A refusal is a fact about the record, not about the button: "the month is published, so it
	 * cannot take an import" is the same sentence whether the operator reads it from the toolbar or
	 * from the pipeline panel. Given here it disables the control *and* states the reason where
	 * both a pointer and a screen reader reach it — a `title` attribute does neither reliably, and
	 * a bare disabled button leaves the operator guessing which precondition they missed.
	 */
	unavailable?: string;
	onRun: () => void | Effect.Effect<void, unknown>;
}

/**
 * Import, export and integrations, as the shared operations menu takes them.
 *
 * `fields` is deliberately absent: the toolbar has the client and the collection name, so it reads
 * the field list from the same definition the filter builder does.
 */
export interface CollectionToolbarOperations<TRow extends object> {
	readonly exportPipelines?: readonly CollectionPipeline<TRow>[];
	readonly importPipelines?: readonly CollectionPipeline<TRow>[];
	readonly integrations?: readonly CollectionIntegrationStatus[];
	readonly selectedRows?: readonly TRow[];
	readonly selectionControls?: {
		readonly totalRows: number;
		readonly allSelected: boolean;
		toggleAll(): void;
	};
	/** Refuses the menu on its own without taking search and filters down with it. */
	readonly disabled?: boolean;
}

/** What the view applies on the operator's behalf, shown behind the toolbar's info button. */
export interface CollectionToolbarAbout {
	readonly description?: string;
	/** Conditions the view pins that the operator cannot see in the filter builder. */
	readonly applied?: readonly string[];
	/** Schema-aware rendering for pinned conditions whose values are not plain text. */
	readonly appliedContent?: Snippet;
}

export interface CollectionToolbarFeatures {
	/** Free-text search over the collection's text fields. */
	readonly search?: boolean;
	/** The schema-derived filter builder. */
	readonly filter?: boolean;
}

export interface CollectionToolbarComposition<TRow extends object> {
	Action: Component<CollectionToolbarActionProps>;
	/** The one search + filter + page model this toolbar drives. */
	query: CollectionQueryState<TRow>;
}

export interface CollectionActionToolbarProps<
	TCollections extends CollectionRegistry,
	TName extends CollectionToolbarName<TCollections>,
	TRow extends object = CollectionRow<TCollections[TName]>
> {
	client: CollectionDbClient<TCollections, TName>;
	collection: TName;
	/**
	 * The query model the search box and the filter popover write to.
	 *
	 * Owned by the surface rather than the toolbar, because the surface is what runs the query. The
	 * filter paths a surface may set are checked against the row type this state was created with.
	 */
	query: CollectionQueryState<TRow>;
	title?: string;
	about?: CollectionToolbarAbout;
	/**
	 * The scope the surface is pinned to and can step through — a month, a period, a legal entity.
	 * Placed at the leading edge, before search, on every surface.
	 */
	navigation?: Snippet;
	disabled?: boolean;
	features?: CollectionToolbarFeatures;
	/** Conditions the view opens with, seeded into the builder as removable rows. */
	initialFilters?: readonly CollectionInitialFilter[];
	/** View key a cleared seed is remembered against. */
	filterPersistenceKey?: string;
	operations?: CollectionToolbarOperations<NoInfer<TRow>>;
	/** Mutating actions, placed at the trailing edge. */
	actions?: Snippet<[CollectionToolbarComposition<NoInfer<TRow>>]>;
}
