# Placement Guide — {{PROJECT_NAME}}

Where new files belong. Read this before creating a controller, service,
model, component, test, or any other new file so the codebase stays
predictable.

## Where To Put New Code

| Kind | Directory | Existing examples | Naming pattern |
|---|---|---|---|
|  |  |  |  |

## Decision Recipe

1. Identify the kind of file (controller, service, model, …).
2. Find its row above and create the file in that directory.
3. Match the naming pattern of the existing examples in that directory.
4. Follow `docs/CODE-STYLE.md` for formatting and naming inside the file.
5. Add or update the matching test next to the existing tests.
6. If the kind has no row, ask the user instead of inventing a new location.

## Layer Rules

- What may import what (dependency direction):
- What must NOT be imported by:
- Shared code lives in:

## Adding A New Module (checklist)

- [ ] Created in the correct directory from the table above
- [ ] File and symbol names match the surrounding conventions
- [ ] Wired into the existing registration/routing/bootstrap file:
- [ ] Test added following the existing test layout
- [ ] No new cross-layer imports that violate the layer rules

## Update History

- {{CREATED_AT}}: created with the harness scaffold.
