import type {
	CollectionDbClient,
	CollectionRegistry,
	CollectionRow
} from '@norbital-ai/std/collection';
import type { Component, ComponentInternals, Snippet } from 'svelte';
import type { CollectionQueryState } from '#lib/collection-query';
import type {
	CollectionTableInitialFilter,
	CollectionTableIntegrationStatus,
	CollectionTablePipeline
} from '#lib/collection-table/collection-table.types';
import type { Effect } from 'effect';

export type CollectionToolbarName<TCollections extends CollectionRegistry> = Extract<
	keyof TCollections,
	string
>;

export interface CollectionToolbarFilterOption<TValue extends string = string> {
	readonly value: TValue;
	readonly label: string;
	readonly description?: string;
	/** Extra text a searchable control matches on, beyond the label. */
	readonly search_term?: string;
}

/**
 * A filter control for a predicate the collection has no field for.
 *
 * The schema filter builder can only address what the collection stores. A surface that derives its
 * own facts — "this person has a day rostered on shift N", "this month is still drafted" — has
 * nothing for the builder to point at, and every such surface has so far grown its own popover, its
 * own active-count badge and its own "clear all". Declaring the control instead puts it in the same
 * popover, under the same count, cleared by the same button, and resets the page on change like
 * every other narrowing does.
 *
 * `TValue` is inferred from `options`, so `onValueChange` receives the surface's own union rather
 * than a bare `string` it has to re-narrow.
 */
export interface CollectionToolbarFilterProps<TValue extends string = string> {
	/** Stable identity for the control, used to key it and to label its combobox. */
	id: string;
	label: string;
	options: readonly CollectionToolbarFilterOption<TValue>[];
	value: TValue | null;
	/** Shown when nothing is selected; reads as the unfiltered case ("Any status"). */
	placeholder?: string;
	searchPlaceholder?: string;
	searchable?: boolean;
	onValueChange: (value: TValue | null) => void;
}

/**
 * `Filter` as handed to the toolbar's filter composition. Callable (the Svelte 5 component shape) so
 * svelte-check accepts it as a component; the generic lets each usage instantiate `TValue` from
 * `options` so `value` and `onValueChange` stay tied to the same union.
 */
export interface CollectionToolbarFilterComponent {
	<TValue extends string = string>(
		this: void,
		internals: ComponentInternals,
		props: CollectionToolbarFilterProps<TValue>
	): {
		$on?(type: string, callback: (e: unknown) => void): () => void;
		$set?(props: Partial<CollectionToolbarFilterProps<TValue>>): void;
	};
	element?: typeof HTMLElement;
	z_$$bindings?: string;
}

/** A registered `Filter`, with its authored props kept live by getters. */
export interface CollectionToolbarFilterDeclaration {
	readonly id: string;
	readonly label: string;
	readonly options: readonly CollectionToolbarFilterOption[];
	readonly value: string | null;
	readonly placeholder?: string;
	readonly searchPlaceholder?: string;
	readonly searchable?: boolean;
	change(value: string | null): void;
}

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
	readonly exportPipelines?: readonly CollectionTablePipeline<TRow>[];
	readonly importPipelines?: readonly CollectionTablePipeline<TRow>[];
	readonly integrations?: readonly CollectionTableIntegrationStatus[];
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
	/**
	 * The schema-derived filter builder. Declared `Filter` controls are unaffected — a surface whose
	 * conditions are all derived turns the builder off and still gets the filter popover.
	 */
	readonly filter?: boolean;
}

export interface CollectionToolbarComposition<TRow extends object> {
	Filter: CollectionToolbarFilterComponent;
	Action: Component<CollectionToolbarActionProps>;
	/** The one search + filter + page model this toolbar drives. */
	query: CollectionQueryState<TRow>;
}

export interface CollectionActionToolbarProps<
	TCollections extends CollectionRegistry,
	TName extends CollectionToolbarName<TCollections>,
	TRow extends object = CollectionRow<TCollections[TName]>
> {
	client: CollectionDbClient<TCollections>;
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
	initialFilters?: readonly CollectionTableInitialFilter[];
	/** View key a cleared seed is remembered against. */
	filterPersistenceKey?: string;
	operations?: CollectionToolbarOperations<NoInfer<TRow>>;
	/** Derived-predicate controls, placed in the filter popover above the builder. */
	filters?: Snippet<[CollectionToolbarComposition<NoInfer<TRow>>]>;
	/** Mutating actions, placed at the trailing edge. */
	actions?: Snippet<[CollectionToolbarComposition<NoInfer<TRow>>]>;
}
