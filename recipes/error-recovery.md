# Error recovery patterns

> **When to load this recipe:** an `lwr` call returned `ok: false` and you need to know what to do next based on `error.code`. SKILL.md's error-code reference table points here. Branch on `error.code`, not the human-readable message.

## `WORKFLOW_NOT_ALLOWED` fires after `--status "X"`

**Don't** fetch the issue again. The error already carries the allowed list:

```jsonc
"details": {
  "allowed": [{"id": 9, "name": "Testing Pending", "is_closed": false}, ...]
}
```

Either:
- Pick a status from `details.allowed[]` that matches the user's intent and retry, or
- Tell the user "X isn't a valid transition from the current status; allowed: <list>".

## `VALIDATION_AMBIGUOUS_USER` or `VALIDATION_AMBIGUOUS_PROJECT`

`details.candidates` is the disambiguation list. Pick one (by surfacing them to the user, or by best name match) and retry with the **numeric id** — that's unambiguous.

## `VALIDATION_USER_NOT_FOUND`

Possible causes:
1. The person isn't a member of the issue's project — try `--project <other>` or `lwr user list --project <id>` to confirm.
2. The cache is stale — `lwr cache refresh --type projects` re-pulls the index + every cached project's members.
3. `/users.json` is admin-only on Linways and the manual fallback is empty — ask the user to run `lwr user import users.json`.

## `VALIDATION_PROJECT_NOT_FOUND`

Either the name doesn't match anything visible to the current user, or the project was created after the index was last built. Try:

```bash
lwr cache refresh --type projects
lwr project list --all --json    # see everything visible
```

## `AUTH_FORBIDDEN`

The current API key lacks permission. Common case: trying `lwr user list --search` without admin (use `--project <id>` instead). For mutation 403s, surface to the user — they need a role change in Redmine.

## `VALIDATION_USER_NOT_FOUND` / `VALIDATION_PROJECT_NOT_FOUND` — staleness check

Every resolver-not-found error now carries `error.details.cache` with each consulted source's `source` (`'cache'` | `'live'`), `fetchedAt` (epoch ms), and `ageMs`:

```json
"error": {
  "code": "VALIDATION_USER_NOT_FOUND",
  "details": {
    "query": "Newhire Person",
    "cache": {
      "members:51": { "source": "cache", "fetchedAt": 1778310131402, "ageMs": 1800000 }
    }
  }
}
```

**The agent's policy:**

1. If **any** consulted source has `source: "cache"` → retry the same command with `--no-cache` once. A user/project added since the cache was written would otherwise never resolve.
2. If the retry's response shows `source: "live"` and still fails → the entity genuinely doesn't exist. Surface to the user.
3. If `source` is already `"live"` on the first call → trust the miss; don't loop.
4. **Proactive refresh** (separate from per-resolution failure): if `me.detectedAt` or any cache `ageMs` exceeds **30 days**, run `lwr cache refresh` (and `lwr me detect` for profile data) before answering. That catches stale state during long inactive periods.
5. **User-explicit refresh**: when the user says "refresh / re-fetch / update cache," run `lwr cache refresh --json`.

The hint string also tells you this in plain English — but always branch on the structured `details.cache` field, not the message.

## Wrong / missing role on the user's profile

The user says "I'm a tester, not a developer" (or asks about a role that errored with `VALIDATION_BAD_VALUE: role "X" is not in your profile`):

```bash
# Re-detect against current Redmine state, optionally overriding the role list:
lwr me detect --role developer,tester --json

# Manual cf binding when the Redmine uses a non-canonical name (e.g. "Lead Dev"):
lwr me set field-map developer 79 "Lead Dev" --json
```

Then re-read `~/.lwr/me.md` and retry the original query. Never instruct the user to edit `~/.lwr/config.json` directly.

## `CONFIG_PROFILE_MISSING` from `lwr me detect` — "No custom field on this Redmine matches role X"

The Redmine instance doesn't have a cf with a name matching that role's pattern. Either:
- Drop the role from `--role` (the Redmine genuinely doesn't track it), or
- Use `lwr me set field-map <role> <cfId> <name>` to bind it manually if the cf exists under a different name.
