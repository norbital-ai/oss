import type { I18nApi } from '@norbital-ai/ui/i18n';
import type { TenantI18nKeys } from '$pod/i18n-keys';

export type Translator = I18nApi<TenantI18nKeys>['t'];

export function formatSingaporeInstant(
	value: string | Date | null | undefined,
	t: Translator
): string {
	if (!value) return t('component.not_recorded');
	return new Intl.DateTimeFormat('en-SG', {
		dateStyle: 'medium',
		timeStyle: 'short',
		timeZone: 'Asia/Singapore'
	}).format(new Date(value));
}
