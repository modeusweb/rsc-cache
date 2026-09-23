/**
 * Lua scripts used by the Redis adapter, together with TypeScript simulators.
 *
 * Every script has a mirror implementation so the exact command sequence can be
 * exercised by the test suite without a Redis server (`rsc-cache/testing` ships
 * a fake client that executes the simulators). Lua source and simulator live
 * next to each other on purpose: they must stay in sync.
 */

export interface ScriptContext {
  get(key: string): string | null;
  set(key: string, value: string): void;
  del(...keys: string[]): number;
  sadd(key: string, ...members: string[]): number;
  srem(key: string, ...members: string[]): number;
  smembers(key: string): string[];
  pexpire(key: string, ms: number): number;
}

export interface RedisScript {
  name: string;
  source: string;
  /** Mirror of `source`, executed against a plain key/value context. */
  simulate(ctx: ScriptContext, keys: string[], args: string[]): number;
}

/** Reads the revision out of the `RSC1|<revision>|...` envelope. */
function revisionOf(value: string | null): number | null {
  if (!value || !value.startsWith("RSC1|")) {
    return null;
  }
  const end = value.indexOf("|", 5);
  if (end === -1) {
    return null;
  }
  const revision = Number(value.slice(5, end));
  return Number.isFinite(revision) ? revision : null;
}

/**
 * Compare-and-set write with tag bookkeeping.
 *
 * KEYS: `[entryKey, indexKey, tagsKey, ...tagIndexKeys]`
 * ARGV: `[expectedRevision, revision, payload, ttlMs, tagCount]`
 *
 * `expectedRevision` may be:
 * - a revision number — the stored revision must match exactly,
 * - `''` — the key must not exist (fresh write / miss),
 * - `'-'` — no precondition (plain overwrite).
 *
 * - refuses the write when the stored revision is not the expected one
 *   (a slow revalidation can never overwrite a newer value),
 * - removes the key from the tag indexes it belonged to before,
 * - writes the entry with a native TTL,
 * - registers the key in the namespace index (used by `clear`).
 */
export const SET_ENTRY_SCRIPT: RedisScript = {
  name: "rsc-cache-set-entry",
  source: `
local expected = ARGV[1]
if expected ~= '-' then
  local current = redis.call('GET', KEYS[1])
  if not current then
    if expected ~= '' then return 0 end
  elseif expected == '' then
    return 0
  else
    local stored = tonumber(string.match(current, '^RSC1|(%d+)|'))
    if stored == nil or stored ~= tonumber(expected) then return 0 end
  end
end
if KEYS[3] ~= '' then
  local previous = redis.call('SMEMBERS', KEYS[3])
  for i = 1, #previous do redis.call('SREM', previous[i], KEYS[1]) end
  redis.call('DEL', KEYS[3])
end
local ttl = tonumber(ARGV[4])
if ttl and ttl > 0 then
  redis.call('SET', KEYS[1], ARGV[3], 'PX', ttl)
  if KEYS[3] ~= '' then redis.call('PEXPIRE', KEYS[3], ttl) end
else
  redis.call('SET', KEYS[1], ARGV[3])
end
local tagCount = tonumber(ARGV[5])
for i = 1, tagCount do
  local tagKey = KEYS[3 + i]
  redis.call('SADD', tagKey, KEYS[1])
  redis.call('SADD', KEYS[3], tagKey)
end
if KEYS[2] ~= '' then redis.call('SADD', KEYS[2], KEYS[1]) end
return 1
`,
  simulate: (ctx, keys, args) => {
    const entryKey = keys[0] as string;
    const indexKey = keys[1] as string;
    const tagsKey = keys[2] as string;
    const [expected = "", , payload = "", ttlRaw = "0", tagCountRaw = "0"] = args;

    if (expected !== "-") {
      const current = ctx.get(entryKey);
      if (!current) {
        if (expected !== "") {
          return 0;
        }
      } else if (expected === "") {
        return 0;
      } else if (revisionOf(current) !== Number(expected)) {
        return 0;
      }
    }

    if (tagsKey !== "") {
      for (const tagKey of ctx.smembers(tagsKey)) {
        ctx.srem(tagKey, entryKey);
      }
      ctx.del(tagsKey);
    }

    const ttl = Number(ttlRaw);
    ctx.set(entryKey, payload);
    if (ttl > 0) {
      ctx.pexpire(entryKey, ttl);
      if (tagsKey !== "") {
        ctx.pexpire(tagsKey, ttl);
      }
    }

    const tagCount = Number(tagCountRaw);
    for (let i = 0; i < tagCount; i += 1) {
      const tagKey = keys[3 + i];
      if (tagKey === undefined || tagKey === "" || tagsKey === "") {
        break;
      }
      ctx.sadd(tagKey, entryKey);
      ctx.sadd(tagsKey, tagKey);
    }

    if (indexKey !== "") {
      ctx.sadd(indexKey, entryKey);
    }
    return 1;
  },
};

/** Release a lock only when the token still belongs to us. */
export const RELEASE_LOCK_SCRIPT: RedisScript = {
  name: "rsc-cache-release-lock",
  source: `
local token = redis.call('GET', KEYS[1])
if token == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`,
  simulate: (ctx, keys, args) => {
    const key = keys[0] as string;
    if (ctx.get(key) === args[0]) {
      return ctx.del(key);
    }
    return 0;
  },
};

/** Invalidate a tag atomically: delete its members and the index set itself. */
export const INVALIDATE_TAG_SCRIPT: RedisScript = {
  name: "rsc-cache-invalidate-tag",
  source: `
local members = redis.call('SMEMBERS', KEYS[1])
-- Batched to stay well below the Lua C-stack argument limit (~8000).
for i = 1, #members, 500 do
  local batch = {}
  for j = i, math.min(i + 499, #members) do
    batch[#batch + 1] = members[j]
  end
  redis.call('DEL', unpack(batch))
end
redis.call('DEL', KEYS[1])
return #members
`,
  simulate: (ctx, keys) => {
    const tagKey = keys[0] as string;
    const members = ctx.smembers(tagKey);
    for (let i = 0; i < members.length; i += 500) {
      ctx.del(...members.slice(i, i + 500));
    }
    ctx.del(tagKey);
    return members.length;
  },
};

export const REDIS_SCRIPTS: readonly RedisScript[] = [
  SET_ENTRY_SCRIPT,
  RELEASE_LOCK_SCRIPT,
  INVALIDATE_TAG_SCRIPT,
];
