import { cn } from '../primitives/utils.js';
// The one control size (owner rule): every form and toolbar control — an input, a select, a date field, a textarea's
// first line, a button beside them — is the tab strip's compact size: a 2rem box, `px-2.5`, `text-xs`, a `size-3.5`
// icon, and a 2rem touch target. There is no size prop; a caller sets width only.
export const CONTROL_SIZE = '[--hit-target:2rem] h-8 min-w-0 gap-1.5 px-2.5 text-xs';
export const CONTROL_ICON = 'size-3.5 shrink-0 text-muted-foreground';
// The native-control look shared by field triggers (Combobox) and a bare box (the Input primitive's recipe).
export const CONTROL = `${CONTROL_SIZE} w-full rounded-sm border border-input bg-background font-medium shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset aria-invalid:border-destructive disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-50 dark:bg-input/30`;
// The field look of a select trigger (Combobox, a place picker): CONTROL's box.
export const SELECT_TRIGGER = `${CONTROL_SIZE} flex w-full items-center justify-between rounded-sm border border-input bg-background text-left font-normal shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset aria-invalid:border-destructive disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-50 dark:bg-input/30`;
// A segmented date/time field (bits' DateField, TimeField and their range forms): the box, and one typed segment.
export const SEGMENTS = cn(CONTROL, 'flex items-center gap-0 tabular-nums');
export const SEGMENT =
	'rounded-sm px-0.5 outline-none focus:bg-accent focus:text-accent-foreground aria-[valuetext=Empty]:text-muted-foreground data-[segment=literal]:px-0 data-[segment=literal]:text-muted-foreground';
