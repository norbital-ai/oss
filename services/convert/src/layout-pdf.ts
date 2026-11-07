import { Effect, Semaphore } from 'effect';
import { ConversionFailed, type Converter, type Request } from './convert.ts';

const ORIGIN = 'http://print.invalid/';
const POLICY =
	"default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/** Print the supplied layout without scripts, external resources, or access to the host filesystem. */
export function layoutPdf({
	executable,
	timeoutMs
}: {
	executable: string;
	timeoutMs: number;
}): Converter {
	const lane = Semaphore.makeUnsafe(1);
	const failed = () => new ConversionFailed({ message: 'The layout PDF could not be rendered.' });
	const render = Effect.fn('Convert.layoutPdf')(function* (request: Request) {
		if (request.from !== 'layout-html' || request.to !== 'pdf')
			return yield* new ConversionFailed({ message: 'Layout HTML requires PDF.' });
		return yield* Effect.acquireUseRelease(
			Effect.tryPromise({
				try: async () => {
					const { chromium } = await import('playwright-core');
					return chromium.launch({
						executablePath: executable,
						chromiumSandbox: true,
						timeout: timeoutMs,
						env: Object.fromEntries(
							['PATH', 'HOME', 'TMPDIR', 'LANG'].map((key) => [key, process.env[key]])
						)
					});
				},
				catch: failed
			}),
			(browser) =>
				Effect.tryPromise({
					try: async () => {
						const context = await browser.newContext({
							javaScriptEnabled: false,
							serviceWorkers: 'block',
							offline: true,
							acceptDownloads: false
						});
						let served = false;
						await context.route('**/*', (route) => {
							if (
								served ||
								route.request().url() !== ORIGIN ||
								!route.request().isNavigationRequest()
							)
								return route.abort('blockedbyclient');
							served = true;
							return route.fulfill({
								contentType: 'text/html; charset=utf-8',
								headers: { 'content-security-policy': POLICY },
								body: request.source
							});
						});
						const page = await context.newPage();
						page.setDefaultTimeout(timeoutMs);
						await page.goto(ORIGIN, { waitUntil: 'load' });
						await page.evaluate(async () => {
							await document.fonts.ready;
						});
						return new Uint8Array(
							await page.pdf({
								format: request.page ?? 'A4',
								printBackground: true,
								landscape: request.landscape ?? false,
								margin: { top: '0', right: '0', bottom: '0', left: '0' }
							})
						);
					},
					catch: failed
				}),
			(browser) => Effect.promise(() => browser.close().catch(() => {}))
		).pipe(Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(failed()) }));
	});
	return (request) => lane.withPermit(render(request));
}
