// The native-control look shared by kinds that render a plain `<select>` or a bare box (the Input primitive's recipe).
export const CONTROL =
	'h-9 w-full min-w-0 rounded-sm border border-input bg-background px-3 text-base font-medium shadow-xs outline-none transition-[color,box-shadow] md:text-sm focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset aria-invalid:border-destructive disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-50 dark:bg-input/30';
// A segmented date/time field (bits' DateField, TimeField and their range forms): the box, and one typed segment.
export const SEGMENTS = `${CONTROL} flex items-center gap-0 tabular-nums`;
export const SEGMENT = 'rounded-sm px-0.5 outline-none focus:bg-accent focus:text-accent-foreground aria-[valuetext=Empty]:text-muted-foreground data-[segment=literal]:px-0 data-[segment=literal]:text-muted-foreground';
