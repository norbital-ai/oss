import { defineMessages, type KeysOf } from '@norbital-ai/std/i18n';
import { commonMessages } from '#lib/i18n/messages/common.messages';
import { tableMessages } from '#lib/i18n/messages/table.messages';
import { kanbanMessages } from '#lib/i18n/messages/kanban.messages';
import { formMessages } from '#lib/i18n/messages/form.messages';
import { dataRendererMessages } from '#lib/i18n/messages/data-renderer.messages';
import { miscMessages } from '#lib/i18n/messages/misc.messages';
import { recordMetadataMessages } from '#lib/i18n/messages/record-metadata.messages';

/**
 * The complete `@norbital-ai/ui` catalog: English source of truth plus the
 * Chinese pair, with compile-time key parity.
 *
 * The spread merge keeps each namespace file a single owner, so parallel
 * migration passes can extend a namespace without touching this file.
 */
export const uiMessages = defineMessages({
	en: {
		...commonMessages.en,
		...tableMessages.en,
		...kanbanMessages.en,
		...formMessages.en,
		...dataRendererMessages.en,
		...miscMessages.en,
		...recordMetadataMessages.en
	},
	zh: {
		...commonMessages.zh,
		...tableMessages.zh,
		...kanbanMessages.zh,
		...formMessages.zh,
		...dataRendererMessages.zh,
		...miscMessages.zh,
		...recordMetadataMessages.zh
	}
});

/** The typed key union of the ui catalog, for `useI18n<UiKeys>()`. */
export type UiKeys = KeysOf<typeof uiMessages>;
