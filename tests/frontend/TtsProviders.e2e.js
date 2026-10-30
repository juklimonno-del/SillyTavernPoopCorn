import { test, expect } from '@playwright/test';

async function prepareTtsApp(page) {
    await page.route('**/script.js', async route => {
        const response = await route.fetch();
        const body = (await response.text()).replace('await eventSource.emit(event_types.APP_READY);', 'await eventSource.emit(event_types.APP_READY); window.__ttsTestReady = true;');
        await route.fulfill({ response, body });
    });
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const body = await response.json();
        const settings = JSON.parse(body.settings);
        settings.firstRun = false;
        settings.extension_settings.tts = { enabled: false, currentProvider: 'ElevenLabs' };
        body.settings = JSON.stringify(settings);
        await route.fulfill({ response, json: body });
    });
    // Keep this test local and avoid persisting its synthetic settings.
    await page.route('**/api/settings/save', route => route.fulfill({ json: {} }));
    await page.route('**/api/speech/elevenlabs/voices', route => route.fulfill({ json: { voices: [] } }));
}

test('boot imports only the selected TTS provider and switching preserves provider settings', async ({ page }) => {
    await prepareTtsApp(page);
    const providerRequests = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
        const match = new URL(request.url()).pathname.match(/^\/scripts\/extensions\/tts\/([^/]+\.js)$/);
        if (match && !['index.js', 'provider-registry.js'].includes(match[1])) providerRequests.push(match[1]);
    });
    await page.goto('/');
    await page.waitForFunction(() => window.__ttsTestReady);
    await expect(page.locator('#elevenlabs_tts_stability')).toHaveCount(1);
    expect(providerRequests).toEqual(['elevenlabs.js']);

    await page.evaluate(() => $('#tts_provider').val('System').trigger('change'));
    await expect(page.locator('#system_tts_rate')).toHaveCount(1);
    await page.evaluate(() => $('#system_tts_rate').val('1.35').trigger('input'));
    expect(await page.evaluate(async () => {
        const { extension_settings } = await import('/scripts/extensions.js');
        return extension_settings.tts.System.rate;
    })).toBe(1.35);

    await page.evaluate(() => $('#tts_provider').val('ElevenLabs').trigger('change'));
    await expect(page.locator('#elevenlabs_tts_stability')).toHaveCount(1);
    await page.evaluate(() => $('#elevenlabs_tts_stability').val('0.2').trigger('input'));
    expect(await page.evaluate(async () => {
        const { extension_settings } = await import('/scripts/extensions.js');
        return Number(extension_settings.tts.ElevenLabs.stability);
    })).toBe(0.2);
    expect(providerRequests).toEqual(['elevenlabs.js', 'system.js']);
    expect(errors).toEqual([]);
});

test('provider controls are safe while its module is still downloading', async ({ page }) => {
    await prepareTtsApp(page);
    let releaseImport;
    const delayedImport = new Promise(resolve => { releaseImport = resolve; });
    await page.route('**/scripts/extensions/tts/elevenlabs.js', async route => {
        await delayedImport;
        await route.continue();
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await page.waitForFunction(() => window.__ttsTestReady);
    try {
        const savedProviderBeforeImport = await page.evaluate(async () => {
            const { saveTtsProviderSettings } = await import('/scripts/extensions/tts/index.js');
            const { extension_settings } = await import('/scripts/extensions.js');
            $('#tts_voices').trigger('click');
            $('#tts_refresh').trigger('click');
            window.tts_preview('pending-voice');
            saveTtsProviderSettings();
            return extension_settings.tts.currentProvider;
        });
        expect(savedProviderBeforeImport).toBe('ElevenLabs');
        await expect(page.locator('#tts_provider_settings')).toBeEmpty();
    } finally {
        releaseImport();
    }
    await expect(page.locator('#elevenlabs_tts_stability')).toHaveCount(1);
    expect(errors).toEqual([]);
});
