// The SSR $bolt alias reads only its current Svelte request context. Loader I/O belongs to pageServer's native ctx.
import { getContext } from 'svelte';
import type { ViewBolt } from '@norbital-ai/ui';
import type { Bolt } from '../../page/bolt.ts';
import type { FileUrlOptions } from '@norbital-ai/std/kind';
import { storedFileUrl } from '../../page/file-ref.ts';
import type { PublicBoot } from '../../protocol/public-page.ts';
import { PUBLIC_PAGE_CONTEXT } from './context.ts';
import { href } from '../nav.ts';

const boot = (): PublicBoot => {
	const value = getContext<PublicBoot | undefined>(PUBLIC_PAGE_CONTEXT);
	if (value === undefined)
		throw new Error('Public page metadata is unavailable outside its request render');
	return value;
};
const unavailable = (): never => {
	throw new Error(
		'Public page SSR renders loaded data; move reads into pageServer.load and start interactive effects on mount'
	);
};

/** State factories defer their sources until the client mounts; SSR can render their initial values. */
export { live, query } from '@norbital-ai/ui/effect';
/** The UI edge has no browser runtime on the server; synchronous rendering must never launch a workflow. */
export const run: typeof import('@norbital-ai/ui/effect').run = unavailable;
export const fork: typeof import('@norbital-ai/ui/effect').fork = unavailable;
export const attach: typeof import('@norbital-ai/ui/effect').attach = unavailable;
export { frameworkText } from '../i18n.ts';

/** Views share the same narrow synchronous metadata; their interactive methods cannot perform SSR side effects. */
export const bolt = {
	read: unavailable,
	get: unavailable,
	aggregate: unavailable,
	similar: unavailable,
	history: unavailable,
	query: unavailable,
	live: unavailable,
	recordCapabilities: unavailable,
	act: unavailable,
	start: unavailable,
	decode: unavailable,
	describe: unavailable,
	options: unavailable,
	upload: unavailable,
	approvals: { process: unavailable, get: unavailable, list: unavailable },
	restore: { preview: unavailable, run: unavailable },
	session: { sendCode: unavailable, verify: unavailable },
	get actor() {
		return boot().actor;
	},
	get locale() {
		return boot().workspace.locale;
	},
	get org() {
		return { name: boot().workspace.name, logo: boot().workspace.logo ?? null };
	},
	href: (...args: Parameters<typeof href>) => `${boot().base}${href(...args)}`,
	fileUrl: (ref: { readonly id: string }, options: FileUrlOptions = {}) => {
		const page = boot();
		return storedFileUrl(
			page.base,
			ref.id,
			options,
			page.kiosk !== null
				? { kiosk: page.kiosk }
				: page.visitor === null
					? undefined
					: { app: page.visitor.app }
		);
	},
	t: (key: string, vars?: { readonly [name: string]: string | number }): string => {
		const message = boot().messages[key] ?? key;
		return vars === undefined
			? message
			: message.replace(/\{([^{}]+)\}/g, (whole, name: string) => String(vars[name] ?? whole));
	}
} satisfies ViewBolt &
	Pick<Bolt, 'upload' | 'session'> & {
		readonly org: { readonly name: string; readonly logo: string | null };
		readonly href: typeof href;
	};
