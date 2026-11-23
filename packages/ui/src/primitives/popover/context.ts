import { getContext, setContext } from 'svelte';

export type PopoverContext = {
	readonly open: boolean;
	readonly set_open: (next: boolean) => void;
	readonly content_id: string;
	readonly trigger_el: HTMLElement | null;
	readonly set_trigger: (el: HTMLElement | null) => void;
};

const KEY = Symbol.for('norbital.ui.popover');

export const set_popover_context = (ctx: PopoverContext) => setContext(KEY, ctx);
export const get_popover_context = () => getContext<PopoverContext | undefined>(KEY);
