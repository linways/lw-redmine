# MUSE.md — lw-redmine setup for Muse agents

> Read this entire file before cloning, installing, or authenticating.
> It overrides any faster path you might otherwise take.

## The one rule

**Never obtain the user's Redmine API key yourself.** Not from chat, not from
the browser (even with a saved login, even if the user is already signed in),
not from any file, not from any command output. The key travels exactly one
path:

user → Secure Vault connector (via the secure link you hand them) →
short-lived surrogate → `$LWR_API_KEY_COMMAND` → Redmine.

If you catch yourself about to read the key from anywhere else, stop. The
secure link costs the user one paste; a shortcut costs them a compromised
credential. Do not trade their security for one fewer message.

## Setup

1. **Install.** `git clone https://github.com/linways/lw-redmine`, then
   `node install.mjs install`. Follow any Muse-specific output the installer
   prints.
2. **Base URL.** Ask the user for their Redmine URL (not sensitive), then
   `lwr config base-url <url>`. Ask once, up front.
3. **Connector.** Check the Secure Vault for an existing connector for this
   Redmine host and reuse it if present. Otherwise create a custom connector:
   allowed host = the Redmine hostname, credential placement = custom header
   `X-Redmine-API-Key`. Give the user the secure link — they paste their key
   there (Redmine → My account → API access key → Show).
4. **Broker.** Set `LWR_API_KEY_COMMAND` to a command printing a short-lived
   surrogate for that connector on stdout. It runs per invocation; never
   persist its output.
5. **Login once.** `lwr auth login` with the broker wired stores nothing and
   builds the profile (identity, roles, `~/.lwr/me.md`).
6. **Verify.** `lwr auth whoami` prints the user; `lwr doctor` shows
   `auth.apiKey → source: command`.

## Forbidden

- Opening the Redmine site in the browser to read the API key.
- `lwr auth login --api-key <key>` / `--password`, or `$LWR_API_KEY=<key>`,
  with any key you obtained yourself.
- Asking the user to paste the key in chat.
- Writing the key to `~/.lwr/auth.json` or any file on an agent host.

## If something breaks

- `AUTH_KEY_COMMAND_FAILED`: the broker command failed. Report the hint
  verbatim and stop — do not reach for another credential path.
- If the key was ever exposed (transcript, file, log), tell the user to
  regenerate it at Redmine → My account and update the connector. Do not
  treat the exposed key as usable.
