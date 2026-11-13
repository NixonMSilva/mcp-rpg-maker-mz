# Implementation status

Status against the project specifications (eventing and database; kept outside the repository). "Done" means implemented **and** covered by automated tests
(`npm test`: 177 tests, plus the read-only real-project corpus when available).

Everything not done, or only partly done, is tracked in [LIMITATIONS.md](../LIMITATIONS.md).

## Milestones

| Milestone | Status | Notes |
|---|---|---|
| Shared project foundation (detection, root confinement, revisions, manifest, lossless JSON) | Done | Byte-identical reserialization of 410/413 real files, and the other 3 keep their detected layout |
| Read-only event understanding | Done | Verified on two real user projects and the official samples, with no crashes |
| Event IR + compiler + parser | Done | 70+ block types. 5,091 real lists round-trip losslessly, and only 92 of them become opaque blocks (see L6) |
| Database read model | Done | All 14 categories, normalized views, search, name resolution, reference index |
| Safe event authoring | Done | Create/edit events and pages, block edits, settings, preview/apply, backups, rollback, stale detection |
| Safe database authoring | Done | Create (templates), patch, duplicate, guarded delete, collections, notes, class curves, system allowlist |
| Cross-domain workflows | Done | Batch change sets mixing database and event operations, name resolution, prompts, event templates |
| Map awareness (render, passability, reachability, paths, map-aware validation) | Done | Engine passage rules; autotile tables verified against rmmz_core.js 1.10.0. See [proposals/MAP_AWARENESS.md](proposals/MAP_AWARENESS.md) |
| Runtime testing (MCPBridge) | **Not started** | See L27 |

## Spec decisions taken

- Writes are **preview-first**. Every write tool returns a change set. Non-destructive ones may pass `apply=true` and
  commit only when validation has no errors and warnings were acknowledged. Destructive operations (delete event, page or
  record, and rollbacks) always need `apply_changes` with `confirm=<changeSetId>`.
- The server is **read-only by default**. `--allow-write` enables commits; previews always work.
- **JavaScript insertion** (script commands, script conditions and operands, route scripts, raw 355/655) requires
  `allowScript=true`. Scripts that already exist on the page may be re-submitted without it.
- Backups and the transaction log live in `<project>/.rpgmz-mcp/` (inside the project root, the only place writes are
  allowed). Exclude that folder from deployment, or set `--state-dir`.
