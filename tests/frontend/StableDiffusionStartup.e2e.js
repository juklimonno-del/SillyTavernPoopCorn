import { test, expect } from '@playwright/test';

test('starts all image-generation template requests before awaiting any response', async ({ page }) => {
    await page.route('**/script.js', async route => {
        const response = await route.fetch();
        const body = (await response.text()).replace('await eventSource.emit(event_types.APP_READY);', 'await eventSource.emit(event_types.APP_READY); window.__sdStartupReady = true;');
        await route.fulfill({ response, body });
    });
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const body = await response.json();
        const settings = JSON.parse(body.settings);
        settings.firstRun = false;
        settings.extension_settings.disabledExtensions = settings.extension_settings.disabledExtensions.filter(name => name !== 'stable-diffusion');
        body.settings = JSON.stringify(settings);
        await route.fulfill({ response, json: body });
    });
    const requested = new Set();
    let releaseTemplates;
    const gate = new Promise(resolve => releaseTemplates = resolve);
    await page.route(/\/scripts\/extensions\/stable-diffusion\/(button|dropdown|settings)\.html(?:\?.*)?$/, async route => {
        requested.add(new URL(route.request().url()).pathname.split('/').pop());
        await gate;
        await route.continue();
    });
    try {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        // Holding every response proves concurrency without relying on timing.
        await expect.poll(() => [...requested].sort()).toEqual(['button.html', 'dropdown.html', 'settings.html']);
    } finally {
        releaseTemplates();
    }
    await page.waitForFunction(() => window.__sdStartupReady);
    await expect(page.locator('#sd_gen')).toHaveCount(1);
    await expect(page.locator('#sd_dropdown')).toHaveCount(1);
    await expect(page.locator('#sd_container .sd_settings')).toHaveCount(1);
    const settingsApplied = await page.evaluate(async () => {
        const { extension_settings } = await import('/scripts/extensions.js');
        return document.querySelector('#sd_source').value === extension_settings.sd.source;
    });
    expect(settingsApplied).toBe(true);
});
