// The one tab size (owner rule): every tab strip in the realm is this compact size: a 1.75rem trigger, `px-3`, `text-xs`,
// a `size-3.5` icon, in a 2rem strip. The three types (default, underline, chips) differ in appearance only. `Tabs` and
// `TabStrip` are the only tab implementations, and both read these constants; there is no size prop.
import type { TabVariant } from './level.js';

/** Every trigger, every type: the size. */
export const TAB_TRIGGER =
	'[--hit-target:2rem] inline-flex h-7 shrink-0 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 data-[state=active]:text-foreground';
export const TAB_ICON = 'size-3.5 shrink-0';
// Track inset belongs to each variant: default tracks match every workspace control/surface at `rounded-md` (6px) with
// symmetric `p-0.5` (2px) inset around `rounded-badge` (4px) triggers (`4px + 2px = 6px` concentric, 32px total height);
// underline strips align flush with their panel edge and round the top corners of each trigger at `rounded-t-md` (6px).
export const TAB_TRACK = '';
export const TAB_LIST: Record<TabVariant, string> = {
	default: 'gap-0.5 rounded-md bg-foreground/[0.08] p-0.5',
	underline: 'gap-1 rounded-none border-b px-0 py-0',
	chips: 'gap-1.5 rounded-none bg-transparent p-0'
};
/** Each type's appearance: roundness, fill and border only. */
export const TAB_TYPE: Record<TabVariant, string> = {
	default:
		'rounded-badge data-[state=active]:bg-popover data-[state=active]:inset-ring-1 data-[state=active]:inset-ring-border dark:data-[state=active]:bg-background dark:data-[state=active]:shadow-sm dark:data-[state=active]:inset-ring-0',
	// top corners match the 6px workspace radius while the bottom edge sits flush on the active underline
	underline:
		"relative rounded-t-md rounded-b-none pb-px hover:bg-foreground/[0.04] after:absolute after:inset-x-0 after:bottom-0 after:h-px after:rounded-full after:content-[''] data-[state=active]:after:bg-foreground dark:after:h-0.5",
	chips:
		'rounded-full border border-border/70 data-[state=active]:border-foreground data-[state=active]:bg-foreground data-[state=active]:text-background'
};
/**
 * A vertical rail's additions to its type, on a wide container (`@2xl`): the same appearance stacked in a column on the
 * left, an underline on the rail's edge. A narrow container shows the rail as a horizontal strip of the same type.
 */
export const RAIL_LIST: Record<TabVariant, string> = {
	default:
		'@2xl:self-start @2xl:flex-none @2xl:w-full @2xl:p-0.5 @2xl:gap-0.5 @2xl:rounded-md',
	underline:
		'@2xl:self-stretch @2xl:flex-1 @2xl:w-full @2xl:rounded-none @2xl:border-b-0 @2xl:border-e @2xl:border-border/70 @2xl:px-0 @2xl:py-0 @2xl:gap-0.5',
	chips:
		'@2xl:self-start @2xl:flex-none @2xl:w-full @2xl:bg-transparent @2xl:rounded-none @2xl:p-0 @2xl:gap-1.5'
};
export const RAIL_TYPE: Record<TabVariant, string> = {
	default:
		'@2xl:w-full @2xl:px-2.5 hover:bg-foreground/[0.04] data-[state=active]:hover:bg-popover dark:data-[state=active]:hover:bg-background',
	underline:
		'@2xl:w-full @2xl:rounded-s-md @2xl:rounded-e-none @2xl:ps-2.5 @2xl:pe-3 data-[state=active]:bg-foreground/[0.05] @2xl:after:inset-x-auto @2xl:after:inset-y-1 @2xl:after:end-0 @2xl:after:bottom-auto @2xl:after:h-auto dark:@2xl:after:h-auto @2xl:after:w-0.5 @2xl:after:rounded-full',
	chips:
		'@2xl:w-full @2xl:px-3 border-border/70 hover:bg-foreground/[0.04] data-[state=active]:hover:bg-foreground'
};
