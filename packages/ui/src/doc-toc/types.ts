export type DocTocItem = {
	title: string;
	url: string;
	depth: number;
};

export type DocTocItemInfo = {
	id: string;
	active: boolean;
	t: number;
	fallback: boolean;
	original: DocTocItem;
};

export type DocTocTrackBounds = {
	top: number;
	bottom: number;
};
