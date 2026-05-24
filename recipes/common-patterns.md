# Common patterns (copy-pasteable)

> **When to load this recipe:** the user asks for a multi-step action like "assign + comment + close," "show me the triage view," or anything that combines several `lwr` verbs into one workflow. SKILL.md routes here from its quick-reference section.

## End-to-end: "assign 'EPIC - Enhancement of Consolidate Tabulation Register' to Jane Doe, set status to New"

```bash
ID=$(lwr search "EPIC - Enhancement of Consolidate Tabulation" --types issue --json \
       | jq -r '.data.results[0].ref' | tr -d '#')
lwr issue edit "$ID" --assignee "Jane Doe" --status "New" --notes "kicking off" --json
```

## Triage view — open issues for a project, sorted by priority

```bash
lwr issue list --project "Linways AMS V4" --status open --sort "priority:desc,updated_on:desc" --limit 20 --json
```

## Drop a screenshot + repro note in one PUT (one journal, not two)

```bash
lwr issue attach <id> ./screenshot.png ./repro.txt --message "see attached" --json
```

## Materialise an issue locally for analysis

```bash
lwr issue fetch <id> --json
# downloads the issue JSON, all attachments, converts PDFs/DOCX to per-page PNGs
# under ~/.lwr/issues/<id>/. Re-runs hit the cache; pass --force to re-download.
```

## Cross-resource search

```bash
lwr search "consolidated marksheet" --types issue --open --limit 10 --json \
  | jq '.data.results[] | {id, subject: .title, ref}'
```
