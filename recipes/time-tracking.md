# Time tracking — `lwr time log / list / edit / delete`

> **When to load this recipe:** the user asks to log hours, review their time entries, fix an entry, or delete one. SKILL.md routes here from its time-tracking decision tree.

`spent_hours` on every issue is a **server-computed sum** of time-entry rows. You cannot set it via `lwr issue edit`; you must POST a time entry. Logged time is reflected on the next `lwr issue view <id>`.

```text
lwr time log <issue> --hours N [--activity NAME] [--date YYYY-MM-DD] [--comments "..."] --json
lwr time list [--issue X] [--user me] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--activity NAME] --json
lwr time edit <entry-id> [--hours N] [--activity NAME] [--date YYYY-MM-DD] [--comments "..."] --json
lwr time delete <entry-id> --confirm "delete-time-entry" --yes --json
lwr time activities --json                            # cache-first activity catalog
```

## Decision tree

| User says | Verb |
|---|---|
| "log 2.5h on #125415", "I worked 1h on X today" | `lwr time log` |
| "what did I log last week?" | `lwr time list --user me --from --to` |
| "everyone's time on #X" | `lwr time list --issue <X>` |
| "fix the hours on entry 4711" | `lwr time edit` |
| "delete that bad entry" | `lwr time delete` (double-confirm) |

## Activity resolution

Activity resolution mirrors `--status`: pass `--activity Development` (name, case-insensitive) and `lwr` resolves to the numeric id via the cached `time_entry_activities` enumeration. Pass `--activity-id N` only when you already have the id; passing both fails with `VALIDATION_BAD_VALUE`. If neither flag is given, `lwr time log` falls back to the instance's default activity.

## Hours and dates

Hours are decimals. **`--hours 2.5`** is correct; `2:30`, `2h 30m` are not. Hours must be `> 0`.

Dates are ISO `YYYY-MM-DD`. Omit `--date` to default to today (server-side).

## Deletion safety

`time delete` is hard — Redmine has no undelete. Always interpret an *implied* delete ("get rid of that entry", "remove that log") as a request to confirm with the user before issuing the call, and require the explicit `--confirm "delete-time-entry" --yes` pair in non-TTY contexts.
