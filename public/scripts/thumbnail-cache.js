/**
 * Bounds a localforage store containing disposable thumbnail Blobs. Existing
 * stores need no migration: their Blob sizes are inspected before the first write.
 * Writes are serialized to enforce limits; cache hits do not scan the entire store.
 */
export class ThumbnailCache {
    constructor(storage, { maxEntries = 128, maxBytes = 16 * 1024 * 1024 } = {}) {
        this.storage = storage;
        this.maxEntries = maxEntries;
        this.maxBytes = maxBytes;
        this.entries = new Map();
        this.recentReads = new Set();
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
                // Preserve hits that occurred before write-side initialization.
                for (const key of this.recentReads) {
                    if (!this.entries.has(key)) continue;
                    const size = this.entries.get(key);
                    this.entries.delete(key);
                    this.entries.set(key, size);
                }
                this.recentReads.clear();
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

    async get(key) {
        // Wait for writes already queued, but do not queue reads behind each other
        // or scan all stored Blobs merely to display one existing thumbnail.
        await this.pending;
        const blob = await this.storage.getItem(key);
        if (!(blob instanceof Blob) || blob.size > this.maxBytes) return null;
        // Refresh recency once the write-side accounting has been initialized.
        if (this.entries.has(key)) {
            this.entries.delete(key);
            this.entries.set(key, blob.size);
        } else if (!this.initialized) {
            this.recentReads.delete(key);
            this.recentReads.add(key);
            if (this.recentReads.size > this.maxEntries) {
                this.recentReads.delete(this.recentReads.values().next().value);
            }
        }
        return blob;
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
