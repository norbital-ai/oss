import { getContext, setContext } from 'svelte';

export type AccordionRootContext = {
	readonly prefix: string;
	readonly is_open: (value: string) => boolean;
	readonly toggle: (value: string) => void;
	readonly disabled: boolean;
};

export type AccordionItemContext = {
	readonly value: string;
	readonly open: boolean;
	readonly disabled: boolean;
	readonly trigger_id: string;
	readonly content_id: string;
	readonly toggle: () => void;
};

const ROOT = Symbol.for('norbital.ui.accordion.root');
const ITEM = Symbol.for('norbital.ui.accordion.item');

export const set_accordion_root = (ctx: AccordionRootContext) => setContext(ROOT, ctx);
export const get_accordion_root = () => getContext<AccordionRootContext | undefined>(ROOT);
export const set_accordion_item = (ctx: AccordionItemContext) => setContext(ITEM, ctx);
export const get_accordion_item = () => getContext<AccordionItemContext | undefined>(ITEM);
