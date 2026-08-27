import type { CollectionField, CollectionRelationOptions } from '@norbital-ai/std/collection';
import type { Component } from 'svelte';

/** Props every datatype renderer receives from the strategy router. */
export interface FieldRendererProps {
	field: CollectionField;
	value: unknown;
	id?: string;
	mode?: 'display' | 'edit';
	disabled?: boolean;
	placeholder?: string;
	onValueChange?: (value: unknown) => void;
	/** Full matrix/form row when the renderer needs sibling fields. */
	row?: Record<string, unknown>;
	onRowChange?: (patch: Record<string, unknown>) => void;
	locale?: string;
	class?: string;
}

/** A template-selected datatype renderer. Its concrete props are inferred at the authored callsite. */
export type FieldRendererComponent = Component<never>;

/** Resolve the concrete props of a template-selected renderer, with a surface-specific fallback. */
export type FieldRendererPropsOf<
	TRenderer,
	TFallback extends FieldRendererProps = FieldRendererProps
> =
	TRenderer extends Component<infer TProps>
		? TProps extends never
			? TFallback
			: TProps
		: TFallback;

/** Props a template may configure after the strategy router injects the standard field context. */
export type FieldRendererCallerProps<TRendererProps> = Omit<
	TRendererProps,
	keyof FieldRendererProps
>;

/**
 * The public strategy-router contract.
 *
 * Omit `renderer` for automatic relationship/datatype routing. Supplying it is the one explicit
 * override path; `rendererProps` carries only renderer-specific configuration while the router
 * continues to own field state and the standard control frame.
 */
export interface DataRendererProps extends FieldRendererProps {
	renderer?: FieldRendererComponent;
	rendererProps?: Readonly<Record<string, unknown>>;
	/** Contextual option-set configuration for the automatic relationship strategy. */
	relationOptions?: CollectionRelationOptions;
}
