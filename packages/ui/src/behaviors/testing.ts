// WAI-ARIA APG & RTL/LTR pattern contract checker for automated component and behavior test suites.

/** Supported WAI-ARIA Authoring Practices Guide widget patterns verified by `check_pattern`. */
export type AriaPattern =
	| 'dialog'
	| 'menu'
	| 'menubar'
	| 'listbox'
	| 'combobox'
	| 'tabs'
	| 'accordion'
	| 'tree'
	| 'grid'
	| 'radiogroup'
	| 'toolbar'
	| 'switch'
	| 'slider'
	| 'carousel';

/** One contract violation detected by `check_pattern` or `check_direction`. */
export type PatternViolation = {
	readonly rule: string;
	readonly message: string;
	readonly element?: Element;
};

function hasAccessibleName(el: Element): boolean {
	const ariaLabel = el.getAttribute('aria-label')?.trim() ?? '';
	if (ariaLabel !== '') return true;
	const labelledBy = el.getAttribute('aria-labelledby')?.trim() ?? '';
	if (labelledBy !== '') {
		const doc = el.ownerDocument;
		for (const id of labelledBy.split(/\s+/)) {
			const ref = doc.getElementById(id);
			if (ref !== null && (ref.textContent?.trim() ?? '') !== '') return true;
		}
	}
	const title = el.getAttribute('title')?.trim() ?? '';
	if (title !== '') return true;
	return (el.textContent?.trim() ?? '') !== '';
}

function checkSingleTabStop(items: readonly Element[], roleName: string, violations: PatternViolation[]): void {
	const enabled = items.filter((el) => !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true');
	if (enabled.length === 0) return;
	const tabbable = enabled.filter((el) => el.getAttribute('tabindex') === '0');
	if (tabbable.length !== 1) {
		violations.push({
			rule: `${roleName}.roving-tabindex`,
			message: `Expected exactly 1 enabled ${roleName} item with tabindex="0", found ${tabbable.length}.`
		});
	}
}

/**
 * Audits a rendered DOM subtree against WAI-ARIA APG structural, naming and keyboard focus
 * requirements for `pattern`. Returns an array of violations (empty means compliant).
 */
export function check_pattern(root: Element, pattern: AriaPattern): readonly PatternViolation[] {
	const violations: PatternViolation[] = [];
	const find = (selector: string): Element[] =>
		root.matches(selector) ? [root, ...root.querySelectorAll(selector)] : [...root.querySelectorAll(selector)];

	if (pattern === 'dialog') {
		const dialogs = find('[role="dialog"], [role="alertdialog"]');
		if (dialogs.length === 0) violations.push({ rule: 'dialog.role', message: 'Missing role="dialog" or role="alertdialog".' });
		for (const d of dialogs) {
			if (!hasAccessibleName(d)) violations.push({ rule: 'dialog.name', message: 'Dialog lacks an accessible name.', element: d });
		}
	} else if (pattern === 'menu') {
		const menus = find('[role="menu"]');
		if (menus.length === 0) violations.push({ rule: 'menu.role', message: 'Missing role="menu".' });
		for (const m of menus) {
			const items = [...m.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')];
			if (items.length === 0) violations.push({ rule: 'menu.items', message: 'Menu has no menuitem descendants.', element: m });
			checkSingleTabStop(items, 'menu', violations);
		}
	} else if (pattern === 'menubar') {
		const bars = find('[role="menubar"]');
		if (bars.length === 0) violations.push({ rule: 'menubar.role', message: 'Missing role="menubar".' });
		for (const bar of bars) {
			const items = [...bar.querySelectorAll('[role="menuitem"]')];
			checkSingleTabStop(items, 'menubar', violations);
		}
	} else if (pattern === 'listbox') {
		const lists = find('[role="listbox"]');
		if (lists.length === 0) violations.push({ rule: 'listbox.role', message: 'Missing role="listbox".' });
		for (const list of lists) {
			const opts = [...list.querySelectorAll('[role="option"]')];
			for (const opt of opts) {
				if (opt.getAttribute('aria-selected') === null) {
					violations.push({ rule: 'listbox.aria-selected', message: 'Option missing aria-selected.', element: opt });
				}
			}
		}
	} else if (pattern === 'combobox') {
		const combos = find('[role="combobox"]');
		if (combos.length === 0) violations.push({ rule: 'combobox.role', message: 'Missing role="combobox".' });
		for (const cb of combos) {
			if (cb.getAttribute('aria-expanded') === null) {
				violations.push({ rule: 'combobox.aria-expanded', message: 'Combobox missing aria-expanded.', element: cb });
			}
			if (cb.getAttribute('aria-expanded') === 'true' && !cb.getAttribute('aria-controls')) {
				violations.push({ rule: 'combobox.aria-controls', message: 'Open combobox missing aria-controls.', element: cb });
			}
		}
	} else if (pattern === 'tabs') {
		const lists = find('[role="tablist"]');
		if (lists.length === 0) violations.push({ rule: 'tabs.tablist', message: 'Missing role="tablist".' });
		for (const list of lists) {
			const tabs = [...list.querySelectorAll('[role="tab"]')];
			if (tabs.length === 0) violations.push({ rule: 'tabs.items', message: 'Tablist has no role="tab" descendants.', element: list });
			const selected = tabs.filter((t) => t.getAttribute('aria-selected') === 'true');
			if (tabs.length > 0 && selected.length === 0) {
				violations.push({ rule: 'tabs.selected', message: 'Tablist has no aria-selected="true" tab.', element: list });
			}
			checkSingleTabStop(tabs, 'tabs', violations);
		}
	} else if (pattern === 'accordion') {
		const triggers = find('button[aria-expanded]');
		if (triggers.length === 0) violations.push({ rule: 'accordion.triggers', message: 'No button[aria-expanded] triggers found.' });
		for (const t of triggers) {
			if (!t.getAttribute('aria-controls')) {
				violations.push({ rule: 'accordion.aria-controls', message: 'Accordion trigger missing aria-controls.', element: t });
			}
		}
	} else if (pattern === 'tree') {
		const trees = find('[role="tree"]');
		if (trees.length === 0) violations.push({ rule: 'tree.role', message: 'Missing role="tree".' });
		for (const tree of trees) {
			const items = [...tree.querySelectorAll('[role="treeitem"]')];
			if (items.length === 0) violations.push({ rule: 'tree.items', message: 'Tree has no role="treeitem" descendants.', element: tree });
		}
	} else if (pattern === 'grid') {
		const grids = find('[role="grid"]');
		if (grids.length === 0) violations.push({ rule: 'grid.role', message: 'Missing role="grid".' });
		for (const g of grids) {
			const cells = [...g.querySelectorAll('[role="gridcell"]')];
			if (cells.length === 0) violations.push({ rule: 'grid.cells', message: 'Grid has no role="gridcell" descendants.', element: g });
			checkSingleTabStop(cells, 'grid', violations);
		}
	} else if (pattern === 'radiogroup') {
		const groups = find('[role="radiogroup"]');
		if (groups.length === 0) violations.push({ rule: 'radiogroup.role', message: 'Missing role="radiogroup".' });
		for (const g of groups) {
			const radios = [...g.querySelectorAll('[role="radio"]')];
			checkSingleTabStop(radios, 'radiogroup', violations);
			for (const r of radios) {
				if (r.getAttribute('aria-checked') === null) {
					violations.push({ rule: 'radiogroup.aria-checked', message: 'Radio missing aria-checked.', element: r });
				}
			}
		}
	} else if (pattern === 'toolbar') {
		const bars = find('[role="toolbar"]');
		if (bars.length === 0) violations.push({ rule: 'toolbar.role', message: 'Missing role="toolbar".' });
		for (const bar of bars) {
			const controls = [...bar.querySelectorAll('button, [role="button"], [tabindex]')];
			checkSingleTabStop(controls, 'toolbar', violations);
		}
	} else if (pattern === 'switch') {
		const switches = find('[role="switch"]');
		if (switches.length === 0) violations.push({ rule: 'switch.role', message: 'Missing role="switch".' });
		for (const s of switches) {
			if (s.getAttribute('aria-checked') === null) {
				violations.push({ rule: 'switch.aria-checked', message: 'Switch missing aria-checked.', element: s });
			}
			if (!hasAccessibleName(s)) {
				violations.push({ rule: 'switch.name', message: 'Switch lacks an accessible name.', element: s });
			}
		}
	} else if (pattern === 'slider') {
		const sliders = find('[role="slider"]');
		if (sliders.length === 0) violations.push({ rule: 'slider.role', message: 'Missing role="slider".' });
		for (const s of sliders) {
			if (s.getAttribute('aria-valuenow') === null && s.getAttribute('aria-valuetext') === null) {
				violations.push({ rule: 'slider.value', message: 'Slider missing aria-valuenow/aria-valuetext.', element: s });
			}
		}
	} else if (pattern === 'carousel') {
		const regions = find('[aria-roledescription="carousel"]');
		if (regions.length === 0) violations.push({ rule: 'carousel.roledescription', message: 'Missing aria-roledescription="carousel".' });
	}

	return violations;
}

/**
 * Verifies that an element resolves to the expected writing direction (`'ltr'` or `'rtl'`)
 * via inherited `dir` attribute / computed style.
 */
export function check_direction(root: Element, expected: 'ltr' | 'rtl'): readonly PatternViolation[] {
	const closest = root.closest('[dir]');
	const attr = closest?.getAttribute('dir')?.toLowerCase();
	const actual = attr === 'rtl' || attr === 'ltr' ? attr : getComputedStyle(root).direction || 'ltr';
	if (actual !== expected) {
		return [
			{
				rule: 'direction.mismatch',
				message: `Expected direction "${expected}", resolved "${actual}".`,
				element: root
			}
		];
	}
	return [];
}
