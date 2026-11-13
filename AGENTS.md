# AGENTS.md

## Project Instructions

You are developing a local Model Context Protocol (MCP) server for RPG Maker MZ.

The complete functional and technical requirements are documented in `SPEC.md`.

**Read `SPEC.md` before implementing any feature.** Treat it as the authoritative project specification.

## Core Development Principles

1. Use TypeScript and Node.js.
2. Follow modular architecture, keeping Eventing, Database, Project Management, Validation, and MCP interfaces independently organized.
3. Preserve native RPG Maker MZ JSON structures and unknown fields.
4. Prefer typed, semantic operations over arbitrary JSON manipulation.
5. Do not silently renumber database records or event identifiers.
6. Never modify project files outside the configured project root.
7. All modifications must go through the shared transaction and validation infrastructure.
8. Generate previews and diffs before applying potentially destructive changes.
9. Preserve unsupported event commands and plugin-specific data whenever possible.
10. Do not assume RPG Maker MZ data structures from memory. Inspect actual project fixtures and verify native schemas.

## Implementation Workflow

- Inspect the existing codebase before making architectural decisions.
- Check the relevant sections of `SPEC.md` before implementing a feature.
- Implement small, independently testable components.
- Add tests alongside new functionality.
- Run relevant tests after modifications.
- Report incomplete requirements and known limitations honestly.
- Do not replace existing functionality without understanding its dependencies.

## Quality Requirements

- Maintain strict TypeScript typing.
- Avoid unnecessary dependencies.
- Handle malformed project data gracefully.
- Provide meaningful error messages.
- Keep operations deterministic and reproducible.
- Preserve backward compatibility with existing project data.
- Never claim a feature is implemented unless it is actually functional and tested.

## Development Priorities

Follow the implementation milestones in `SPEC.md`.

Prioritize a reliable read-only foundation before implementing write operations.

Do not attempt to implement the entire specification in one pass. Build incrementally, validate each milestone, and maintain a working codebase throughout development.

## Documentation

Update documentation when implementation decisions differ from the original specification.

If a requirement is technically impossible or incompatible with RPG Maker MZ's native data structures, explain the issue and propose an alternative before changing the intended behavior.