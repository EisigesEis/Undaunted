import crypto from "crypto";
import { logger } from "../logger";

// TODO: Complete buffer should only be used with small user size
// Later on consider bucketing auth keys by hashed tokens in db
// loading only buckets into memory and caching more db objects
// (not only auth) of heartbeating users
const HashBytes = 32;
const DummyHash = Buffer.alloc(HashBytes);

type KeyRecord<T> = {
    keyHash: string | null | undefined,
    value: T
}

type CacheEntry<T> = {
    keyHashBuffer: Buffer,
    value: T
}

export function HashAPIKey(APIKeyToHash: string){
    return HashAPIKeyBuffer(APIKeyToHash).toString("hex");
}

function HashAPIKeyBuffer(APIKeyToHash: string){
    return crypto.createHash("sha256").update(APIKeyToHash, "utf8").digest();
}

function hashBufferFromHex(CacheName: string, KeyHash: string){
    const KeyHashBuffer = Buffer.from(KeyHash, "hex");

    if(KeyHashBuffer.length !== HashBytes){
        logger.warn(`Ignoring invalid ${CacheName} API Key hash with ${KeyHashBuffer.length} bytes`);
        return undefined;
    }

    return KeyHashBuffer;
}

export function CreateAPIKeyCache<T>(
    CacheName: string,
    LoadRecords: () => Promise<KeyRecord<T>[]>
){
    let cache: Map<string, CacheEntry<T>> | undefined = undefined;
    let load: Promise<Map<string, CacheEntry<T>>> | undefined = undefined;
    let refreshLoad: Promise<Map<string, CacheEntry<T>>> | undefined = undefined;

    async function loadFresh(){
        const Records = await LoadRecords();
        const FreshCache = new Map<string, CacheEntry<T>>();

        for(const Record of Records){
            if(Record.keyHash === null || Record.keyHash === undefined){
                continue;
            }

            const KeyHashBuffer = hashBufferFromHex(CacheName, Record.keyHash);

            if(KeyHashBuffer !== undefined){
                FreshCache.set(Record.keyHash.toLowerCase(), {
                    keyHashBuffer: KeyHashBuffer,
                    value: Record.value
                });
            }
        }

        return FreshCache;
    }

    async function loadIntoCache(){
        const FreshCache = await loadFresh();
        cache = FreshCache;
        return FreshCache;
    }

    async function loadCache(){
        if(load !== undefined){
            return await load;
        }

        load = loadIntoCache();

        try{
            return await load;
        }
        finally{
            load = undefined;
        }
    }

    async function refreshCache(){
        if(refreshLoad !== undefined){
            return await refreshLoad;
        }

        refreshLoad = (async () => {
            if(load !== undefined){
                try{
                    await load;
                }
                catch{
                    // Ignore stale lazy-load errors; the refresh below is authoritative.
                }
            }

            return await loadIntoCache();
        })();

        try{
            return await refreshLoad;
        }
        finally{
            refreshLoad = undefined;
        }
    }

    async function getCache(){
        if(cache !== undefined){
            return cache;
        }

        if(refreshLoad !== undefined){
            return await refreshLoad;
        }

        return await loadCache();
    }

    return {
        async find(APIKey: string){
            const KeyHashes = await getCache();

            const IncomingHash = HashAPIKeyBuffer(APIKey);
            const StoredHash = KeyHashes.get(IncomingHash.toString("hex"));
            const CmpHash = StoredHash?.keyHashBuffer ?? DummyHash;

            // TODO: Can consider removing timing safe compare. Is that unsafe against timing attack?
            const IsMatch = crypto.timingSafeEqual(IncomingHash, CmpHash);

            return StoredHash !== undefined && IsMatch ? StoredHash.value : undefined;
        },
        async refresh(){
            await refreshCache();
        }
    };
}
