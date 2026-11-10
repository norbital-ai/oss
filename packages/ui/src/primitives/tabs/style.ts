// The one tab size (owner rule): every tab strip in the realm is this compact size: a 1.75rem trigger, `px-3`, `text-xs`,
// a `size-3.5` icon, in a 2rem strip. The three types (segmented, underline, chips) differ in appearance only. `Tabs` and
// `TabStrip` are the only tab implementations, and both read these constants; there is no size prop.
import type { TabVariant } from './level.js';

/** Every trigger, every type: the size. */
export const TAB_TRIGGER =
	'[--hit-target:2rem] inline-flex h-7 shrink-0 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 data-[state=active]:text-foreground';
export const TAB_ICON = 'size-3.5 shrink-0';
// The track tint follows the surface, including when a sheet uses the same token as the muted background.
// Let the track extend past the content edge, so its first trigger aligns with the panel rather than the track.
export const TAB_TRACK =
	'-ms-0.5 rounded-[calc(var(--radius-md)+0.125rem)] bg-foreground/[0.08] px-0.5';
export const TAB_LIST: Record<TabVariant, string> = {
	segmented: 'gap-0.5 py-0.5',
	underline: 'gap-0.5 border-b pt-0.5 pb-px',
	chips: 'gap-0.5 py-0.5'
};
/** Each type's appearance: roundness, fill and border only. */
export const TAB_TYPE: Record<TabVariant, string> = {
	segmented:
		'rounded-md data-[state=active]:bg-popover data-[state=active]:inset-ring-1 data-[state=active]:inset-ring-border dark:data-[state=active]:bg-background dark:data-[state=active]:shadow-sm dark:data-[state=active]:inset-ring-0',
	// the bar spans the whole trigger, as wide as a segmented tab's fill
	underline:
		"relative after:absolute after:inset-x-0 after:-bottom-0.5 after:h-px after:rounded-full after:content-[''] data-[state=active]:after:bg-foreground dark:after:h-0.5",
	chips:
		'rounded-full border data-[state=active]:border-foreground data-[state=active]:bg-foreground data-[state=active]:text-background'
};
