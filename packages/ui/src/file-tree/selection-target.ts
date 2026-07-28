/** Folder rows render immediately before their collapse grid in the file tree DOM. */
function findParentTreeItem(el: HTMLElement): HTMLElement | null {
	let current = el.parentElement;
	while (current) {
		const previous = current.previousElementSibling;
		if (previous instanceof HTMLElement && previous.getAttribute('role') === 'treeitem') {
			return previous;
		}
		current = current.parentElement;
	}
	return null;
}

function isTreeItemVisible(el: HTMLElement, root: HTMLElement): boolean {
	if (el.offsetHeight === 0 && el.offsetWidth === 0) return false;

	let current = el.parentElement;
	while (current && current !== root) {
		if (
			current.hasAttribute('data-file-tree-collapse') &&
			current.style.gridTemplateRows === '0fr'
		) {
			return false;
		}
		current = current.parentElement;
	}
	return true;
}

/** Anchor on the nearest visible row when the selected file sits in a collapsed folder. */
export function findVisibleFileTreeIndicatorTarget(root: HTMLElement): HTMLElement | null {
	const selected = root.querySelector<HTMLElement>('[data-file-tree-selected="true"]');
	if (!selected) return null;

	let candidate: HTMLElement | null = selected;
	while (candidate && root.contains(candidate)) {
		if (
			candidate.getAttribute('role') === 'treeitem' &&
			candidate.offsetWidth > 0 &&
			isTreeItemVisible(candidate, root)
		) {
			return candidate;
		}
		candidate = findParentTreeItem(candidate);
	}
	return null;
}
