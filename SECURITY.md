# Security Policy

This document describes the security model of `rsc-cache`, the threats it defends against, and how to report vulnerabilities.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository (Security → Advisories → New draft). Do not open a public issue for exploitable findings. You can expect an initial response within 7 days.

## Threat model and defenses

### Cache poisoning

**Threat:** attacker-controlled input flows into a cache key; a poisoned value in a *shared* cache is served to other users.

Defenses:

- Keys are never built from raw user input alone. Arguments are normalized with a stable stringifier and **hashed (SHA-256)** before they reach storage, so keys cannot be spoofed by crafting colliding inputs.
- `maxKeyLength` (default 200) forces hashing of oversized keys; storage keys are never attacker-formatted strings.
- Namespaces isolate key spaces: `rsc-cache:v1:<namespace>:...`. Two apps sharing one Redis cannot read each other's entries.
- The default `keyIdentity` includes a hash of the function source, so an unrelated function can never collide onto an existing key.

**What you must do:** scope anything user-specific (see below) and never disable hashing.

### Tenant / user isolation

**Threat:** per-user data served from a shared public cache.

Defenses:

- `scope: (…args | { context }) => string[]` folds the resolved scope into the key; different users/tenants get different keys.
- `visibility: "private"` makes the entry private by construction: if the scope cannot be resolved (no request context, no user), the library **refuses to write or read a shared entry** rather than risking a leak.
- The library never guesses whether data is user-specific (no hidden magic, by design). Isolation must be declared explicitly.

### PII and sensitive data in keys and logs

- Full cache keys are **never** emitted in events, logs, or OpenTelemetry attributes by default; only short hashes (`cache.key_hash`) are.
- Raw user input never appears in storage keys.
- Debug logs redact values; enable `includeKeysInEvents` only if you understand the tradeoff.

### Serializer safety

- The default serializer is JSON-based. There is **no arbitrary code execution**: `eval` and `new Function` are never used.
- Class instances, functions, and React elements are not reconstructed by default. If you plug a richer serializer (e.g. one that restores prototypes), you inherit its risks — in particular, **deserializing data from an untrusted cache backend is an injection surface**. Only enable prototype-restoring serializers when the backend is trusted.
- Do not cache secrets (tokens, session blobs) longer than their natural lifetime; the cache has no crypto-at-rest.

### Untrusted cache backend

If your Redis/KV can be written by third parties, they can poison your cache. Mitigate with authenticated, encrypted backends (Redis ACL + TLS), network isolation, and by treating any prototype-restoring serializer as unsafe in this scenario.

### Stale private data after logout

Invalidation is explicit. On logout / permission change you must call `revalidateTag`/`revalidateKey` for the affected user's scoped entries (or use short TTLs for private data). A short `staleTtl` (or none) is recommended for user-specific data.

### Denial of service

- `maxValueSize` (default 1 MiB) rejects oversized payloads with a clear error instead of OOM-ing the process.
- Single-flight + distributed locks bound recomputation stampedes; lock waits have deadlines (`distributedLock.wait`).
- Storage operations have timeouts (`timeouts.read/write/lock/invalidate`) so a slow backend cannot hang requests forever.

### Logging hygiene

Debug mode (`debug: true`) logs outcomes with hashed key identifiers only, never values or raw arguments.

## Known limitations

- The memory storage is process-local; correctness across processes requires Redis/KV.
- Background revalidation is best-effort; serverless runtimes may terminate it after the response.
- The tag index and locks are advisory: a crashed writer's lock expires after `distributedLock.ttl`.
