export function resolveSheetPortalTarget(
	target: string | undefined,
	root: ParentNode
): Element | null {
	if (target) return root.querySelector(target);
	return root.querySelector('#app-body-root') ?? root.querySelector('body');
}
