# Combat System Rework Summary

## 1) Added Features (Simple Overview)

- Added a damage type selector to the attack roll dialog (`Stab`, `Slash`, `Blunt`, `Fire`, `Wits`, `Empathy`, `Endurance`, `Non-typical`) and persisted the selected value in roll data.
- Added damage type display to attack results in chat.
- Added target action buttons to the attack chat card: `Apply Damage`, `Dodge`, `Parry`, `Armor`.
- Added attack success recalculation after defensive rolls (`dodge`, `parry`, `armor`), including support for pushing defensive rolls.
- Added damage application by attribute based on damage type:
- `Stab/Slash/Blunt/Non-typical` -> `Strength`
- `Wits` -> `Wits`
- `Empathy` -> `Empathy`
- `Endurance` -> `Agility`
- Added a rule: if recalculated attack successes become `0`, the `Apply Damage` button is hidden and no damage is applied.
- Added a rule: after pressing `Apply Damage`, all combat buttons are hidden, including `Push`.
- Added target ownership checks: combat buttons are only available to users with `owner` permission on the target.
- Added parry restrictions:
- ranged attacks can only be parried if the target has an equipped shield;
- parry is only allowed using an equipped melee weapon with the `parrying` feature, otherwise it is blocked.
- Added automatic arrows resource-die roll for ranged weapon attacks with `ammo = arrows`.
- Added armor degradation handling: if damage remains after blocking, armor-roll failures reduce armor (body first, then head); monster armor is not reduced.
- Extended the item modifier system:
- added support for `*` and `/` in damage modifiers (for example `*0`, `/2` with rounding up);
- added all damage types as available modifier targets (`Stab`, `Slash`, `Blunt`, `Fire`, `Wits`, `Empathy`, `Endurance`, `Non-typical`).
- Added context-based armor modifiers by attack parameters (damage type, ranged, arrows) through the existing roll-modifier system.
- Added trauma table calls when an attribute drops to `0` after damage:
- when `Strength` drops to `0`: table by damage type (`Blunt/Slash/Stab`);
- when `Wits` drops to `0`: `Horror Trauma` table;
- when `Empathy` or `Agility` drops to `0`: no table is called.
- Armor successes now reduce `damage` (1 success = -1 damage) instead of reducing `attackSuccess`.
- Trauma rolls are now skipped for targets of type `monster` even when health drops to `0`.
- Removed duplicate damage types from selectable lists:
- removed `wits` (use `fear` instead);
- removed `non-typical` (use `other` instead).
- Kept compatibility for legacy values:
- legacy `wits` is treated as `fear`;
- legacy `non-typical` is treated as `other`.
- All new UI labels and warnings were added through i18n (`lang/*.json`) without hardcoded strings.

## 2) Issues Found During Testing and Fixes

- Issue: after pushing `dodge/parry/armor`, successes were not recalculated in the original attack.
- Root cause: no synchronization from the pushed defense roll back to the attack message.
- Fix: added `linkedAttackMessageId/linkedDefenseType` linkage and attack-state synchronization after push.

- Issue: with `attackSuccess = 0`, the `Apply Damage` button was still active and could apply 1 damage.
- Root cause: missing hard validation before applying damage.
- Fix: added a hard guard in damage logic and conditional button rendering only for `attackSuccess > 0`.

- Issue: some buttons stayed visible after damage was applied.
- Root cause: button rendering did not account for a global attack-complete flag.
- Fix: introduced `attackApplied` flag; all attack-action buttons and `Push` are hidden when set.

- Issue: target selected with standard Foundry targeting (`T`) was sometimes not detected.
- Root cause: target was only read from current user state and not persisted in the roll itself.
- Fix: `targetTokenId/targetSceneId` are now saved in roll options/flags and reused for subsequent actions.

- Issue: players could not update a GM-authored attack message after `dodge/parry/armor` (no chat message update rights).
- Root cause: direct message update without ownership rights.
- Fix: added GM proxy flow through `game.socket` (`updateAttackState`) with state application by active GM.

- Issue: ranged parry restriction worked inconsistently.
- Root cause: strict category checks against exact values.
- Fix: made ranged checks robust (using stored attack category with item fallback).

- Issue: automatic arrows roll did not trigger in some attack scenarios.
- Root cause: ranged+arrows detection was not robust across all roll creation paths.
- Fix: expanded item fallback in `handleRollArrows`, added persistent `attackCategory/attackAmmo` in options.

- Issue: it was not possible to define damage modifiers like `*0` or `/2` for immunity/resistance behavior.
- Root cause: old logic only supported numeric `+/-` modifiers.
- Fix: added a dedicated parser/executor for `+/-/*//` expressions with `ceil` behavior for division/fractions.

- Issue: damage types were not selectable in the modifier UI.
- Root cause: select options did not include `ATTACK.*`.
- Fix: added a dedicated damage-type optgroup in the modifiers component.

- Issue: trauma table roll failed when external `rollOnTable` was unavailable.
- Root cause: dependency on external macro/global function only.
- Fix: added fallback to direct `RollTable.draw({ displayChat: true })`.

- Issue: trauma logic for `non-typical/fire` initially defaulted to blunt table.
- Root cause: blunt table was returned as default for all unknown types.
- Fix: strength trauma tables are called only for `blunt/slash/stab`; no table for other types.

- Issue: armor successes were reducing attack successes instead of reducing damage.
- Root cause: `armorSuccess` was subtracted in `attackSuccess` getter.
- Fix: moved armor mitigation to `damage` getter (`-1 damage` per armor success), keeping attack success logic based on attack vs defense only.

- Issue: trauma could still trigger on monsters when attributes dropped to zero.
- Root cause: trauma trigger path did not exclude monster actors.
- Fix: added explicit guard to skip trauma processing for `actor.type === "monster"`.

- Issue: monster attacks always applied damage to `Strength` and damage type was not shown in chat.
- Root cause: monster attack rolls did not pass `damageType` into `roll.options`.
- Fix: `damageType` is now explicitly passed from monster attack item to roll options, with normalization for legacy values.

## 3) Short Technical Implementation Notes

- Damage Type in attacks:
- Added `damageTypeOptions` and `damageType` to the roll dialog flow.
- Selected damage type is written into `roll.options` and serialized into chat rolls.

- Damage type display in chat:
- Added `attack-damage-type` block in `templates/components/roll-engine/roll.hbs`.
- Localization is handled via `damageType` helper and `ATTACK.*` keys.

- Attack chat action buttons:
- Added `apply-damage`, `defense-dodge`, `defense-parry`, `defense-armor` in `roll.hbs`.
- `renderChatMessageHTML` in `src/system/core/hooks.js` binds action handlers.

- Attack recalculation after defense:
- Attack state stores `defenseSuccess`, `armorSuccess`, `armorFailure`, and usage flags.
- Final successes/damage are computed through roll getters (`attackSuccess`, `damage`) with defensive modifiers.
- `attackSuccess` is reduced by defense only; `armorSuccess` reduces `damage` directly.
- Push flow synchronizes linked defense rolls back into the original attack message.

- Visibility and permission constraints:
- Buttons are shown/usable only if current user is owner of the target.
- Added `updateAttackState` socket channel for cross-permission updates via active GM.

- Apply Damage and attack finalization:
- Applies damage to the mapped target attribute.
- Sets `attackApplied=true` after success, hiding all action buttons and `Push`.

- Damage type to attribute mapping:
- Implemented in helper `getDamageAttribute` as `damageType -> attribute`.
- `fear` is mapped to `wits` for character sheet damage application.

- Dodge/Parry/Armor:
- `Dodge` and `Parry` are executed through `actor.sheet.rollAction(...)`.
- `Parry` requires a valid source: melee weapon with `parrying`; ranged parry additionally requires shield.
- `Armor` uses `actor.sheet.rollArmor()` (or monster armor roll), and its successes/failures are propagated to attack state.

- Armor degradation:
- With remaining damage and armor failures, equipped armor `system.bonus.value` is reduced in order body -> head.
- Monster armor degradation is disabled.

- Trauma tables:
- After damage, checks for attribute transition `>0 -> 0`.
- For `Strength`, picks trauma table by damage type (`Blunt/Slash/Stab`); for `Wits`, uses `Horror Trauma`.
- Monster targets are excluded from trauma rolls.
- Table execution order: `globalThis.rollOnTable` -> macro `rollOnTable` -> fallback `game.tables.getName(...).draw`.

- Automatic arrows roll:
- `handleRollArrows` validates character + `ranged` + `arrows`.
- Includes item-source fallback (`itemId`) and persists `attackCategory/attackAmmo` for stable detection.

- UI and styling:
- Added vertical button stack styles and compact damage-type label in chat.
- Reduced button/text sizes by about 20% based on testing feedback.

- Extended roll modifiers for damage and armor:
- Added `ATTACK.*` options in `templates/components/modifiers-component.hbs`.
- Added attack context (`damageType`, `attackCategory`, `attackAmmo`) and final damage computation with target modifiers (`+`, `-`, `*`, `/`) in `src/system/core/hooks.js`.
- Passed additional identifiers into `rollArmor(...)` from `src/actor/actor-sheet.js` and `src/system/core/hooks.js` so conditional modifiers (for example against `stab`/`arrows`) affect armor rolls.

- Monster attack damage-type propagation:
- `src/actor/monster/monster-sheet.js`: `rollSpecificAttack(...)` now sets `options.damageType`.
- `src/components/roll-engine/engine.js`: monster `fear` damage logic now checks `options.damageType` first (with fallback to legacy item field).
