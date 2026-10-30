import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { TokenCountCache } from '../public/scripts/token-count-cache.js';

describe('bounded token count cache', () => {
    test('evicts cold counts while retaining recently used counts', () => {
        const cache = new TokenCountCache(2, 2);
        const counts = cache.getChat('chat');
        counts.set('a', 1).set('b', 2);
        expect(counts.get('a')).toBe(1);
        counts.set('c', 3);
        expect(counts.get('b')).toBeUndefined();
        expect(counts.get('a')).toBe(1);
        expect(counts.get('c')).toBe(3);
    });

    test('bounds chats and preserves the most recently used chat', () => {
        const cache = new TokenCountCache(2, 2);
        cache.getChat('a').set('count', 1);
        cache.getChat('b').set('count', 2);
        cache.getChat('a');
        cache.getChat('c').set('count', 3);
        expect(cache.toJSON()).toEqual({ a: { count: 1 }, c: { count: 3 } });
    });

    test('trims legacy IndexedDB content and round-trips the compatible format', () => {
        const cache = new TokenCountCache(2, 2);
        cache.load({ a: { x: 1 }, b: { x: 2 }, c: { x: 3, y: 4, z: 5 } });
        expect(cache.toJSON()).toEqual({ b: { x: 2 }, c: { y: 4, z: 5 } });
        const reloaded = new TokenCountCache(2, 2);
        reloaded.load(JSON.parse(JSON.stringify(cache)));
        expect(reloaded.getChat('c').get('z')).toBe(5);
    });

    test('ignores malformed data and non-finite counts', () => {
        const cache = new TokenCountCache();
        cache.load({ missing: null, array: [], chat: { valid: 0, invalid: '5', nan: NaN } });
        expect(cache.toJSON()).toEqual({ chat: { valid: 0 } });
        cache.load(null);
        expect(cache.toJSON()).toEqual({});
    });

    test('handles chat names that coincide with object prototype names', () => {
        const cache = new TokenCountCache();
        cache.getChat('__proto__').set('constructor', 7);
        const reloaded = new TokenCountCache();
        reloaded.load(JSON.parse(JSON.stringify(cache)));
        expect(reloaded.getChat('__proto__').get('constructor')).toBe(7);
    });

    test('late writes to an evicted chat do not grow the retained cache', () => {
        const cache = new TokenCountCache(1, 2);
        const pendingChat = cache.getChat('old');
        cache.getChat('current').set('count', 5);
        pendingChat.set('lateResult', 99);
        expect(cache.toJSON()).toEqual({ current: { count: 5 } });
    });

    test('reuses unchanged chat snapshots while keeping pending saves isolated', () => {
        const cache = new TokenCountCache(2, 2);
        cache.getChat('cold').set('count', 1);
        cache.getChat('active').set('count', 2);
        const pendingSave = cache.toJSON();
        cache.getChat('active').set('count', 3);
        const nextSave = cache.toJSON();
        expect(nextSave.cold).toBe(pendingSave.cold);
        expect(nextSave.active).not.toBe(pendingSave.active);
        expect(pendingSave.active.count).toBe(2);
        expect(nextSave.active.count).toBe(3);
    });

    test('repeated selected-chat lookups and identical values do not dirty saves', () => {
        const cache = new TokenCountCache(2, 2);
        const counts = cache.getChat('chat').set('count', 1);
        const version = cache.version;
        for (let i = 0; i < 100; i++) {
            expect(cache.getChat('chat')).toBe(counts);
            expect(counts.get('count')).toBe(1);
            counts.set('count', 1);
        }
        expect(cache.version).toBe(version);
        cache.clear();
        expect(cache.getChat('chat')).not.toBe(counts);
        expect(cache.getChat('chat').get('count')).toBeUndefined();
    });
});

const store = {
    getItem: jest.fn().mockResolvedValue({}),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
};
const registerDebugFunction = jest.fn();
jest.unstable_mockModule('../public/lib.js', () => ({ localforage: { createInstance: () => store } }));
jest.unstable_mockModule('../public/script.js', () => ({
    characters: [{ chat: 'test-chat' }], event_types: {}, eventSource: { on: jest.fn() },
    main_api: 'kobold', nai_settings: {}, online_status: '', this_chid: 0,
}));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: { tokenizer: 0 }, registerDebugFunction,
}));
jest.unstable_mockModule('../public/scripts/openai.js', () => ({ chat_completion_sources: {}, model_list: [], oai_settings: {} }));
jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ groups: [], selected_group: null }));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({ getStringHash: str => str }));
jest.unstable_mockModule('../public/scripts/kai-settings.js', () => ({ kai_flags: {}, kai_settings: {} }));
jest.unstable_mockModule('../public/scripts/textgen-settings.js', () => ({
    textgen_types: {}, textgenerationwebui_settings: {}, getTextGenServer: jest.fn(), getTextGenModel: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/textgen-models.js', () => ({
    getCurrentDreamGenModelTokenizer: jest.fn(), getCurrentOpenRouterModelTokenizer: jest.fn(), openRouterModels: [],
}));
const { initTokenizers, getTokenCountAsync, saveTokenCache } = await import('../public/scripts/tokenizers.js');

describe('tokenizer cache persistence', () => {
    beforeEach(async () => {
        store.getItem.mockResolvedValue({});
        store.setItem.mockReset().mockResolvedValue(undefined);
        store.removeItem.mockReset().mockResolvedValue(undefined);
        registerDebugFunction.mockClear();
        await initTokenizers();
    });

    test('repeated chat saves do not rewrite unchanged counts', async () => {
        const firstCount = await getTokenCountAsync('hello');
        await saveTokenCache();
        expect(await getTokenCountAsync('hello')).toBe(firstCount);
        await Promise.all([saveTokenCache(), saveTokenCache()]);
        expect(store.setItem).toHaveBeenCalledTimes(1);
        expect(store.setItem.mock.calls[0][1]['test-chat']).toBeDefined();
    });

    test('serializes overlapping writes without losing counts added during a write', async () => {
        let finishFirstWrite;
        store.setItem.mockImplementationOnce(() => new Promise(resolve => { finishFirstWrite = resolve; }));
        await getTokenCountAsync('first');
        const firstSave = saveTokenCache();
        await Promise.resolve();
        await getTokenCountAsync('second');
        const secondSave = saveTokenCache();
        expect(store.setItem).toHaveBeenCalledTimes(1);
        finishFirstWrite();
        await Promise.all([firstSave, secondSave]);
        expect(store.setItem).toHaveBeenCalledTimes(2);
        expect(Object.keys(store.setItem.mock.calls[1][1]['test-chat'])).toHaveLength(2);
    });

    test('retries after a failed IndexedDB write', async () => {
        store.setItem.mockRejectedValueOnce(new Error('quota'));
        await getTokenCountAsync('hello');
        await saveTokenCache();
        await saveTokenCache();
        expect(store.setItem).toHaveBeenCalledTimes(2);
    });

    test('reset waits for older writes and does not persist their stale data again', async () => {
        global.toastr = { success: jest.fn() };
        let finishWrite;
        store.setItem.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
        await getTokenCountAsync('old');
        const save = saveTokenCache();
        await Promise.resolve();
        const reset = registerDebugFunction.mock.calls[0][3]();
        expect(store.removeItem).not.toHaveBeenCalled();
        finishWrite();
        await Promise.all([save, reset]);
        await saveTokenCache();
        expect(store.removeItem).toHaveBeenCalledWith('tokenCache');
        expect(store.setItem.mock.calls[1][1]).toEqual({});
        delete global.toastr;
    });
});
