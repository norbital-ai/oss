/**
 * Playwright Chromium for every headed test. Not Obscura. Not Colony Browser.layerObscura.
 *
 * Default is headless. Set `PLAYWRIGHT_HEADED=1` (display only) to run real windows so the
 * visibility rows assert `document.hidden === false`; on macOS those windows background
 * themselves (`open -j`) so the run never steals focus, but they still appear on screen.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	chromium,
	type Browser,
	type BrowserContext,
	type CDPSession,
	type Page
} from 'playwright';

export class MissingChromiumError extends Error {
	override readonly name = 'missing_chromium';
	constructor(message = 'Playwright Chromium is not installed') {
		super(message);
	}
}

export type HeadedPage = {
	readonly evaluate: (expression: string) => Promise<unknown>;
	readonly click: (selector: string) => Promise<void>;
	readonly clickAt: (x: number, y: number) => Promise<void>;
	readonly openWindow: (url: string) => Promise<HeadedPage>;
	readonly close: () => Promise<void>;
};

export type OpenPageOptions = Readonly<{
	/** Open a distinct browser profile (own contexts, Web Locks, storage). Default: shared profile. */
	readonly profile?: boolean;
}>;

export type HeadedBrowser = {
	readonly source: 'playwright';
	readonly openPage: (url: string, options?: OpenPageOptions) => Promise<HeadedPage>;
	readonly close: () => Promise<void>;
	readonly stop: () => Promise<void>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object';

const evaluatedValue = (response: unknown): unknown => {
	if (!isRecord(response)) return undefined;
	if (response.exceptionDetails !== undefined) {
		const details = response.exceptionDetails;
		const text =
			isRecord(details) && typeof details.text === 'string'
				? details.text
				: JSON.stringify(details);
		throw new Error(text);
	}
	if (!isRecord(response.result) || !('value' in response.result)) return undefined;
	return response.result.value;
};

const runOnSession = async (client: CDPSession, expression: string): Promise<unknown> =>
	evaluatedValue(
		await client.send('Runtime.evaluate', {
			expression,
			returnByValue: true,
			awaitPromise: true
		})
	);

export const isHeadedRun = (): boolean => process.env['PLAYWRIGHT_HEADED'] === '1';

export const launchChromiumOrSkip = async (
	initScript?: string
): Promise<HeadedBrowser | undefined> => {
	try {
		return await launchChromium(initScript);
	} catch (error: unknown) {
		if (error instanceof MissingChromiumError) {
			console.warn(`missing_chromium: ${error.message}`);
			return undefined;
		}
		throw error;
	}
};

export const guestUrlForChromium = (host: string, port: number, path: string): string => {
	const hostname = host === '0.0.0.0' ? '127.0.0.1' : host;
	const normalized = path.startsWith('/') ? path : `/${path}`;
	return `http://${hostname}:${port}${normalized}`;
};

const wrapPage = async (page: Page): Promise<HeadedPage> => {
	const client = await page.context().newCDPSession(page);
	await client.send('Runtime.enable');
	return {
		evaluate: (expression) => runOnSession(client, expression),
		click: (selector) => page.click(selector),
		clickAt: (x, y) => page.mouse.click(x, y),
		openWindow: async (url) => {
			const child = await page.context().newPage();
			await child.goto(url, { waitUntil: 'domcontentloaded' });
			return wrapPage(child);
		},
		close: async () => {
			await client.detach().catch(() => undefined);
			await page.close().catch(() => undefined);
		}
	};
};

const sleep = (millis: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, millis));

const freePort = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = address !== null && typeof address === 'object' ? address.port : undefined;
			server.close(() => {
				if (port === undefined) reject(new Error('free port probe failed'));
				else resolve(port);
			});
		});
	});

const APP_BINARIES = ['Chromium', 'Google Chrome', 'Google Chrome for Testing'] as const;

const chromiumApplicationPath = (): string | undefined => {
	const executable = chromium.executablePath();
	const app = resolve(executable, '../../..');
	const contents = join(app, 'Contents', 'MacOS');
	return APP_BINARIES.some((name) => existsSync(join(contents, name))) ? app : undefined;
};

type Session = {
	readonly browser: Browser;
	readonly context: BrowserContext;
	readonly stop: () => Promise<void>;
};

/**
 * macOS-headed Chromium that never grabs focus: `open -j` launches the app hidden (no
 * activation; the window stays behind the active app), Playwright then attaches over CDP.
 * `document.hidden === false` still holds because the window is neither minimized nor occluded
 * by the app shell.
 */
const openBackgroundSession = async (
	initScripts: readonly string[]
): Promise<Session> => {
	const app = chromiumApplicationPath();
	if (app === undefined) {
		throw new MissingChromiumError(`Chromium bundle missing for ${chromium.executablePath()}`);
	}
	const profileDirectory = await mkdtemp(join(tmpdir(), 'norbital-chromium-'));
	const port = await freePort();
	const args = [
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profileDirectory}`,
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-background-timer-throttling',
		'--disable-popup-blocking',
		'--window-size=1440,900'
	];
	await new Promise<void>((resolve, reject) => {
		spawn('open', ['-jna', app, '--args', ...args], { stdio: 'ignore' })
			.once('error', reject)
			.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`open exited ${String(code)}`))));
	});
	const deadline = Date.now() + 20_000;
	let last: unknown = 'never answered';
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (response.ok) break;
		} catch (error) {
			last = error;
		}
		await sleep(200);
	}
	const ready = Date.now() < deadline;
	if (!ready) {
		await rm(profileDirectory, { recursive: true, force: true }).catch(() => undefined);
		throw new MissingChromiumError(`background Chromium CDP never answered: ${String(last)}`);
	}
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	const primary = browser.contexts()[0];
	if (primary === undefined) {
		await rm(profileDirectory, { recursive: true, force: true }).catch(() => undefined);
		throw new MissingChromiumError('background Chromium has no default context');
	}
	for (const script of initScripts) await primary.addInitScript(script);
	const stop = async (): Promise<void> => {
		await browser.close().catch(() => undefined);
		spawn('pkill', ['-f', profileDirectory], { stdio: 'ignore' }).unref();
		await rm(profileDirectory, { recursive: true, force: true }).catch(() => undefined);
	};
	return { browser, context: primary, stop };
};

/**
 * Chromium for every headed test. Not Obscura. Not Colony Browser.layerObscura.
 *
 * Default is headless — nothing is ever drawn and nothing can take focus. Set `PLAYWRIGHT_HEADED=1`
 * to run real windows so the visibility rows assert `document.hidden === false`; on macOS the
 * instance tries to background itself (`open -j` has no guaranteed no-activation), so headed runs
 * are opt-in on display-equipped machines or CI with a display, never part of the default loop.
 */
export const launchChromium = async (initScript?: string): Promise<HeadedBrowser> => {
	const headless = !isHeadedRun();
	const initScripts = initScript !== undefined && initScript.length > 0 ? [initScript] : [];
	if (!headless && process.platform === 'darwin') {
		const sessions = new Set<Session>();
		const openContext = async (): Promise<Session> => {
			const session = await openBackgroundSession(initScripts);
			sessions.add(session);
			return session;
		};
		const shared = await openContext();
		const close = async (): Promise<void> => {
			for (const session of sessions) await session.stop();
			sessions.clear();
		};
		return {
			source: 'playwright',
			openPage: async (url, options) => {
				const session = options?.profile === true ? await openContext() : shared;
				const page = await session.context.newPage();
				await page.setViewportSize({ width: 1440, height: 900 });
				await page.goto(url, { waitUntil: 'domcontentloaded' });
				return wrapPage(page);
			},
			close,
			stop: close
		};
	}

	let browser: Browser;
	try {
		browser = await chromium.launch({
			headless,
			args: ['--disable-background-timer-throttling', '--disable-popup-blocking']
		});
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		throw new MissingChromiumError(message);
	}
	const contexts = new Set<BrowserContext>();
	const openContext = async (): Promise<BrowserContext> => {
		const context = await browser.newContext({
			viewport: { width: 1440, height: 900 }
		});
		contexts.add(context);
		for (const script of initScripts) await context.addInitScript(script);
		return context;
	};
	const shared = await openContext();
	const close = async (): Promise<void> => {
		for (const context of contexts) await context.close().catch(() => undefined);
		contexts.clear();
		await browser.close().catch(() => undefined);
	};
	return {
		source: 'playwright',
		openPage: async (url, options) => {
			const context = options?.profile === true ? await openContext() : shared;
			const page = await context.newPage();
			await page.goto(url, { waitUntil: 'domcontentloaded' });
			return wrapPage(page);
		},
		close,
		stop: close
	};
};
