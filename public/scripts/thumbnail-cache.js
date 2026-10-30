/**
 * Bounds a localforage store containing disposable thumbnail Blobs. Existing
 * stores need no migration: their Blob sizes are inspected before first use.
 * Operations are serialized so concurrent thumbnail loads cannot exceed limits.
 */
export class ThumbnailCache {
    constructor(storage, { maxEntries = 128, maxBytes = 16 * 1024 * 1024 } = {}) {
        this.storage = storage;
        this.maxEntries = maxEntries;
        this.maxBytes = maxBytes;
        this.entries = new Map();
        this.bytes = 0;
        this.initialized = false;
        this.pending = Promise.resolve();
    }

    run(operation) {
        const result = this.pending.then(async () => {
            if (!this.initialized) {
                this.entries.clear();
                this.bytes = 0;
                await this.storage.iterate((blob, key) => {
                    // Only this dedicated, regenerable thumbnail store is pruned.
                    const size = blob instanceof Blob ? blob.size : Infinity;
                    this.entries.set(key, size);
                    if (Number.isFinite(size)) this.bytes += size;
                });
                for (const [key, size] of this.entries) {
                    if (!Number.isFinite(size) || size > this.maxBytes) await this.evict(key);
                }
                await this.trim();
                this.initialized = true;
            }
            return operation();
        });
        // A failed storage operation must not poison the queue for later calls.
        this.pending = result.catch(() => {});
        return result;
    }

    async evict(key) {
        await this.storage.removeItem(key);
        const size = this.entries.get(key);
        if (Number.isFinite(size)) this.bytes -= size;
        this.entries.delete(key);
    }

    async trim(extraEntries = 0, extraBytes = 0) {
        while (this.entries.size && (this.entries.size + extraEntries > this.maxEntries || this.bytes + extraBytes > this.maxBytes)) {
            await this.evict(this.entries.keys().next().value);
        }
    }

    prune() {
        return this.run(() => this.trim());
    }

    get(key) {
        return this.run(async () => {
            const blob = await this.storage.getItem(key);
            if (!(blob instanceof Blob)) return null;
            // Refresh recency in memory without rewriting the Blob on each hit.
            if (this.entries.has(key)) {
                this.entries.delete(key);
                this.entries.set(key, blob.size);
            }
            return blob;
        });
    }

    set(key, blob) {
        return this.run(async () => {
            if (!(blob instanceof Blob) || blob.size > this.maxBytes) return;
            if (this.entries.has(key)) await this.evict(key);
            await this.trim(1, blob.size);
            await this.storage.setItem(key, blob);
            this.entries.set(key, blob.size);
            this.bytes += blob.size;
        });
    }

    remove(key) {
        return this.run(() => this.evict(key));
    }
}
