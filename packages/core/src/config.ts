/**
 * Config loading with fail-fast validation.
 *
 * Convention §3: a block must fail at startup with one actionable message listing every
 * missing variable — not a `TypeError: undefined` on the first request three days later.
 */

export interface ConfigSpec {
  /** Block slug, e.g. "queue". Used in error messages and schema naming. */
  block: string;
  /** Env vars that must be present and non-empty. */
  required?: readonly string[];
  /** Env vars with defaults applied when absent. */
  optional?: Readonly<Record<string, string>>;
}

export interface LoadedConfig {
  readonly block: string;
  /** Resolved value of a declared variable. Throws if it was never declared. */
  get(key: string): string;
  /** Resolved value, or undefined when absent and undeclared. */
  maybe(key: string): string | undefined;
  /** Integer-parsed value with bounds checking. */
  int(key: string, opts?: { min?: number; max?: number }): number;
  bool(key: string): boolean;
  /** Everything resolved, for logging. Values of secret-looking keys are redacted. */
  describe(): Record<string, string>;
}

const SECRET_HINTS = ["SECRET", "TOKEN", "KEY", "PASSWORD", "CREDENTIAL", "DSN", "URL"];

function looksSecret(key: string): boolean {
  return SECRET_HINTS.some((hint) => key.toUpperCase().includes(hint));
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(
    readonly block: string,
    readonly problems: readonly string[],
  ) {
    super(
      `Block "${block}" is misconfigured:\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        `\n\nSet these in your Neon Functions environment, then redeploy.`,
    );
  }
}

/**
 * Validate and freeze the environment a block depends on.
 *
 * Collects *all* problems before throwing so a user fixes one deploy, not five.
 */
export function loadConfig(spec: ConfigSpec, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const resolved = new Map<string, string>();
  const problems: string[] = [];

  for (const key of spec.required ?? []) {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") {
      problems.push(`${key} is required but ${raw === undefined ? "not set" : "empty"}`);
      continue;
    }
    resolved.set(key, raw);
  }

  for (const [key, fallback] of Object.entries(spec.optional ?? {})) {
    const raw = env[key];
    resolved.set(key, raw === undefined || raw.trim() === "" ? fallback : raw);
  }

  if (problems.length > 0) throw new ConfigError(spec.block, problems);

  const get = (key: string): string => {
    const value = resolved.get(key);
    if (value === undefined) {
      // A programming error in the block, not a user misconfiguration.
      throw new Error(
        `Block "${spec.block}" read undeclared config "${key}". Add it to the ConfigSpec.`,
      );
    }
    return value;
  };

  return {
    block: spec.block,
    get,
    maybe: (key) => resolved.get(key),
    int: (key, opts) => {
      const raw = get(key);
      const parsed = Number(raw);
      if (!Number.isInteger(parsed)) {
        throw new ConfigError(spec.block, [`${key} must be an integer, got "${raw}"`]);
      }
      if (opts?.min !== undefined && parsed < opts.min) {
        throw new ConfigError(spec.block, [`${key} must be >= ${opts.min}, got ${parsed}`]);
      }
      if (opts?.max !== undefined && parsed > opts.max) {
        throw new ConfigError(spec.block, [`${key} must be <= ${opts.max}, got ${parsed}`]);
      }
      return parsed;
    },
    bool: (key) => ["1", "true", "yes", "on"].includes(get(key).toLowerCase()),
    describe: () =>
      Object.fromEntries(
        [...resolved].map(([k, v]) => [k, looksSecret(k) ? redact(v) : v]),
      ),
  };
}

/** Keep enough of a secret to identify it, not enough to use it. */
export function redact(value: string): string {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}***${value.slice(-2)}`;
}
