// The current tab's closed page bridge: find a link/card/button or a writable text field by its visible label, and
// fill a field with native events. No selector, script or password/file field enters this module, and an approval is
// never a target: the person decides those themselves.
import { fork, run } from '@norbital-ai/ui/effect';
import { confirm_action } from '@norbital-ai/ui';
import { Effect } from 'effect';
import type { PageResult } from '../../protocol/schema.ts';
import type { ShellApi } from '../api-types.ts';
import type { ClientPageAction } from './navigation.ts';
import { logical } from '../nav.ts';

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
		('labels' in el && el.labels instanceof NodeList && el.labels[0] instanceof HTMLElement
			? el.labels[0].innerText : undefined) ??
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
				(!('type' in el) || (el.type !== 'password' && el.type !== 'file')) &&
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

/** The active tab's page-action dispatcher; the shell supplies current eligibility and navigation. */
export function clientPageAction({ api, eligible, navigate, open_external, closePanel, t }: {
	api: Pick<ShellApi['agent'], 'page_result' | 'claim_page_action'>;
	eligible(): boolean;
	navigate(href: string): void;
	open_external(href: string): void;
	closePanel(): void;
	t(key: string): string;
}): ClientPageAction {
	/** The active tab's claim on a page action: the server lets exactly one tab own it, across windows and devices. */
	const claimedBy = (output: unknown): boolean =>
		typeof output === 'object' && output !== null && 'claimed' in output && output.claimed === true;

	/** The page settles first: what it then shows reaches Norbius with the answer. */
	const answerPage = (step: string, result: PageResult) =>
		setTimeout(() => {
			void run(api.page_result(step, { ...result, screen: pageScreen() })).catch(() => {});
		}, 700);
	return {
		arrived(step) {
			if (document.visibilityState === 'visible') answerPage(step, { ok: true });
		},
		run(action, _conversation, step) {
			const ack = (result: PageResult) => answerPage(step, result);
			// a hidden or ineligible tab stays silent: a second tab must never overwrite the acting tab's result
			if (!eligible()) return;
			const act = () => {
				if (action.highlight !== undefined) {
					const target = pageMark(action.highlight);
					if (target === null) {
						ack({ ok: false, note: `Nothing visible reads “${action.highlight}”.` });
						return;
					}
					target.scrollIntoView({ block: 'center' });
					// the panel must not sit over what it points at
					if (pageCovered(target)) closePanel();
					ringOn(target);
					ack({ ok: true, note: `Highlighted “${action.highlight}”.` });
					return;
				}
				if (action.scroll !== undefined) {
					let scroller: HTMLElement | null = document.querySelector<HTMLElement>('main');
					while (scroller !== null && scroller.scrollHeight <= scroller.clientHeight + 1)
						scroller = scroller.parentElement;
					(scroller ?? document.scrollingElement ?? window).scrollBy({
						top: action.scroll,
						behavior: 'smooth'
					});
					ack({ ok: true, note: `Scrolled ${action.scroll}px.` });
					return;
				}
				if (action.go !== undefined) {
					if (action.go === 'back') history.back();
					else history.forward();
					ack({ ok: true, note: `Went ${action.go}.` });
					return;
				}
				if (action.type !== undefined) {
					const fill = action.type;
					const field = pageField(fill.label);
					if (field === null) {
						ack({ ok: false, note: `No visible field “${fill.label}”.` });
						return;
					}
					const shown = fill.text.length > 120 ? `${fill.text.slice(0, 120)}…` : fill.text;
					fork(
						confirm_action({
							title: t('Norbius wants to type into this page'),
							body: t('Fill “{field}” with “{value}”? It can change your workspace.')
								.replace('{field}', pageFieldLabel(field) || fill.label)
								.replace('{value}', shown),
							confirm_label: t('Fill it'),
							destructive: true
						}).pipe(
							Effect.tap((yes) =>
								Effect.sync(() => {
									if (yes) {
										fillField(field, fill.text, fill.submit === true);
										ack({ ok: true, note: `Filled “${pageFieldLabel(field) || fill.label}”.` });
									} else ack({ ok: false, note: 'The person declined.' });
								})
							)
						)
					);
					return;
				}
				if (action.click === undefined) return;
				const control = pageClickable(action.click);
				if (control === null) {
					ack({ ok: false, note: `No visible control “${action.click}”.` });
					return;
				}
				// a board card is a record opener, not a mutation: it is the card the person sees.
				if (control.matches('[data-board-card]')) {
					control.click();
					ack({ ok: true, note: `Opened “${pageLabel(control)}”.` });
					return;
				}
				const link = control.closest<HTMLAnchorElement>('a[href]');
				if (link !== null && !link.hasAttribute('download')) {
					const next = logical(link.href);
					if (next !== null && !next.pathname.startsWith('/__bolt/')) {
						navigate(next.href);
						ack({ ok: true, url: next.href });
						return;
					}
					if (new URL(link.href, location.href).origin !== location.origin) {
						fork(
							confirm_action({
								title: t('Norbius wants to open a link'),
								body: t('Open “{link}” in your browser?').replace('{link}', link.href),
								confirm_label: t('Open it')
							}).pipe(
								Effect.tap((yes) =>
									Effect.sync(() => {
										if (yes) {
											open_external(link.href);
											ack({ ok: true, note: 'Opened the external link.' });
										} else ack({ ok: false, note: 'The person declined.' });
									})
								)
							)
						);
						return;
					}
					ack({ ok: false, note: 'That link is outside the workspace.' });
					return;
				}
				fork(
					confirm_action({
						title: t('Norbius wants to use this page'),
						body: t('Press “{control}”? It can change your workspace.').replace(
							'{control}',
							pageLabel(control) || action.click
						),
						confirm_label: t('Press it'),
						destructive: true
					}).pipe(
						Effect.tap((yes) =>
							Effect.sync(() => {
								if (yes) {
									control.click();
									ack({ ok: true, note: `Pressed “${pageLabel(control)}”.` });
								} else ack({ ok: false, note: 'The person declined.' });
							})
						)
					)
				);
			};
			void run(api.claim_page_action(step))
				.then((answer) => {
					if (answer.kind === 'committed' && claimedBy(answer.output)) act();
				})
				.catch(() => {});
		}
	};
}
