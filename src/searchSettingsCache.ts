export interface SearchSettings {
	query: string;
	caseSensitive: boolean;
	wordMatch: boolean;
	regexEnabled: boolean;
	filtersVisible: boolean;
	includePattern: string;
	excludePattern: string;
}

const DEFAULT_SETTINGS: SearchSettings = {
	query: '',
	caseSensitive: false,
	wordMatch: false,
	regexEnabled: false,
	filtersVisible: false,
	includePattern: '',
	excludePattern: ''
};

export interface SettingsStore {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

export class SearchSettingsCache {
	private static readonly STORAGE_KEY = 'searchSettings';

	constructor(private readonly store: SettingsStore) {}

	get(): SearchSettings {
		return this.store.get<SearchSettings>(SearchSettingsCache.STORAGE_KEY) ?? { ...DEFAULT_SETTINGS };
	}

	update(partial: Partial<SearchSettings>): void {
		void this.store.update(SearchSettingsCache.STORAGE_KEY, { ...this.get(), ...partial });
	}
}
