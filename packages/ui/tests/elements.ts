import assert from 'node:assert/strict';

export function element<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
	const found = root.querySelector<E>(selector);
	assert.ok(found, `Missing ${selector}`);
	return found;
}

const labelled = (dialog: HTMLElement, by: string) => {
	const id = dialog.getAttribute(by);
	return id === null ? undefined : document.getElementById(id)?.textContent?.trim();
};
/** The open in-app confirmation (`confirmAction`'s real dialog): its title, body and its two answers. */
export function confirmDialog() {
	const open = document.querySelector<HTMLElement>('[data-confirm-dialog][data-state=open]');
	if (open === null) return undefined;
	return {
		title: labelled(open, 'aria-labelledby') ?? '',
		body: labelled(open, 'aria-describedby'),
		answer: (confirmed: boolean) =>
			element<HTMLButtonElement>(
				open,
				confirmed ? '[data-confirm-accept]' : '[data-confirm-cancel]'
			).click()
	};
}
