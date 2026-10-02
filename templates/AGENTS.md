# {{AGENT_FILE_NAME}}

{{PROJECT_PURPOSE}}

> **Harness workspace:** `{{HARNESS_ROOT}}`
> **Project root (code):** `{{PROJECT_ROOT}}`
> **Created:** {{CREATED_AT}}

This directory is the agent harness for **{{PROJECT_NAME}}**. It holds the
instruction, state, verification, scope, and lifecycle artifacts that let a new
session start, stay in scope, verify work, and resume without human repair.

## Startup Workflow

Before writing code:

1. **Confirm working context** with `pwd` and note the harness workspace above
2. **Read this file** completely
3. **Read `index.md`** for the harness map
4. **Read `feature_list.json`** to see current feature state
5. **Read `progress.md`** and `session-handoff.md` for continuity
6. **Read project docs** (`docs/ARCHITECTURE.md`, `docs/CODE-STYLE.md`, `docs/PLACEMENT.md`, `docs/PRODUCT.md`, README) if present
7. **Run {{VERIFY_COMMAND_REF}}** to confirm the baseline is healthy
8. **Review recent commits** with `git log --oneline -5`

If baseline verification is failing, repair that first before adding new scope.

## Working Rules

- **One feature at a time**: Pick exactly one unfinished feature from `feature_list.json`
- **Verification required**: Don't claim done without running verification commands
- **Update artifacts**: Before ending a session, update `progress.md` and `feature_list.json`
- **Stay in scope**: Don't modify files unrelated to the current feature
- **Match the code style**: Read `docs/CODE-STYLE.md` before writing code and follow it
- **Place files correctly**: Read `docs/PLACEMENT.md` before creating a file; put controllers, services, models, components, and tests where the guide says — do not invent new locations
- **Leave clean state**: The next session must be able to run {{VERIFY_COMMAND_REF}} immediately
- **No fake passing**: Never mark a feature `done` without recorded evidence

## Required Artifacts

- `feature_list.json` — Feature state tracker (source of truth)
- `progress.md` — Session continuity log
{{INIT_ARTIFACT_LINE}}
- `session-handoff.md` — Short handoff for the next session
- `index.md` — Harness index and artifact map
- `docs/CODE-STYLE.md` — Confirmed code conventions to follow when writing code
- `docs/PLACEMENT.md` — Where new files of each kind belong

## Definition of Done

A feature is done only when ALL of the following are true:

- [ ] Target behavior is implemented
- [ ] Required verification actually ran (tests / lint / type-check)
- [ ] Evidence recorded in `feature_list.json` or `progress.md`
- [ ] Repository remains restartable from the standard startup path

## End of Session

Before ending a session:

1. Update `progress.md` with the current state
2. Update `feature_list.json` with the new feature status
3. Record any unresolved risks or blockers
4. Commit with a descriptive message once work is in a safe state
5. Leave the repo clean enough for the next session to run {{VERIFY_COMMAND_REF}} immediately

## Verification Commands

```bash
# Full verification (recommended)
{{PRIMARY_VERIFICATION_COMMAND}}
```

Required checks:
{{VERIFICATION_COMMANDS}}

## Escalation

If you encounter:

- **Architecture decisions**: consult `docs/ARCHITECTURE.md`, otherwise ask the user
- **Unclear requirements**: consult `docs/PRODUCT.md`, otherwise ask the user
- **Repeated test failures**: update `progress.md`, flag for human review
- **Scope ambiguity**: re-read `feature_list.json` for the definition of done
