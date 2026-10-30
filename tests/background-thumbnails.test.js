import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

const values = new Map();
const storage = {
    iterate: jest.fn(async callback => {
        for (const [key, value] of values) callback(value, key);
    }),
    getItem: jest.fn(async key => values.get(key) ?? null),
    setItem: jest.fn(async (key, value) => values.set(key, value)),
    removeItem: jest.fn(async key => values.delete(key)),
};
const createThumbnail = jest.fn(async () => 'data:image/png;base64,thumbnail');
const image = new Blob(['original animation']);
const thumbnail = new Blob(['thumbnail']);
const fetchMock = jest.fn();
const originalFetch = global.fetch;
global.fetch = fetchMock;
const createUrl = jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumbnail');
const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
const error = jest.spyOn(console, 'error').mockImplementation(() => {});

jest.unstable_mockModule('../public/lib.js', () => ({
    Fuse: jest.fn(),
    localforage: { createInstance: () => storage },
}));
jest.unstable_mockModule('../public/script.js', () => ({
    characters: [], chat_metadata: {}, eventSource: {}, event_types: {},
    generateQuietPrompt: jest.fn(), getCurrentChatId: jest.fn(), getRequestHeaders: jest.fn(),
    getThumbnailUrl: jest.fn(), saveMetadata: jest.fn(), saveSettingsDebounced: jest.fn(), this_chid: 0,
}));
jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ openThirdPartyExtensionMenu: jest.fn(), saveMetadataDebounced: jest.fn() }));
jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommand.js', () => ({ SlashCommand: {} }));
jest.unstable_mockModule('../public/scripts/slash-commands/SlashCommandParser.js', () => ({ SlashCommandParser: {} }));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    createThumbnail, getBase64Async: jest.fn(async () => 'data:image/gif;base64,original'),
    flashHighlight: jest.fn(), stringFormat: jest.fn(), debounce: jest.fn(), setupScrollToTop: jest.fn(),
    saveBase64AsFile: jest.fn(), getFileExtension: jest.fn(), sortIgnoreCaseAndAccents: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/constants.js', () => ({ debounce_timeout: {} }));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: jest.fn() }));
jest.unstable_mockModule('../public/scripts/popup.js', () => ({ callGenericPopup: jest.fn(), Popup: {}, POPUP_TYPE: {} }));
jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ groups: [], selected_group: null }));
jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ humanizedDateTime: jest.fn() }));
jest.unstable_mockModule('../public/scripts/chats.js', () => ({ deleteMediaFromServer: jest.fn() }));

let getThumbnailFromStorage;
beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    values.clear();
    fetchMock.mockImplementation(async url => ({ ok: true, blob: async () => url.startsWith('data:') ? thumbnail : image }));
    ({ getThumbnailFromStorage } = await import('../public/scripts/backgrounds.js'));
});

afterAll(() => {
    global.fetch = originalFetch;
    createUrl.mockRestore();
    warn.mockRestore();
    error.mockRestore();
});

describe('background thumbnail loading', () => {
    test('simultaneous requests generate and allocate only one thumbnail', async () => {
        const urls = await Promise.all(Array.from({ length: 8 }, () => getThumbnailFromStorage('scene.gif', false)));
        expect(new Set(urls)).toEqual(new Set(['blob:thumbnail']));
        expect(createThumbnail).toHaveBeenCalledTimes(1);
        expect(createUrl).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith('backgrounds/scene.gif', { cache: 'no-store' });
        expect(values.get('scene.gif')).toBe(thumbnail);
    });

    test('a full browser store does not replace a successfully generated thumbnail with a blank image', async () => {
        storage.setItem.mockRejectedValueOnce(new Error('QuotaExceededError'));
        expect(await getThumbnailFromStorage('scene.gif', false)).toBe('blob:thumbnail');
        expect(createUrl).toHaveBeenCalledWith(thumbnail);
    });

    test('an unreadable store still generates a thumbnail from the source', async () => {
        storage.getItem.mockRejectedValueOnce(new Error('storage unavailable'));
        expect(await getThumbnailFromStorage('/user/images/custom.gif', true)).toBe('blob:thumbnail');
        expect(fetchMock).toHaveBeenCalledWith('/user/images/custom.gif', { cache: 'no-store' });
        expect(createThumbnail).toHaveBeenCalledTimes(1);
    });

    test('cached thumbnails avoid source downloads and duplicate Blob URLs', async () => {
        values.set('scene.gif', thumbnail);
        expect(await getThumbnailFromStorage('scene.gif', false)).toBe('blob:thumbnail');
        expect(await getThumbnailFromStorage('scene.gif', false)).toBe('blob:thumbnail');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(createUrl).toHaveBeenCalledTimes(1);
    });

    test('a temporary fetch failure can be retried and does not allocate a fallback Blob URL', async () => {
        fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
        expect(await getThumbnailFromStorage('scene.gif', false)).toMatch(/^data:image\/png;base64,/);
        expect(createUrl).not.toHaveBeenCalled();
        expect(await getThumbnailFromStorage('scene.gif', false)).toBe('blob:thumbnail');
        expect(createThumbnail).toHaveBeenCalledTimes(1);
    });
});
