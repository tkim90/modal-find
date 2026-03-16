import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { SearchSettingsCache, type SettingsStore, type SearchSettings } from './searchSettingsCache';

class InMemoryStore implements SettingsStore {
	private data = new Map<string, unknown>();
	get<T>(key: string): T | undefined {
		return this.data.get(key) as T | undefined;
	}
	update(key: string, value: unknown): Promise<void> {
		this.data.set(key, value);
		return Promise.resolve();
	}
}

const DEFAULTS: SearchSettings = {
	query: '',
	caseSensitive: false,
	wordMatch: false,
	regexEnabled: false,
	filtersVisible: false,
	includePattern: '',
	excludePattern: ''
};

describe('SearchSettingsCache', () => {
	it('returns defaults when store is empty', () => {
		const cache = new SearchSettingsCache(new InMemoryStore());
		assert.deepStrictEqual(cache.get(), DEFAULTS);
	});

	it('returns a copy, not a shared reference', () => {
		const cache = new SearchSettingsCache(new InMemoryStore());
		const a = cache.get();
		const b = cache.get();
		assert.notStrictEqual(a, b);
	});

	it('updates a single field and preserves defaults for the rest', () => {
		const cache = new SearchSettingsCache(new InMemoryStore());
		cache.update({ query: 'hello' });
		assert.deepStrictEqual(cache.get(), { ...DEFAULTS, query: 'hello' });
	});

	it('preserves existing fields across sequential partial updates', () => {
		const cache = new SearchSettingsCache(new InMemoryStore());
		cache.update({ query: 'foo' });
		cache.update({ caseSensitive: true });
		cache.update({ regexEnabled: true });
		assert.deepStrictEqual(cache.get(), {
			query: 'foo',
			caseSensitive: true,
			wordMatch: false,
			regexEnabled: true,
			filtersVisible: false,
			includePattern: '',
			excludePattern: ''
		});
	});

	it('overwrites all fields at once', () => {
		const cache = new SearchSettingsCache(new InMemoryStore());
		cache.update({ query: 'first' });
		const full: SearchSettings = {
			query: 'second',
			caseSensitive: true,
			wordMatch: true,
			regexEnabled: true,
			filtersVisible: false,
			includePattern: '',
			excludePattern: ''
		};
		cache.update(full);
		assert.deepStrictEqual(cache.get(), full);
	});

	it('multiple cache instances sharing the same store see each other\'s writes', () => {
		const store = new InMemoryStore();
		const cacheA = new SearchSettingsCache(store);
		const cacheB = new SearchSettingsCache(store);
		cacheA.update({ query: 'shared' });
		assert.strictEqual(cacheB.get().query, 'shared');
	});
});
