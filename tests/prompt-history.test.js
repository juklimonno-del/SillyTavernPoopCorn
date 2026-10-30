import { describe, expect, jest, test } from '@jest/globals';
import { PromptHistoryStore, PROMPT_HISTORY_LIMIT } from '../public/scripts/prompt-history.js';

function makeStorage(entries = []) {
    const data = new Map(entries);
    return {
        data,
        getItem: jest.fn(async key => structuredClone(data.get(key) ?? null)),
        setItem: jest.fn(async (key, value) => data.set(key, structuredClone(value))),
        removeItem: jest.fn(async key => data.delete(key)),
        clear: jest.fn(async () => data.clear()),
        keys: jest.fn(async () => [...data.keys()]),
    };
}

const snapshots = count => Array.from({ length: count }, (_, mesId) => ({ mesId, rawPrompt: `Prompt ${mesId}` }));

describe('bounded diagnostic prompt history', () => {
    test('prunes existing histories without opening chats, retaining complete newest snapshots', async () => {
        const storage = makeStorage([['long', snapshots(500)], ['short', snapshots(3)]]);
        await new PromptHistoryStore(storage).pruneAll();
        expect(storage.data.get('long')).toEqual(snapshots(500).slice(-PROMPT_HISTORY_LIMIT));
        expect(storage.data.get('short')).toEqual(snapshots(3));
        expect(storage.setItem).toHaveBeenCalledTimes(1);
    });

    test('bounds saves and captures their arrays independently', async () => {
        const storage = makeStorage();
        const store = new PromptHistoryStore(storage);
        const values = snapshots(90);
        const saved = store.save('chat', values);
        values.length = 0;
        await saved;
        expect(storage.data.get('chat')).toEqual(snapshots(90).slice(-50));
    });

    test('a new save wins over an in-progress migration', async () => {
        const storage = makeStorage([['chat', snapshots(100)]]);
        const store = new PromptHistoryStore(storage);
        const migration = store.pruneAll();
        await store.save('chat', [{ mesId: 101, rawPrompt: 'Newest' }]);
        await migration;
        expect(storage.data.get('chat')).toEqual([{ mesId: 101, rawPrompt: 'Newest' }]);
    });

    test('migration does not resurrect deleted histories', async () => {
        const storage = makeStorage([['chat', snapshots(100)]]);
        const store = new PromptHistoryStore(storage);
        const migration = store.pruneAll();
        await store.remove('chat');
        await migration;
        expect(storage.data.has('chat')).toBe(false);
    });

    test('storage failures do not poison later writes', async () => {
        const storage = makeStorage();
        const store = new PromptHistoryStore(storage);
        storage.setItem.mockRejectedValueOnce(new Error('quota exceeded'));
        await expect(store.save('chat', snapshots(1))).rejects.toThrow('quota exceeded');
        await store.save('chat', snapshots(2));
        expect(await store.load('chat')).toEqual(snapshots(2));
    });

    test('missing or malformed history is safe to load', async () => {
        const storage = makeStorage([['broken', {}]]);
        const store = new PromptHistoryStore(storage);
        expect(await store.load('missing')).toEqual([]);
        expect(await store.load('broken')).toEqual([]);
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    test('a pruning write failure preserves readable snapshots and leaves migration retryable', async () => {
        const storage = makeStorage([['chat', snapshots(100)]]);
        const store = new PromptHistoryStore(storage);
        storage.setItem.mockRejectedValueOnce(new Error('quota exceeded'));
        expect(await store.load('chat')).toEqual(snapshots(100).slice(-50));
        storage.setItem.mockRejectedValueOnce(new Error('quota exceeded'));
        await expect(store.pruneAll()).rejects.toThrow('quota exceeded');
        await store.pruneAll();
        expect(storage.data.get('chat')).toHaveLength(50);
    });
});

// Exercise the real integration while isolating unrelated UI modules.
jest.unstable_mockModule('../public/lib.js', () => ({
    DiffMatchPatch: {}, DOMPurify: {}, localforage: { createInstance: () => makeStorage() },
}));
jest.unstable_mockModule('../public/script.js', () => ({
    chat: [], event_types: {}, eventSource: { emit: jest.fn() },
    getCurrentChatId: jest.fn(), reloadCurrentChat: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: jest.fn() }));
jest.unstable_mockModule('../public/scripts/openai.js', () => ({ oai_settings: {} }));
jest.unstable_mockModule('../public/scripts/popup.js', () => ({ Popup: {}, POPUP_TYPE: {} }));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: {}, registerDebugFunction: jest.fn() }));
jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ isMobile: jest.fn() }));
jest.unstable_mockModule('../public/scripts/templates.js', () => ({ renderTemplateAsync: jest.fn() }));
jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({ getFriendlyTokenizerName: jest.fn(), getTokenCountAsync: jest.fn() }));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({ copyText: jest.fn() }));

test('generation retains 50 snapshots in memory and refreshes regenerated older messages', async () => {
    const prompts = await import('../public/scripts/itemized-prompts.js');
    await prompts.clearItemizedPrompts();
    for (const snapshot of snapshots(100)) prompts.addItemizedPrompt(snapshot);
    expect(prompts.itemizedPrompts.map(x => x.mesId)).toEqual(snapshots(100).slice(-50).map(x => x.mesId));
    prompts.addItemizedPrompt({ mesId: 50, rawPrompt: 'Regenerated' });
    prompts.swapItemizedPrompts(50, 49);
    prompts.addItemizedPrompt({ mesId: 100, rawPrompt: 'New' });
    expect(prompts.itemizedPrompts).toHaveLength(50);
    expect(prompts.itemizedPrompts.find(x => x.mesId === 49).rawPrompt).toBe('Regenerated');
    expect(prompts.itemizedPrompts.find(x => x.mesId === 51)).toBeUndefined();
});
