import assert from 'node:assert/strict';

export function element<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
	const found = root.querySelector<E>(selector);
	assert.ok(found, `Missing ${selector}`);
	return found;
}
