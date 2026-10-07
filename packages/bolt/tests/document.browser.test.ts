import { expect, test } from 'vitest';
import { page } from 'vitest/browser';

test('Playwright Chromium paints a document the locators can read (L-BOLT-1011)', async () => {
	document.body.replaceChildren();
	const mark = document.createElement('p');
	mark.textContent = 'bolt fixture';
	document.body.append(mark);
	await expect.element(page.getByText('bolt fixture')).toBeInTheDocument();
});

test('locator click reaches the document', async () => {
	document.body.replaceChildren();
	const button = document.createElement('button');
	button.textContent = 'ping';
	button.addEventListener('click', () => {
		button.textContent = 'pong';
	});
	document.body.append(button);
	await page.getByRole('button', { name: 'ping' }).click();
	await expect.element(page.getByText('pong')).toBeInTheDocument();
});
