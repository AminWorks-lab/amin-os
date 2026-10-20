# Internal linkage adapter contract

This work integrates existing apps; it does not create new desktop apps. All adapters live in `apps/linkage/adapters/<id>.js` and export `adapter`.

```js
export const adapter = {
  id: 'inventory', label: '背包与账本',
  // Exact metadata read dependencies, including other modules read by apply.
  paths: [['amin_os_inventory_v1'], ['amin_os_characters_v1']],
  // Compact signature-style schema: one line per action. Shared rules (stable
  // IDs, @new: aliases, notation, forbidden fields) live once in the protocol
  // header of prompt.js and must not be repeated here. `advanced` actions,
  // `advancedArgs`, `advancedNotes` and `more` are only sent when the user
  // enables advanced descriptions; validation accepts them either way.
  // `sources` (source-floor fields) is shown to manual generation only, since
  // the unified coordinator binds the reply floor automatically.
  // Action names are kebab-case: create-x / update-x / delete-x plus a few
  // domain verbs (consume-item, move-to, settle-effect). `creates: kind` marks
  // an action whose target is always a new `@new:` alias; `upserts: kind` one
  // whose target may be. `aliases` lists legacy names (set_fact, add_node, …):
  // parseUpdate maps them to `name`, rules never show them.
  spec: { notes: 'target=物品ID。', actions: [
    { name: 'create-item', creates: 'item', args: 'name,ownerId,quantity:int≥0' },
    { name: 'update-item', aliases: ['save-item'], args: 'name?,quantity?' },
    { name: 'consume-item', args: 'quantity:int>0' },
  ] },
  contract: renderContract(spec), // full text, for manual generation prompts
  // Current branch JSON-safe data. Missing modules return a valid empty state.
  read(ctx) {},
  // Optional model-facing projection: omit unconfirmed/raw evidence and data
  // owned by other modules. The coordinator applies each module's read policy.
  readForPrompt(ctx) {},
  // Pure: must not mutate ctx, save metadata, emit events, call AI or roll dice.
  // One change: {module, action, target?, data: object, reason: nonempty string}.
  // Validate references, use module's validated model operations, preserve history.
  // Return {patches:[{path: [...], value}|{path:[...],remove:true}], summary: string}.
  // operationId is supplied by the coordinator, stable within the transaction.
  apply(ctx, change, {operationId, now}) {},
};
```

The coordinator applies adapters sequentially to a cloned metadata snapshot, validates the entire batch, then commits all resulting patches under the existing operation lock. No adapter may commit/save separately. Settings, credentials, global libraries, chat messages, and generated dice results are not writable through model updates. IDs refer to existing module-owned IDs; new objects use `@new:` aliases that the coordinator resolves to plugin-generated IDs. Reason is required. Unknown operations and invalid references are errors.

Cross-module links use stable IDs: character IDs, map/node IDs, item IDs, relationship IDs, effect IDs, journal IDs. World Status uses its existing project/field paths as the canonical numeric source. Renaming must not rebind references by display name. Missing or removed references must remain visible and must not be silently retargeted.

Module settings are managed by the coordinator at `amin_os_linkage_v1`: master enabled, review/auto mode, per-module enabled/read/write, editable extra rules. Hiding a tile is unrelated. `apps/linkage/policy.js` exports `managesModule(ctx,id)` and `readLinkageSettings(ctx)` for legacy prompt/writer suppression only when the unified master and that module are enabled.

New optional fields must remain backward-compatible with 0.13 snapshots and existing histories. Update the save adapters alongside changes to snapshot validation and restoration. Tests must cover real invariants, branch ownership and persistence/retry behavior.

Explicit manual generation uses a separate coordinator with `manualModules`, restricted to characters, inventory, relationships, scene, journal and status. Status is update-only in the generation service, requires explicit chat floors, and permits only absolute `set-field` operations on existing typed fields. Its manual coordinator also enforces `set-field` plus the status module’s enabled/read/write policy, even when the background master is off. This scope is copied at construction, cannot change background settings or capture normal chat generations, and still validates every returned patch and reference. The generation service enforces mode, selected sources and permitted actions before staging. Manual confirmation appends the same persistence ledger without enabling background linkage.
