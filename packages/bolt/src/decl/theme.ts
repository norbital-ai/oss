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
	'surface-canvas',
	'surface-card',
	'surface-popover',
	'surface-muted',
	'surface-subtle',
	'surface-track',
	'surface-active',
	'surface-hover',
	'surface-input',
	'surface-lane',
	'content-primary',
	'content-secondary',
	'content-tertiary',
	'border-subtle',
	'border-control',
	'border-active',
	'destructive',
	'destructive-foreground',
	'success',
	'success-foreground',
	'info',
	'info-foreground',
	'warning',
	'warning-foreground',
	'tone-success-bg',
	'tone-success-border',
	'tone-success-text',
	'tone-warning-bg',
	'tone-warning-border',
	'tone-warning-text',
	'tone-info-bg',
	'tone-info-border',
	'tone-info-text',
	'tone-destructive-bg',
	'tone-destructive-border',
	'tone-destructive-text',
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

/** Curated surface palettes: `warm` (Cream/Midnight default), `neutral` (Slate/Obsidian), `crisp` (White/Black). */
export const THEME_PALETTES = ['warm', 'neutral', 'crisp'] as const;
/** Named surface palette preset (`'warm'`, `'neutral'`, or `'crisp'`). */
export type ThemePalette = (typeof THEME_PALETTES)[number];

/** Curated brand accent presets; a hex `#rrggbb` is also accepted and auto-derived for light and dark modes. */
export const THEME_ACCENTS = [
	'orange',
	'blue',
	'emerald',
	'violet',
	'rose',
	'amber',
	'teal',
	'indigo',
	'slate'
] as const;
/** Named brand accent preset. */
export type ThemeAccentPreset = (typeof THEME_ACCENTS)[number];
/** Brand accent preset name or 6-digit `#rrggbb` hex colour. */
export type ThemeAccent = ThemeAccentPreset | `#${string}`;

/** Workspace corner geometry preset: `sharp` (4px controls), `default` (6px controls), `soft` (8px controls). */
export const THEME_RADII = ['sharp', 'default', 'soft'] as const;
/** Named workspace corner radius preset (`'sharp'`, `'default'`, or `'soft'`). */
export type ThemeRadius = (typeof THEME_RADII)[number];

/** A partial theme: omitted variables keep Bolt's defaults. Values are CSS colours, font stacks or a radius length. */
export type ThemeTokens = Partial<Record<(typeof THEME_TOKENS)[number], string>>;

/**
 * Workspace-wide visual theme compiled into static CSS (zero runtime flash, automatic light/dark contrast).
 * High-level knobs (`palette`, `accent`, `radius`) restyle every surface and component in one declaration;
 * `light` and `dark` token overrides layer cleanly on top when finer control is needed.
 */
export type WorkspaceTheme = {
	palette?: ThemePalette;
	accent?: ThemeAccent;
	radius?: ThemeRadius;
	light?: ThemeTokens;
	dark?: ThemeTokens;
};

type ModeMap = { light: ThemeTokens; dark: ThemeTokens };

const PALETTE_PRESETS: Record<ThemePalette, ModeMap> = {
	warm: { light: {}, dark: {} },
	neutral: {
		light: {
			background: '#f4f5f7',
			foreground: '#181a1f',
			card: '#ffffff',
			'card-foreground': '#181a1f',
			popover: '#ffffff',
			'popover-foreground': '#181a1f',
			primary: '#181a1f',
			'primary-foreground': '#ffffff',
			secondary: '#e8eaee',
			'secondary-foreground': '#181a1f',
			muted: '#eceef2',
			'muted-foreground': '#646b78',
			accent: '#e2e5eb',
			'accent-foreground': '#181a1f',
			border: 'oklab(0.22 -0.005 -0.014 / 0.1)',
			input: 'oklab(0.22 -0.005 -0.014 / 0.14)',
			sidebar: '#fafbfc',
			'sidebar-foreground': '#181a1f',
			'sidebar-primary': '#181a1f',
			'sidebar-primary-foreground': '#ffffff',
			'sidebar-accent': '#eceef2',
			'sidebar-accent-foreground': '#181a1f',
			'sidebar-border': 'oklab(0.22 -0.005 -0.014 / 0.1)'
		},
		dark: {
			background: '#0b0d11',
			foreground: '#f1f3f7',
			card: '#12151c',
			'card-foreground': '#f1f3f7',
			popover: '#181c25',
			'popover-foreground': '#f1f3f7',
			primary: '#ffffff',
			'primary-foreground': '#0b0d11',
			secondary: '#181c25',
			'secondary-foreground': '#cfd5e2',
			muted: '#181c25',
			'muted-foreground': '#8b93a5',
			accent: '#232936',
			'accent-foreground': '#f1f3f7',
			border: '#252b37',
			input: '#2d3443',
			sidebar: '#0d1016',
			'sidebar-foreground': '#f1f3f7',
			'sidebar-primary': '#ffffff',
			'sidebar-primary-foreground': '#0b0d11',
			'sidebar-accent': '#181c25',
			'sidebar-accent-foreground': '#f1f3f7',
			'sidebar-border': '#252b37'
		}
	},
	crisp: {
		light: {
			background: '#ffffff',
			foreground: '#09090b',
			card: '#fafafa',
			'card-foreground': '#09090b',
			popover: '#ffffff',
			'popover-foreground': '#09090b',
			primary: '#09090b',
			'primary-foreground': '#ffffff',
			secondary: '#f4f4f5',
			'secondary-foreground': '#09090b',
			muted: '#f4f4f5',
			'muted-foreground': '#71717a',
			accent: '#e4e4e7',
			'accent-foreground': '#09090b',
			border: '#e4e4e7',
			input: '#d4d4d8',
			sidebar: '#fafafa',
			'sidebar-foreground': '#09090b',
			'sidebar-primary': '#09090b',
			'sidebar-primary-foreground': '#ffffff',
			'sidebar-accent': '#f4f4f5',
			'sidebar-accent-foreground': '#09090b',
			'sidebar-border': '#e4e4e7'
		},
		dark: {
			background: '#000000',
			foreground: '#fafafa',
			card: '#09090b',
			'card-foreground': '#fafafa',
			popover: '#111113',
			'popover-foreground': '#fafafa',
			primary: '#ffffff',
			'primary-foreground': '#09090b',
			secondary: '#18181b',
			'secondary-foreground': '#d4d4d8',
			muted: '#18181b',
			'muted-foreground': '#a1a1aa',
			accent: '#27272a',
			'accent-foreground': '#fafafa',
			border: '#27272a',
			input: '#3f3f46',
			sidebar: '#050507',
			'sidebar-foreground': '#fafafa',
			'sidebar-primary': '#ffffff',
			'sidebar-primary-foreground': '#09090b',
			'sidebar-accent': '#18181b',
			'sidebar-accent-foreground': '#fafafa',
			'sidebar-border': '#27272a'
		}
	}
};

const accentTokens = (
	lightBrand: string,
	lightText: string,
	lightMuted: string,
	lightFg: string,
	darkBrand: string,
	darkMuted: string,
	darkFg: string
): ModeMap => ({
	light: {
		brand: lightBrand,
		'brand-500': lightBrand,
		'brand-700': lightText,
		'brand-text': lightText,
		'brand-muted': lightMuted,
		'brand-foreground': lightFg,
		ring: lightBrand,
		'sidebar-ring': lightBrand
	},
	dark: {
		brand: darkBrand,
		'brand-500': darkBrand,
		'brand-text': darkBrand,
		'brand-muted': darkMuted,
		'brand-foreground': darkFg,
		ring: darkBrand,
		'sidebar-ring': darkBrand
	}
});

const ACCENT_PRESETS: Record<ThemeAccentPreset, ModeMap> = {
	orange: { light: {}, dark: {} },
	blue: accentTokens(
		'oklch(0.58 0.19 258)',
		'oklch(0.47 0.19 260)',
		'oklch(0.95 0.03 254)',
		'#ffffff',
		'oklch(0.71 0.16 254)',
		'oklch(0.25 0.06 258)',
		'#08090a'
	),
	emerald: accentTokens(
		'oklch(0.56 0.15 162)',
		'oklch(0.45 0.14 164)',
		'oklch(0.95 0.03 162)',
		'#ffffff',
		'oklch(0.73 0.15 162)',
		'oklch(0.24 0.05 164)',
		'#08090a'
	),
	violet: accentTokens(
		'oklch(0.56 0.21 292)',
		'oklch(0.46 0.21 292)',
		'oklch(0.95 0.03 292)',
		'#ffffff',
		'oklch(0.72 0.17 292)',
		'oklch(0.25 0.07 292)',
		'#08090a'
	),
	rose: accentTokens(
		'oklch(0.58 0.21 12)',
		'oklch(0.47 0.2 12)',
		'oklch(0.96 0.03 12)',
		'#ffffff',
		'oklch(0.72 0.18 14)',
		'oklch(0.25 0.07 12)',
		'#08090a'
	),
	amber: accentTokens(
		'oklch(0.68 0.16 74)',
		'oklch(0.51 0.15 62)',
		'oklch(0.96 0.04 86)',
		'#08090a',
		'oklch(0.8 0.16 80)',
		'oklch(0.26 0.06 72)',
		'#08090a'
	),
	teal: accentTokens(
		'oklch(0.55 0.12 186)',
		'oklch(0.45 0.11 186)',
		'oklch(0.95 0.03 184)',
		'#ffffff',
		'oklch(0.74 0.13 184)',
		'oklch(0.24 0.05 186)',
		'#08090a'
	),
	indigo: accentTokens(
		'oklch(0.54 0.21 274)',
		'oklch(0.44 0.21 274)',
		'oklch(0.95 0.03 274)',
		'#ffffff',
		'oklch(0.7 0.16 274)',
		'oklch(0.25 0.07 274)',
		'#08090a'
	),
	slate: accentTokens(
		'oklch(0.42 0.03 256)',
		'oklch(0.35 0.03 256)',
		'oklch(0.94 0.01 256)',
		'#ffffff',
		'oklch(0.78 0.03 256)',
		'oklch(0.24 0.02 256)',
		'#08090a'
	)
};

const RADIUS_PRESETS: Record<ThemeRadius, string | undefined> = {
	sharp: '0.5rem',
	default: undefined,
	soft: '1rem'
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function hexLuminance(hex: string): number {
	const channel = (offset: number) => {
		const s = parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function hexAccentTokens(hex: string): ModeMap {
	const fg = hexLuminance(hex) > 0.36 ? '#08090a' : '#ffffff';
	const darkBrand = `color-mix(in oklab, ${hex} 78%, white)`;
	return accentTokens(
		hex,
		`color-mix(in oklab, ${hex} 82%, black)`,
		`color-mix(in oklab, ${hex} 12%, white)`,
		fg,
		darkBrand,
		`color-mix(in oklab, ${hex} 24%, black)`,
		'#08090a'
	);
}

const allowed = new Set<string>(THEME_TOKENS);
const accentPresets = new Set<string>(THEME_ACCENTS);
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
const AccentSchema = Schema.String.check(
	Schema.makeFilter((text) => accentPresets.has(text) || HEX_COLOR.test(text))
);

/** The manifest boundary accepts curated presets and known tokens with one CSS value per token, never declarations or remote resources. */
export const WorkspaceThemeData = Schema.Struct({
	palette: Schema.optionalKey(Schema.Literals(THEME_PALETTES)),
	accent: Schema.optionalKey(AccentSchema),
	radius: Schema.optionalKey(Schema.Literals(THEME_RADII)),
	light: Schema.optionalKey(tokens),
	dark: Schema.optionalKey(tokens)
});

const isAccentPreset = (value: string): value is ThemeAccentPreset => accentPresets.has(value);

function resolveMode(
	theme: typeof WorkspaceThemeData.Type,
	mode: 'light' | 'dark'
): Record<string, string> {
	const out: Record<string, string> = {};
	const radius = theme.radius !== undefined ? RADIUS_PRESETS[theme.radius] : undefined;
	if (radius !== undefined) out['radius'] = radius;
	if (theme.palette !== undefined) Object.assign(out, PALETTE_PRESETS[theme.palette][mode]);
	if (theme.accent !== undefined) {
		const accent = isAccentPreset(theme.accent)
			? ACCENT_PRESETS[theme.accent][mode]
			: hexAccentTokens(theme.accent)[mode];
		Object.assign(out, accent);
	}
	const explicit = theme[mode];
	if (explicit !== undefined) Object.assign(out, explicit);
	return out;
}

/** Stable, workspace-local CSS; variables inherit into portals and respect the viewer's light/dark choice. */
export function theme_css(theme: typeof WorkspaceThemeData.Type | undefined): string {
	if (theme === undefined) return '';
	return (['light', 'dark'] as const)
		.map((mode) => {
			const values = resolveMode(theme, mode);
			const keys = Object.keys(values);
			if (keys.length === 0) return '';
			return `${mode === 'light' ? ':root:not(.dark)' : ':root.dark'}{${keys
				.sort()
				.map((name) => `--${name}:${values[name]};`)
				.join('')}}\n`;
		})
		.join('');
}
