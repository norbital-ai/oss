// bolt-server's `RenderPort` (`ctx.convert.record`): headless Chromium printing the shell's print route. One browser,
// launched on first use (or the one at a CDP endpoint), and a fresh context per print, so no print keeps cookies or
// storage. The render grant goes only to the workspace's own origin.
import { chromium, type Browser } from 'playwright';
import type { RenderPort } from '@norbital-ai/bolt/engine';

export const chromium_render = (
	public_url: string,
	cdp: string | null
): RenderPort & { close(): Promise<void> } => {
	let browser: Promise<Browser> | undefined;
	const origin = new URL(public_url).origin;
	return {
		pdf: async ({ path, authorization }, signal) => {
			browser ??= cdp === null ? chromium.launch() : chromium.connectOverCDP(cdp);
			const context = await (await browser).newContext();
			const abort = () => void context.close();
			signal.addEventListener('abort', abort, { once: true });
			try {
				await context.route('**/*', (route) =>
					new URL(route.request().url()).origin === origin
						? route.continue({ headers: { ...route.request().headers(), authorization } })
						: route.continue()
				);
				const page = await context.newPage();
				await page.emulateMedia({ media: 'print' });
				await page.goto(`${public_url}${path}`);
				// the shell marks the print `ready` once the record's reads settle, `failed` when it cannot show it
				const state = await page.waitForFunction('document.documentElement.dataset.boltPrint', undefined, {
					timeout: 0
				});
				if (String(await state.jsonValue()) !== 'ready')
					throw new Error('the record could not be shown for printing');
				return new Uint8Array(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
			} finally {
				signal.removeEventListener('abort', abort);
				await context.close();
			}
		},
		close: async () => {
			if (browser !== undefined) await (await browser).close();
		}
	};
};
