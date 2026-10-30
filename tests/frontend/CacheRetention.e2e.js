import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test('boots without scanning unused histories and applies bounds on demand', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
        if (message.type() === 'warning' || message.type() === 'error') console.log(message.text());
    });
    await page.route('**/script.js', async route => {
        const response = await route.fetch();
        const body = (await response.text()).replace('await eventSource.emit(event_types.APP_READY);', 'await eventSource.emit(event_types.APP_READY); globalThis.__cacheTestReady = true;');
        await route.fulfill({ response, body });
    });
    // The fresh test server's onboarding would pause application initialization.
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const body = await response.json();
        const settings = JSON.parse(body.settings);
        settings.firstRun = false;
        body.settings = JSON.stringify(settings);
        await route.fulfill({ response, json: body });
    });
    await testSetup.awaitST({ page });
    await page.waitForFunction(() => window.__cacheTestReady);
    await page.evaluate(async () => {
        const { localforage } = await import('/lib.js');
        const prompts = localforage.createInstance({ name: 'SillyTavern_Prompts' });
        await prompts.setItem('synthetic-chat', Array.from({ length: 120 }, (_, mesId) => ({ mesId, rawPrompt: 'Test context '.repeat(1000) })));
        const thumbnails = localforage.createInstance({ name: 'SillyTavern_Thumbnails' });
        for (let i = 0; i < 160; i++) {
            await thumbnails.setItem(`synthetic-${i}`, new Blob([new Uint8Array(1024)], { type: 'image/png' }));
        }
        const tokens = localforage.createInstance({ name: 'SillyTavern_ChatCompletions' });
        const counts = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`count-${i}`, i]));
        await tokens.setItem('tokenCache', Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`chat-${i}`, counts])));
        localStorage.removeItem('SillyTavern_PromptHistory_50_v1');
    });

    await testSetup.awaitST({ page });
    await page.waitForFunction(() => window.__cacheTestReady);
    const result = await page.evaluate(async () => {
        const { localforage } = await import('/lib.js');
        const { loadItemizedPrompts, saveItemizedPrompts, addItemizedPrompt } = await import('/scripts/itemized-prompts.js');
        const { ThumbnailCache } = await import('/scripts/thumbnail-cache.js');
        const { saveTokenCache } = await import('/scripts/tokenizers.js');
        await saveTokenCache();
        const promptStore = localforage.createInstance({ name: 'SillyTavern_Prompts' });
        const unopenedPrompts = (await promptStore.getItem('synthetic-chat')).length;
        const thumbnails = localforage.createInstance({ name: 'SillyTavern_Thumbnails' });
        const untouchedThumbnails = await thumbnails.length();
        await loadItemizedPrompts('synthetic-chat');
        const prompts = await promptStore.getItem('synthetic-chat');
        await new ThumbnailCache(thumbnails).set('new-thumbnail', new Blob(['thumbnail'], { type: 'image/png' }));

        // Count real IndexedDB writes during ordinary unchanged chat saves.
        let promptWrites = 0;
        const originalPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
            if (this.transaction.db.name === 'SillyTavern_Prompts') promptWrites++;
            return originalPut.apply(this, args);
        };
        try {
            addItemizedPrompt({ mesId: 120, rawPrompt: 'New snapshot' });
            for (let i = 0; i < 100; i++) await saveItemizedPrompts('synthetic-chat', { onlyIfChanged: true });
        } finally {
            IDBObjectStore.prototype.put = originalPut;
        }
        const tokens = await localforage.createInstance({ name: 'SillyTavern_ChatCompletions' }).getItem('tokenCache');
        let thumbnailBytes = 0;
        await thumbnails.iterate(blob => { thumbnailBytes += blob.size; });
        return {
            unopenedPrompts, untouchedThumbnails, promptWrites,
            promptCount: prompts.length, firstPrompt: prompts[0].mesId,
            thumbnailCount: await thumbnails.length(), thumbnailBytes,
            tokenChats: Object.keys(tokens).length,
            largestTokenChat: Math.max(...Object.values(tokens).map(chat => Object.keys(chat).length)),
        };
    });
    expect(result.unopenedPrompts).toBe(120);
    expect(result.untouchedThumbnails).toBe(160);
    expect(result.promptWrites).toBe(1);
    expect(result.promptCount).toBe(50);
    expect(result.firstPrompt).toBe(70);
    expect(result.thumbnailCount).toBeLessThanOrEqual(128);
    expect(result.thumbnailBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(result.tokenChats).toBeLessThanOrEqual(16);
    expect(result.largestTokenChat).toBeLessThanOrEqual(4096);
    expect(errors).toEqual([]);
});
