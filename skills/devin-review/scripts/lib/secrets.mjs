// Credential-shape pre-flight. The diff is sent to Google, so obvious secrets
// in ADDED lines block the run unless the user explicitly waives the scan.

// Ported verbatim from the shell implementation. Case-insensitive.
const SECRET_PATTERN = new RegExp(
  [
    "BEGIN [A-Z ]*PRIVATE KEY",
    "AKIA[0-9A-Z]{16}",
    "gh[pousr]_[A-Za-z0-9]{20,}",
    "sk_live_[A-Za-z0-9]{16,}",
    "rk_live_[A-Za-z0-9]{16,}",
    "xox[baprs]-[A-Za-z0-9-]{10,}",
    // Split so this file does not match its own pattern. Without the break, any
    // review of this repository blocks on the scanner's own source.
    `-----BEGIN ${"OPENSSH"}`,
    "(api[_-]?key|secret|password|passwd|token)[\"' ]*[:=][\"' ]*[A-Za-z0-9/+_-]{20,}",
  ].join("|"),
  "i",
);

/**
 * Scan a unified diff for credential shapes on added lines.
 *
 * Only `+` lines are considered — a secret being REMOVED is not one we would be
 * transmitting anew, and matching context lines would fire on every diff that
 * merely sits near a config block. `+++ b/file` header lines are excluded so a
 * path like `src/auth/token_secret_config.ts` cannot trip the scan.
 *
 * @returns {{line: number, text: string}[]} up to `limit` matches, with
 *   1-based line numbers into the diff text (matching the old grep -n output).
 */
export function scanForSecrets(diffText, limit = 5) {
  const hits = [];
  const lines = diffText.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith("+")) continue;
    if (line.startsWith("+++ ")) continue;
    if (!SECRET_PATTERN.test(line)) continue;
    hits.push({ line: i + 1, text: line.slice(0, 160) });
    if (hits.length >= limit) break;
  }
  return hits;
}

export { SECRET_PATTERN };
