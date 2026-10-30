// The one tab size (owner rule): every tab strip in the realm is this compact size: a 1.75rem trigger, `px-3`, `text-xs`,
// a `size-3.5` icon, in a 2rem strip. The three types (segmented, underline, chips) differ in appearance only. `Tabs` and
// `TabStrip` are the only tab implementations, and both read these constants; there is no size prop.
import type { TabVariant } from './level.js';

/** Every trigger, every type: the size. */
export const TAB_TRIGGER =
	'[--hit-target:2rem] inline-flex h-7 shrink-0 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 data-[state=active]:text-foreground';
export const TAB_ICON = 'size-3.5 shrink-0';
// every strip is 2rem tall: a 0.125rem inset around the 1.75rem triggers (the underline's border takes one pixel of it)
export const TAB_LIST: Record<TabVariant, string> = {
	segmented: 'gap-0.5 rounded-lg bg-muted p-0.5',
	underline: 'gap-0.5 border-b px-0.5 pt-0.5 pb-px',
	chips: 'gap-0.5 p-0.5'
};
/** Each type's appearance: roundness, fill and border only. */
export const TAB_TYPE: Record<TabVariant, string> = {
	segmented: 'rounded-md data-[state=active]:bg-background data-[state=active]:shadow-sm',
	// the bar spans the whole trigger, as wide as a segmented tab's fill
	underline:
		"relative after:absolute after:inset-x-0 after:-bottom-0.5 after:h-0.5 after:rounded-full after:content-[''] data-[state=active]:after:bg-foreground",
	chips:
		'rounded-full border data-[state=active]:border-foreground data-[state=active]:bg-foreground data-[state=active]:text-background'
};
