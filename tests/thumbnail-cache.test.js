import { describe, expect, jest, test } from '@jest/globals';
import { ThumbnailCache } from '../public/scripts/thumbnail-cache.js';

function makeStorage(initial = []) {
    const data = new Map(initial);
    return {
        data,
        async iterate(callback) {
            for (const [key, value] of data) callback(value, key);
        },
        async getItem(key) { return data.get(key) ?? null; },
        async setItem(key, value) { data.set(key, value); },
        async removeItem(key) { data.delete(key); },
    };
}

const blob = size => new Blob([new Uint8Array(size)]);
const storedBytes = storage => [...storage.data.values()].reduce((total, value) => total + value.size, 0);

describe('bounded background thumbnail cache', () => {
    test('a cold cache hit does not scan or prune unrelated persisted thumbnails', async () => {
        const storage = makeStorage(Array.from({ length: 200 }, (_, index) => [String(index), blob(100)]));
        storage.iterate = jest.fn(storage.iterate);
        const cache = new ThumbnailCache(storage);
        expect((await cache.get('199')).size).toBe(100);
        expect(storage.iterate).not.toHaveBeenCalled();
        expect(storage.data.size).toBe(200);
        // Limits are still applied before storing new disposable data.
        await cache.set('new', blob(100));
        expect(storage.data.size).toBe(128);
        expect(storage.data.has('199')).toBe(true);
    });

    test('cache hits issue concurrent reads instead of waiting for previous reads', async () => {
        const storage = makeStorage();
        const releases = [];
        storage.getItem = jest.fn(() => new Promise(resolve => releases.push(resolve)));
        storage.iterate = jest.fn(storage.iterate);
        const cache = new ThumbnailCache(storage);
        const reads = Array.from({ length: 20 }, (_, index) => cache.get(String(index)));
        await Promise.resolve();
        expect(storage.getItem).toHaveBeenCalledTimes(20);
        expect(storage.iterate).not.toHaveBeenCalled();
        for (const release of releases) release(blob(3));
        expect(await Promise.all(reads)).toHaveLength(20);
    });

    test('prunes an existing unbounded store before use without changing surviving Blobs', async () => {
        const storage = makeStorage(Array.from({ length: 200 }, (_, index) => [String(index), blob(100)]));
        const survivor = storage.data.get('199');
        const cache = new ThumbnailCache(storage);
        await cache.prune();
        expect(storage.data.size).toBe(128);
        expect(storage.data.get('199')).toBe(survivor);
    });

    test('enforces both byte and entry limits during simultaneous inserts', async () => {
        const storage = makeStorage();
        const cache = new ThumbnailCache(storage, { maxEntries: 3, maxBytes: 10 });
        await Promise.all(Array.from({ length: 30 }, (_, index) => cache.set(String(index), blob(4))));
        expect(storage.data.size).toBe(2);
        expect(storedBytes(storage)).toBe(8);
        expect([...storage.data.keys()]).toEqual(['28', '29']);
    });

    test('refreshes recency without rewriting cached thumbnail data', async () => {
        const first = blob(3);
        const storage = makeStorage([['first', first], ['second', blob(3)]]);
        const cache = new ThumbnailCache(storage, { maxEntries: 2 });
        expect(await cache.get('first')).toBe(first);
        await cache.set('third', blob(3));
        expect([...storage.data.keys()]).toEqual(['first', 'third']);
    });

    test('removes oversized or invalid legacy entries and continues serving valid entries', async () => {
        const storage = makeStorage([['huge', blob(40)], ['bad', 'not a thumbnail'], ['valid', blob(3)]]);
        const cache = new ThumbnailCache(storage, { maxBytes: 10 });
        await cache.prune();
        expect([...storage.data.keys()]).toEqual(['valid']);
        expect((await cache.get('valid')).size).toBe(3);
    });

    test('does not evict useful thumbnails for a new item larger than the entire budget', async () => {
        const storage = makeStorage([['valid', blob(3)]]);
        const cache = new ThumbnailCache(storage, { maxBytes: 10 });
        await cache.set('huge', blob(11));
        expect([...storage.data.keys()]).toEqual(['valid']);
    });

    test('replacing and removing thumbnails keeps byte accounting correct', async () => {
        const storage = makeStorage();
        const cache = new ThumbnailCache(storage, { maxBytes: 10 });
        await cache.set('same', blob(8));
        await cache.set('same', blob(3));
        await cache.set('other', blob(6));
        expect(storedBytes(storage)).toBe(9);
        await cache.remove('same');
        await cache.remove('absent');
        await cache.set('third', blob(4));
        expect(storedBytes(storage)).toBe(10);
        expect([...storage.data.keys()]).toEqual(['other', 'third']);
    });

    test('a failed write does not poison later operations or miscount stored bytes', async () => {
        const storage = makeStorage();
        const setItem = storage.setItem;
        storage.setItem = async () => { throw new Error('QuotaExceededError'); };
        const cache = new ThumbnailCache(storage, { maxBytes: 10 });
        await expect(cache.set('failed', blob(8))).rejects.toThrow('QuotaExceededError');
        storage.setItem = setItem;
        await cache.set('valid', blob(8));
        expect(storedBytes(storage)).toBe(8);
        expect(await cache.get('failed')).toBeNull();
    });

    test('a temporary read failure does not stop later cache access', async () => {
        const storage = makeStorage([['valid', blob(3)]]);
        const getItem = storage.getItem;
        storage.getItem = async () => { throw new Error('storage unavailable'); };
        const cache = new ThumbnailCache(storage);
        await expect(cache.get('valid')).rejects.toThrow('storage unavailable');
        storage.getItem = getItem;
        expect((await cache.get('valid')).size).toBe(3);
    });
});
