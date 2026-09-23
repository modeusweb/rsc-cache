#!/usr/bin/env node
/**
 * `rsc-cache` CLI.
 *
 * ```bash
 * npx rsc-cache doctor
 * npx rsc-cache --help
 * ```
 *
 * `doctor` inspects the environment: runtime, React version, `cacheSignal`
 * support, async context support, optional backends, the configuration file and
 * the capabilities of the configured storage. It never prints secrets — only
 * whether an environment variable is set.
 *
 * This file is the only place in the package that touches Node APIs; it is a
 * separate entry point and is never imported by the library.
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

type Status = "ok" | "warn" | "fail";

interface Check {
  label: string;
  status: Status;
  detail?: string;
}

const SYMBOL: Record<Status, string> = { ok: "✓", warn: "⚠", fail: "✗" };

const CONFIG_CANDIDATES = [
  "rsc-cache.config.mjs",
  "rsc-cache.config.js",
  "rsc-cache.config.ts",
  "rsc-cache.config.json",
  ".rsc-cache.json",
];

const OPTIONAL_BACKENDS: Array<{ name: string; specifiers: string[]; env?: string[] }> = [
  {
    name: "Redis (node-redis / ioredis)",
    specifiers: ["@redis/client", "redis", "ioredis"],
    env: ["REDIS_URL", "VALKEY_URL"],
  },
  { name: "Upstash Redis", specifiers: ["@upstash/redis"], env: ["UPSTASH_REDIS_REST_URL"] },
  { name: "OpenTelemetry", specifiers: ["@opentelemetry/api"] },
  { name: "Next.js", specifiers: ["next"] },
];

async function safeImport(specifier: string): Promise<{ ok: boolean; version?: string }> {
  try {
    const module = (await import(specifier)) as {
      version?: string;
      default?: { version?: string };
    };
    const version = module.version ?? module.default?.version;
    return version === undefined ? { ok: true } : { ok: true, version };
  } catch {
    return { ok: false };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function checkRuntime(): Promise<Check> {
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  const deno = (globalThis as { Deno?: { version?: { deno?: string } } }).Deno;
  if (bun) {
    return { label: `Runtime: Bun ${bun.version}`, status: "ok" };
  }
  if (deno) {
    return { label: `Runtime: Deno ${deno.version?.deno ?? "unknown"}`, status: "ok" };
  }
  const version = process.versions.node;
  const major = Number(version.split(".")[0]);
  if (major >= 20) {
    return { label: `Runtime: Node.js ${version}`, status: "ok" };
  }
  return {
    label: `Runtime: Node.js ${version}`,
    status: "fail",
    detail: "rsc-cache requires Node.js 20 or newer (or Bun/Deno/equivalent)",
  };
}

async function checkReact(): Promise<Check[]> {
  const react = await safeImport("react");
  if (!react.ok) {
    return [
      {
        label: "React: not installed",
        status: "warn",
        detail: "install `react@19` for the RSC integration, or ignore if you use rsc-cache without React",
      },
    ];
  }

  const checks: Check[] = [{ label: `React: ${react.version ?? "unknown version"}`, status: "ok" }];
  try {
    const reactModule = (await import("react")) as { cache?: unknown; cacheSignal?: unknown };
    const hasCache = typeof reactModule.cache === "function";
    const hasSignal = typeof reactModule.cacheSignal === "function";
    checks.push({
      label: `React cache(): ${hasCache ? "available" : "unavailable"}`,
      status: hasCache ? "ok" : "warn",
    });
    checks.push({
      label: `React cacheSignal(): ${hasSignal ? "available" : "not available"}`,
      status: hasSignal ? "ok" : "warn",
      ...(hasSignal
        ? {}
        : {
            detail:
              "render cancellation requires React 19.3+; rsc-cache works without it",
          }),
    });
  } catch {
    // React metadata is best effort.
  }
  return checks;
}

async function checkAsyncContext(): Promise<Check> {
  try {
    const module = (await import("node:async_hooks")) as { AsyncLocalStorage?: unknown };
    if (typeof module.AsyncLocalStorage === "function") {
      return { label: "Async context (AsyncLocalStorage): available", status: "ok" };
    }
  } catch {
    // Not available: the synchronous fallback is used.
  }
  return {
    label: "Async context (AsyncLocalStorage): unavailable",
    status: "warn",
    detail:
      "withCacheContext() will only propagate synchronously; derive scope/key from arguments instead",
  };
}

async function checkSerializer(): Promise<Check> {
  try {
    const { jsonSerializer } = await import("./serializer.js");
    const serializer = jsonSerializer();
    const bytes = await serializer.serialize({ date: new Date(0), big: 1n });
    const restored = (await serializer.deserialize(bytes)) as { big?: bigint };
    const ok = typeof restored.big === "bigint";
    return {
      label: `Serializer: ${serializer.name ?? "custom"} (typed JSON)`,
      status: ok ? "ok" : "warn",
      detail: ok ? "Date/BigInt/Map/Set round trip verified" : "type fidelity check failed",
    };
  } catch (error) {
    return {
      label: "Serializer: failed",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkConfig(): Promise<{ checks: Check[]; storage?: unknown }> {
  for (const candidate of CONFIG_CANDIDATES) {
    const path = join(process.cwd(), candidate);
    if (!(await exists(path))) {
      continue;
    }
    if (candidate.endsWith(".json")) {
      return {
        checks: [
          {
            label: `Configuration: ${candidate} (JSON)`,
            status: "warn",
            detail: "JSON cannot declare a custom storage; use rsc-cache.config.mjs",
          },
        ],
      };
    }
    try {
      const module = (await import(path)) as {
        default?: { cache?: unknown; storage?: unknown; namespace?: string };
        cache?: unknown;
        storage?: unknown;
      };
      const instance = (module.default?.cache ?? module.cache ?? module.default) as
        | { storage?: unknown; namespace?: string }
        | undefined;
      const storage = module.default?.storage ?? module.storage ?? instance?.storage;
      const checks: Check[] = [
        {
          label: `Configuration: ${candidate}`,
          status: "ok",
          ...(instance?.namespace ? { detail: `namespace="${instance.namespace}"` } : {}),
        },
      ];
      return storage === undefined ? { checks } : { checks, storage };
    } catch (error) {
      return {
        checks: [
          {
            label: `Configuration: ${candidate}`,
            status: "fail",
            detail: `failed to load: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
  return {
    checks: [
      {
        label: "Configuration: none found",
        status: "warn",
        detail: "create rsc-cache.config.mjs, or call configureCache() when your app boots",
      },
    ],
  };
}

function describeStorage(storage: unknown): Check {
  if (!storage || typeof storage !== "object") {
    return {
      label: "Storage: not configured",
      status: "warn",
      detail: "falling back to process-local memory storage (not shared between processes)",
    };
  }
  const candidate = storage as {
    name?: string;
    compareAndSet?: unknown;
    invalidateTag?: unknown;
    addTags?: unknown;
    acquireLock?: unknown;
  };
  const capabilities = [
    typeof candidate.compareAndSet === "function" ? "compare-and-set" : null,
    typeof candidate.addTags === "function" && typeof candidate.invalidateTag === "function"
      ? "native tags"
      : "tag index fallback",
    typeof candidate.acquireLock === "function" ? "distributed locks" : null,
  ].filter((item): item is string => item !== null);

  return {
    label: `Storage: ${candidate.name ?? "custom"}`,
    status: "ok",
    detail: capabilities.join(", "),
  };
}

async function checkBackends(): Promise<Check[]> {
  const checks: Check[] = [];
  for (const backend of OPTIONAL_BACKENDS) {
    let installed: string | undefined;
    for (const specifier of backend.specifiers) {
      const result = await safeImport(specifier);
      if (result.ok) {
        installed = result.version ? `${specifier}@${result.version}` : specifier;
        break;
      }
    }
    const configured = (backend.env ?? []).filter((name) => Boolean(process.env[name]));
    checks.push({
      label: `${backend.name}: ${installed ?? "not installed"}`,
      status: installed ? "ok" : "warn",
      ...(configured.length > 0 ? { detail: `env set: ${configured.join(", ")}` } : {}),
    });
  }
  return checks;
}

async function doctor(): Promise<number> {
  const checks: Check[] = [];
  checks.push(await checkRuntime());
  checks.push(...(await checkReact()));
  checks.push(await checkAsyncContext());
  checks.push(await checkSerializer());

  const { checks: configChecks, storage } = await checkConfig();
  checks.push(...configChecks);
  checks.push(describeStorage(storage));
  checks.push(...(await checkBackends()));

  // The library's own version, for support requests.
  try {
    const packageJson = JSON.parse(
      await readFile(join(process.cwd(), "node_modules", "rsc-cache", "package.json"), "utf8"),
    ) as { version?: string };
    if (packageJson.version) {
      checks.push({ label: `rsc-cache: ${packageJson.version}`, status: "ok" });
    }
  } catch {
    // Running from a checkout: not an error.
  }

  let failures = 0;
  let warnings = 0;
  for (const check of checks) {
    process.stdout.write(
      `${SYMBOL[check.status]} ${check.label}${check.detail ? ` — ${check.detail}` : ""}\n`,
    );
    if (check.status === "fail") failures += 1;
    if (check.status === "warn") warnings += 1;
  }

  process.stdout.write(
    `\n${checks.length} checks: ${checks.length - failures - warnings} ok, ${warnings} warnings, ${failures} failures\n`,
  );
  return failures > 0 ? 1 : 0;
}

function help(): void {
  process.stdout.write(
    [
      "rsc-cache",
      "",
      "Usage:",
      "  rsc-cache doctor     inspect the environment and cache configuration",
      "  rsc-cache --version  print the CLI version",
      "  rsc-cache --help     print this message",
      "",
    ].join("\n"),
  );
}

/** Reads the package version next to the entry point (never hard-coded). */
async function readVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // Report "unknown" rather than a wrong, hard-coded version.
  }
  return "unknown";
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "doctor";
  switch (command) {
    case "doctor":
      process.exitCode = await doctor();
      return;
    case "--version":
    case "-v":
      process.stdout.write(`rsc-cache ${await readVersion()}\n`);
      return;
    case "--help":
    case "-h":
    case "help":
      help();
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n`);
      help();
      process.exitCode = 1;
  }
}

void main();
