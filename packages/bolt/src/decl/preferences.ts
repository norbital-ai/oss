import { Schema } from 'effect';

/** The appearance choices stored on a member, and used by the native account menu. */
export const APPEARANCES = ['light', 'dark', 'system'] as const;
/** Default framework languages; workspaces may declare additional BCP-47 languages in `workspace({ languages })`. */
export const PERSONAL_LOCALES = ['en', 'zh'] as const;
const LOCALE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
/** The persisted personal preferences returned by native reads. */
export const PersonalPreferences = Schema.Struct({
	appearance: Schema.optionalKey(Schema.Literals(APPEARANCES)),
	locale: Schema.optionalKey(Schema.String.check(Schema.isPattern(LOCALE_TAG))),
	sounds: Schema.optionalKey(Schema.Boolean)
});
/** The same preferences as a built-in model field; unknown keys are refused by the normal kind validator. */
export const PERSONAL_PREFERENCES_FIELD = {
	kind: 'json',
	shape: {
		kind: 'object',
		fields: {
			appearance: { kind: 'enum', values: APPEARANCES, optional: true },
			locale: { kind: 'text', max: 35, optional: true },
			sounds: { kind: 'bool', optional: true }
		}
	},
	default: {}
} as const;
