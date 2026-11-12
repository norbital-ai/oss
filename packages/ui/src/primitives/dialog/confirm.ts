// An in-app confirmation in place of `window.confirm`, which embedded browsers and app-shell WebViews suppress (it
// answers `false` at once, so the action silently never runs). Each ask mounts its own dialog on the body, so no host has
// to be wired into a page; interrupting the Effect dismisses it.
import { Effect } from 'effect';
import { mount, unmount } from 'svelte';
import ConfirmDialog from './confirm-dialog.svelte';

export type ConfirmOptions = {
	title: string;
	body?: string | undefined;
	/** The accept button's label: the action itself ("Disconnect"), never a bare "OK". */
	confirm_label: string;
	/** Defaults to the UI kit's "Cancel". */
	cancel_label?: string | undefined;
	/** Draws the accept button as destructive. */
	destructive?: boolean | undefined;
};

/** `true` when the person confirmed; `false` on cancel, Escape or dismissal. */
export const confirm_action = (options: ConfirmOptions): Effect.Effect<boolean> =>
	Effect.callback<boolean>((resume) => {
		const target = document.body.appendChild(document.createElement('div'));
		let view: ReturnType<typeof mount> | null = null;
		const remove = () => {
			if (view === null) return;
			const closing = view;
			view = null;
			void unmount(closing).then(() => target.remove());
		};
		view = mount(ConfirmDialog, {
			target,
			props: {
				...options,
				on_answer: (confirmed: boolean) => resume(Effect.succeed(confirmed)),
				on_closed: remove
			}
		});
		return Effect.sync(remove);
	});
