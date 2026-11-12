import type { FileUrlOptions } from '@norbital-ai/std/kind';
import { resolve_device } from '../../page/device.ts';
import { stored_file_url } from '../../page/file-ref.ts';
import type { PublicBoot } from '../../protocol/public-page.ts';
import { href } from '../nav.ts';

/** Metadata and URLs shared by the public server render and its hydrated page. */
export const public_context = (boot: PublicBoot) => ({
	org: { name: boot.workspace.name, logo: boot.workspace.logo ?? null },
	device: resolve_device(),
	tz: boot.workspace.tz,
	location: boot.location,
	href: (...args: Parameters<typeof href>) => `${boot.base}${href(...args)}`,
	file_url: (ref: { readonly id: string }, options: FileUrlOptions = {}) =>
		stored_file_url(
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
