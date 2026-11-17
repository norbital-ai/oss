import { Schema } from 'effect';

/** The appearance choices stored on a member, and used by the native account menu. */
export const APPEARANCES = ['light', 'dark', 'system'] as const;
/** Framework languages a member can select; absent uses the workspace's locale. */
export const PERSONAL_LOCALES = ['en', 'zh'] as const;
/** The persisted personal preferences returned by native reads. */
export const PersonalPreferences = Schema.Struct({
	appearance: Schema.optionalKey(Schema.Literals(APPEARANCES)),
	locale: Schema.optionalKey(Schema.Literals(PERSONAL_LOCALES)),
	sounds: Schema.optionalKey(Schema.Boolean)
});
/** The same preferences as a built-in model field; unknown keys are refused by the normal kind validator. */
export const PERSONAL_PREFERENCES_FIELD = {
	kind: 'json',
	shape: {
		kind: 'object',
		fields: {
			appearance: { kind: 'enum', values: APPEARANCES, optional: true },
			locale: { kind: 'enum', values: PERSONAL_LOCALES, optional: true },
			sounds: { kind: 'bool', optional: true }
		}
	},
	default: {}
} as const;
