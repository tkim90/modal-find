interface VsCodeWebviewApi {
	postMessage(message: unknown): void;
	getState(): WebviewPersistedState | undefined;
	setState(state: WebviewPersistedState): void;
}

declare function acquireVsCodeApi(): VsCodeWebviewApi;

interface WebviewPersistedState {
	query?: string;
	caseSensitive?: boolean;
	wordMatch?: boolean;
	regexEnabled?: boolean;
	modalWidth?: number;
	modalHeight?: number;
	splitRatio?: number;
}

interface SearchResultPreviewLine {
	lineNumber: number;
	text: string;
	isMatch: boolean;
}

interface SerializedResult {
	id: string;
	kind: 'file' | 'line';
	relativePath: string;
	displayText: string;
	metaText: string;
	lineNumber: number;
	column: number;
	preview: SearchResultPreviewLine[];
	imageUri?: string;
}

type ExtensionMessage =
	| { type: 'focusQuery'; query?: string }
	| { type: 'searching'; query: string }
	| { type: 'idle'; metaMessage?: string; statusMessage?: string }
	| {
			type: 'results';
			query: string;
			results: SerializedResult[];
			meta: {
				indexedFileCount: number;
				searchableFileCount: number;
				skippedFileCount: number;
				durationMs: number;
			};
	  }
	| { type: 'error'; message: string }
	| { type: 'restoreDimensions'; width?: number; height?: number; splitRatio?: number };

interface HljsApi {
	highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): { value: string };
}

declare let hljs: HljsApi | undefined;
