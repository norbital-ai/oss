import type { FileUrlOptions } from '@norbital-ai/std/kind';
import { resolveDevice } from '../../page/device.ts';
import { storedFileUrl } from '../../page/file-ref.ts';
import type { PublicBoot } from '../../protocol/public-page.ts';
import { href } from '../nav.ts';

/** Metadata and URLs shared by the public server render and its hydrated page. */
export const publicContext = (boot: PublicBoot) => ({
	org: { name: boot.workspace.name, logo: boot.workspace.logo ?? null },
	device: resolveDevice(),
	tz: boot.workspace.tz,
	location: boot.location,
	href: (...args: Parameters<typeof href>) => `${boot.base}${href(...args)}`,
	file_url: (ref: { readonly id: string }, options: FileUrlOptions = {}) =>
		storedFileUrl(
			boot.base,
			ref.id,
			options,
			boot.kiosk !== null
				? { kiosk: boot.kiosk }
				: boot.visitor === null
					? undefined
					: { app: boot.visitor.app }
		)
});
