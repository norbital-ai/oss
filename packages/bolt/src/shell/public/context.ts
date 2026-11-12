import type { FileUrlOptions } from '@norbital-ai/std/kind';
import { resolve_device } from '../../page/device.ts';
import { stored_file_url } from '../../page/file-ref.ts';
import type { PublicBoot } from '../../protocol/public-page.ts';
import { href } from '../nav.ts';
import type { UiContext, ViewBolt } from '@norbital-ai/ui';
import type { PublicClient } from './client.ts';

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

/** The `ui` a public page's views take: its view client and the boot's exposure, locale, zone and currency. */
export const public_ui = (
	boot: PublicBoot,
	client: Pick<PublicClient, 'upload' | 'file_url'>,
	views: ViewBolt
): UiContext['ui'] => ({
	bolt: views,
	kinds: {
		catalog: boot.catalog,
		automations: boot.automations,
		locale: boot.workspace.locale,
		zone: boot.workspace.tz,
		currency: boot.workspace.currency,
		query: (request) => views.query(request),
		upload: (file, field) => client.upload(file, field),
		file_url: (ref, options) => client.file_url(ref, options)
	}
});
