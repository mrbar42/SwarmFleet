/**
 * Secret and PII redaction utilities for terminal history persistence.
 * Filters sensitive values from environment variables and command text
 * before writing to disk.
 */

const REDACTED = "[REDACTED]";

/**
 * Environment variable name patterns that indicate sensitive values.
 */
const SENSITIVE_NAME_PATTERNS = [
  /SECRET/i,
  /KEY/i,
  /TOKEN/i,
  /PASSWORD/i,
  /PASSWD/i,
  /PASS(?:PHRASE)?$/i,
  /CREDENTIAL/i,
  /AUTH/i,
  /PRIVATE/i,
  /SIGNING/i,
  /ENCRYPTION/i,
  /CERTIFICATE/i,
  /API_?KEY/i,
  /ACCESS_?KEY/i,
];

/** Exact env var names that are always sensitive */
const SENSITIVE_EXACT_NAMES = new Set([
  "DATABASE_URL",
  "REDIS_URL",
  "MONGODB_URI",
  "MONGO_URL",
  "NPM_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "AWS_SESSION_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "STRIPE_SECRET_KEY",
  "SENDGRID_API_KEY",
  "TWILIO_AUTH_TOKEN",
  "SLACK_TOKEN",
  "SLACK_WEBHOOK_URL",
  "DISCORD_TOKEN",
  "SENTRY_DSN",
  "COOKIE_SECRET",
  "SESSION_SECRET",
  "JWT_SECRET",
  "ENCRYPTION_KEY",
]);

/** Env var names that are safe despite matching patterns */
const SAFE_NAMES = new Set([
  "TERM",
  "SHELL",
  "USER",
  "HOME",
  "PWD",
  "OLDPWD",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "DISPLAY",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "COLUMNS",
  "LINES",
  "COLORTERM",
  "TERM_PROGRAM",
  "HOSTNAME",
  "LOGNAME",
  "SHLVL",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "KEYBOARD_LAYOUT",
  "CHROME_PATH",
  "PUPPETEER_EXECUTABLE_PATH",
  "CHROMIUM_FLAGS",
  "NODE_ENV",
  "NODE_PATH",
  "NODE_OPTIONS",
  "WORKSPACES_ROOT",
  "DEBIAN_FRONTEND",
]);

/**
 * Checks if an environment variable name indicates a sensitive value.
 */
export function isSensitiveEnvName(name: string): boolean {
  if (SAFE_NAMES.has(name)) return false;
  if (SENSITIVE_EXACT_NAMES.has(name)) return true;
  return SENSITIVE_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Returns a copy of the env object with sensitive values replaced by [REDACTED].
 */
export function redactEnvVars(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    result[name] = isSensitiveEnvName(name) ? REDACTED : value;
  }
  return result;
}

/**
 * Regex patterns for secrets that may appear in command text.
 */
const TEXT_REDACTION_RULES: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, `Bearer ${REDACTED}`],
  [/AKIA[0-9A-Z]{16}/g, REDACTED],
  [
    /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    REDACTED,
  ],
  [
    /((?:mysql|postgres|postgresql|mongodb|redis|amqp|smtp|ftp|https?):\/\/[^:]+:)[^@]+(@)/gi,
    `$1${REDACTED}$2`,
  ],
  [
    /(?:export|set)\s+(\w*(?:SECRET|KEY|TOKEN|PASSWORD|PASS|CREDENTIAL|AUTH|PRIVATE)\w*)=\S+/gi,
    `export $1=${REDACTED}`,
  ],
  [
    /(-H\s+['"]?Authorization:\s*)\S+(['"]?)/gi,
    `$1${REDACTED}$2`,
  ],
  [/([=:]\s*)[A-Za-z0-9+/]{40,}={0,2}(?=\s|$|'|")/g, `$1${REDACTED}`],
];

/**
 * Redacts secrets from arbitrary text (command input).
 */
export function redactText(text: string): string {
  let result = text;
  for (const [pattern, replacement] of TEXT_REDACTION_RULES) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}
