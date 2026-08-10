import { defineMessages, type KeysOf } from '@norbital-ai/std/i18n';
import { commonMessages } from './common.messages.js';
import { tableMessages } from './table.messages.js';
import { kanbanMessages } from './kanban.messages.js';
import { formMessages } from './form.messages.js';
import { dataRendererMessages } from './data-renderer.messages.js';
import { miscMessages } from './misc.messages.js';

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
		...miscMessages.en
	},
	zh: {
		...commonMessages.zh,
		...tableMessages.zh,
		...kanbanMessages.zh,
		...formMessages.zh,
		...dataRendererMessages.zh,
		...miscMessages.zh
	}
});

/** The typed key union of the ui catalog, for `useI18n<UiKeys>()`. */
export type UiKeys = KeysOf<typeof uiMessages>;
