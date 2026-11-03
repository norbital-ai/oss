// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { fillField, pageClickable, pageField, pageFieldLabel, pageLabel } from '../src/shell/agent/page.ts';

describe('the current-tab page bridge', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		Object.defineProperty(HTMLElement.prototype, 'getClientRects', {
			configurable: true,
			value: () => ({ length: 1 })
		});
	});
	it('finds a board card, a button and a same-page link by visible text, never the shell chrome', () => {
		document.body.innerHTML = `<main>
			<div data-board-card="p1">GREY_RUBBER_0001</div>
			<button>Delete</button>
			<a href="/app/x">Open project</a>
		</main><button>Outside</button>`;
		expect(pageClickable('GREY_RUBBER_0001')?.getAttribute('data-board-card')).toBe('p1');
		expect(pageClickable('delete')?.tagName).toBe('BUTTON');
		expect(pageClickable('open project')?.getAttribute('href')).toBe('/app/x');
		expect(pageClickable('outside')).toBeNull();
	});
	it('never reaches an approval decision, in a panel or a held card', () => {
		document.body.innerHTML = `<main>
			<button>Save</button>
			<div data-view="approval">
				<button>Approve</button>
				<button>Reject</button>
				<label>Reason <input aria-label="Reason" /></label>
			</div>
			<div data-approval="held"><button>Request changes</button></div>
		</main>`;
		expect(pageClickable('save')?.textContent).toBe('Save');
		expect(pageClickable('Approve')).toBeNull();
		expect(pageClickable('Reject')).toBeNull();
		expect(pageClickable('Request changes')).toBeNull();
		expect(pageField('Reason')).toBeNull();
	});
	it('shows the control and field a person would read, in their own case', () => {
		document.body.innerHTML = `<main>
			<button aria-label="Delete project">Delete</button>
			<label>Customer reference / S/no <input aria-label="Customer reference / S/no" /></label>
		</main>`;
		const control = pageClickable('delete');
		const field = pageField('Customer reference / S/no');
		if (control === null || field === null) throw new Error('the control or field is missing');
		expect(pageLabel(control)).toBe('Delete project');
		expect(pageFieldLabel(field)).toBe('Customer reference / S/no');
	});
	it('finds a field in a page sheet, and never in the Norbius panel', () => {
		document.body.innerHTML = `<main></main>
			<div role="dialog" aria-label="New project">
				<label>Customer reference / S/no <input aria-label="Customer reference / S/no" /></label>
			</div>
			<div role="dialog" aria-label="Norbius"><input aria-label="Composer" /></div>`;
		expect(pageField('Customer reference / S/no')).not.toBeNull();
		expect(pageField('Composer')).toBeNull();
	});
	it('fills a visible text field with native events and never a password or file field', () => {
		document.body.innerHTML = `<main>
			<label>Colour code <input aria-label="Colour code" /></label>
			<input type="password" aria-label="Password" />
			<input type="file" aria-label="Attachment" />
		</main>`;
		const field = pageField('Colour code');
		if (field === null || !(field instanceof HTMLInputElement))
			throw new Error('the colour field is missing');
		expect(pageField('Password')).toBeNull();
		expect(pageField('Attachment')).toBeNull();
		const events: string[] = [];
		field.addEventListener('input', () => events.push('input'));
		field.addEventListener('change', () => events.push('change'));
		fillField(field, 'GREY-42', false);
		expect(field.value).toBe('GREY-42');
		expect(events).toEqual(['input', 'change']);
	});
});
