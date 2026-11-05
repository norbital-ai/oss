// The current tab's closed page bridge: find a link/card/button or a writable text field by its visible label, and
// fill a field with native events. No selector, script or password/file field enters this module, and an approval is
// never a target: the person decides those themselves.

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();

/** An approval panel or a held approval card: its controls decide a request, so the page bridge never reaches them. */
const approvalOf = (el: Element): boolean =>
	el.closest('[data-view="approval"], [data-approval]') !== null;

/** The page content and its sheets; the agent panel itself is never a target. */
function pageRoots(): HTMLElement[] {
	const main = document.querySelector<HTMLElement>('main');
	const roots = [
		...(main === null ? [] : [main]),
		...[...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter(
			(dialog) => dialog.getAttribute('aria-label') !== 'Norbius' && !dialog.closest('[data-agent]')
		)
	];
	return [...new Set(roots)];
}

/** The label a person would read for a control or field, in its own case. */
export function pageLabel(el: HTMLElement): string {
	return (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.innerText ?? '')
		.replace(/\s+/g, ' ')
		.trim();
}
/** A field's own label: its accessible name, placeholder, name or wrapping label. */
export function pageFieldLabel(el: HTMLElement): string {
	return (
		el.getAttribute('aria-label') ??
		el.getAttribute('placeholder') ??
		el.getAttribute('name') ??
		(el as HTMLInputElement).labels?.[0]?.innerText ??
		''
	)
		.replace(/\s+/g, ' ')
		.trim();
}

/** The first visible control in the page content whose accessible text matches; the page's chrome is out of scope. */
export function pageClickable(text: string): HTMLElement | null {
	const needle = normalized(text);
	if (needle === '') return null;
	const candidates = pageRoots()
		.flatMap((root) => [
			...root.querySelectorAll<HTMLElement>(
				'a[href], button, [role="button"], [role="link"], [data-board-card]'
			)
		])
		.filter(
			(el) =>
				!approvalOf(el) &&
				!el.hasAttribute('disabled') &&
				el.getAttribute('aria-disabled') !== 'true' &&
				el.getClientRects().length > 0
		)
		.map((el) => ({ el, label: normalized(pageLabel(el)) }))
		.filter((candidate) => candidate.label !== '');
	return (
		candidates.find((candidate) => candidate.label === needle)?.el ??
		candidates
			.filter((candidate) => candidate.label.includes(needle))
			.sort((a, b) => a.label.length - b.label.length)[0]?.el ??
		null
	);
}

/** What the page shows, for Norbius: headings and controls as they read, never a field's value. */
export function pageScreen(): string {
	const seen = pageRoots()
		.flatMap((root) => [
			...root.querySelectorAll<HTMLElement>(
				'h1, h2, h3, [role="heading"], th, a[href], button, [role="button"], [role="tab"]'
			)
		])
		.filter((el) => el.getClientRects().length > 0)
		.map(pageLabel)
		.filter((label) => label !== '');
	return [...new Set(seen)].join(' · ').slice(0, 1200);
}

/** The first visible thing reading `text`: a control, else a heading, column or label. */
export function pageMark(text: string): HTMLElement | null {
	const needle = normalized(text);
	return (
		pageClickable(text) ??
		pageRoots()
			.flatMap((root) => [
				...root.querySelectorAll<HTMLElement>('h1, h2, h3, [role="heading"], th, label')
			])
			.find((el) => el.getClientRects().length > 0 && normalized(pageLabel(el)).includes(needle)) ??
		null
	);
}

/** Whether something else, such as Norbius's panel, sits over the middle of `el`. */
export function pageCovered(el: HTMLElement): boolean {
	const box = el.getBoundingClientRect(),
		top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
	return top === null || !(el.contains(top) || top.contains(el));
}

/** Brings something to the person's eye: scrolled to, then ringed for a few seconds. */
export function ringOn(el: HTMLElement): void {
	el.scrollIntoView({ block: 'center', behavior: 'smooth' });
	el.animate(
		{ outline: ['3px solid var(--primary)', '3px solid transparent'], outlineOffset: ['3px', '3px'] },
		{ duration: 6000, easing: 'steps(6, jump-none)' }
	);
}

/** A visible, writable text field in the page content, matched by its accessible label; never a secret or file field. */
export function pageField(label: string): HTMLElement | null {
	const needle = normalized(label);
	if (needle === '') return null;
	const fields = pageRoots()
		.flatMap((root) => [
			...root.querySelectorAll<HTMLElement>(
				'input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], textarea, [contenteditable="true"]'
			)
		])
		.filter(
			(el) =>
				!approvalOf(el) &&
				!el.hasAttribute('disabled') &&
				!el.hasAttribute('readonly') &&
				el.getAttribute('aria-disabled') !== 'true' &&
				(el as HTMLInputElement).type !== 'password' &&
				(el as HTMLInputElement).type !== 'file' &&
				el.getClientRects().length > 0
		);
	return (
		fields.find((el) => normalized(pageFieldLabel(el)) === needle) ??
		fields
			.filter((el) => normalized(pageFieldLabel(el)).includes(needle))
			.sort(
				(a, b) => normalized(pageFieldLabel(a)).length - normalized(pageFieldLabel(b)).length
			)[0] ??
		null
	);
}

/** Fill a field the way a person does: focus, the native setter, input and change, then an optional submit. */
export function fillField(field: HTMLElement, value: string, submit: boolean): void {
	field.focus();
	if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
		const prototype =
			field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
		Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
	} else {
		field.textContent = value;
	}
	field.dispatchEvent(new Event('input', { bubbles: true }));
	field.dispatchEvent(new Event('change', { bubbles: true }));
	if (submit && (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement))
		field.form?.requestSubmit();
}
