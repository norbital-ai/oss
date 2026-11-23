import { getContext, setContext } from 'svelte';

export type DialogContext = {
	readonly open: boolean;
	readonly set_open: (next: boolean) => void;
	readonly role: 'dialog' | 'alertdialog';
	readonly title_id: string;
	readonly description_id: string;
	readonly has_title: boolean;
	readonly has_description: boolean;
	readonly mark_title: (present: boolean) => void;
	readonly mark_description: (present: boolean) => void;
};

const KEY = Symbol.for('norbital.ui.dialog');

export const set_dialog_context = (ctx: DialogContext) => setContext(KEY, ctx);
export const get_dialog_context = () => getContext<DialogContext | undefined>(KEY);
