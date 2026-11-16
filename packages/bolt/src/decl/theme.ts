import { Schema } from 'effect';

/** Semantic CSS variables shared by Bolt's shell and application components. */
export const THEME_TOKENS = [
	'background',
	'foreground',
	'card',
	'card-foreground',
	'popover',
	'popover-foreground',
	'primary',
	'primary-foreground',
	'secondary',
	'secondary-foreground',
	'muted',
	'muted-foreground',
	'accent',
	'accent-foreground',
	'destructive',
	'destructive-foreground',
	'success',
	'success-foreground',
	'info',
	'info-foreground',
	'warning',
	'warning-foreground',
	'border',
	'input',
	'ring',
	'chart-1',
	'chart-2',
	'chart-3',
	'chart-4',
	'chart-5',
	'sidebar',
	'sidebar-foreground',
	'sidebar-primary',
	'sidebar-primary-foreground',
	'sidebar-accent',
	'sidebar-accent-foreground',
	'sidebar-border',
	'sidebar-ring',
	'brand',
	'brand-foreground',
	'brand-text',
	'brand-muted',
	'brand-50',
	'brand-100',
	'brand-200',
	'brand-300',
	'brand-400',
	'brand-500',
	'brand-600',
	'brand-700',
	'brand-800',
	'brand-900',
	'brand-950',
	'font-sans',
	'font-mono',
	'radius'
] as const;
/** A partial theme: omitted variables keep Bolt's defaults. Values are CSS colours, font stacks or a radius length. */
export type ThemeTokens = Partial<Record<(typeof THEME_TOKENS)[number], string>>;
/** Workspace-wide light and dark overrides, compiled into CSS rather than applied by page scripts. */
export type WorkspaceTheme = { light?: ThemeTokens; dark?: ThemeTokens };
const allowed = new Set<string>(THEME_TOKENS);
const value = Schema.String.check(
	Schema.makeFilter(
		(text) =>
			text.trim().length > 0 &&
			text.length <= 512 &&
			!/[;{}@<>\u0000-\u001f]/.test(text) &&
			!/url\s*\(|\/\*/i.test(text)
	)
);
const tokens = Schema.Record(Schema.String, value).check(
	Schema.makeFilter((values) => Object.keys(values).every((key) => allowed.has(key)))
);
/** The manifest boundary accepts known tokens and one CSS value per token, never declarations or remote resources. */
export const WorkspaceThemeData = Schema.Struct({
	light: Schema.optionalKey(tokens),
	dark: Schema.optionalKey(tokens)
});
/** Stable, workspace-local CSS; variables inherit into portals and respect the viewer's light/dark choice. */
export function theme_css(theme: typeof WorkspaceThemeData.Type | undefined): string {
	if (theme === undefined) return '';
	return (['light', 'dark'] as const)
		.map((mode) => {
			const values = theme[mode];
			if (values === undefined || Object.keys(values).length === 0) return '';
			return `${mode === 'light' ? ':root:not(.dark)' : ':root.dark'}{${Object.keys(values)
				.sort()
				.map((name) => `--${name}:${values[name]};`)
				.join('')}}\n`;
		})
		.join('');
}
