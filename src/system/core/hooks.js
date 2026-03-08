import { Changelog } from "$changelog/changelog.js";
import { handleHotbarDrop } from "@components/macros/macros.js";
import { FBLRoll, FBLRollHandler } from "@components/roll-engine/engine.js";
import { adventureSiteCreateDialog } from "@journal/adventure-sites/adventure-site-generator.js";
import { registerDiceSoNice } from "../../external-api/dice-so-nice.js";
import t from "$utils/localize-string.js";

const FLAG_SCOPE = "forbidden-lands";

function getAttackState(message) {
	return message.getFlag(FLAG_SCOPE, "attackState") || {};
}

function applyAttackStateToRoll(message, roll) {
	const state = getAttackState(message);
	return foundry.utils.mergeObject(roll.options, state, { inplace: true });
}

async function saveAttackState(message, roll) {
	const state = getAttackStatePayload(roll);
	return message.setFlag(FLAG_SCOPE, "attackState", state);
}

function getAttackStatePayload(roll) {
	return {
		attackApplied: !!roll.options.attackApplied,
		defenseUsed: !!roll.options.defenseUsed,
		defenseSuccess: Number(roll.options.defenseSuccess || 0),
		defenseType: roll.options.defenseType || null,
		armorUsed: !!roll.options.armorUsed,
		armorSuccess: Number(roll.options.armorSuccess || 0),
		armorFailure: Number(roll.options.armorFailure || 0),
		targetTokenId: roll.options.targetTokenId || null,
		targetSceneId: roll.options.targetSceneId || null,
	};
}

function isActiveGM() {
	const activeGM = game.users?.activeGM;
	if (!game.user?.isGM) return false;
	return !activeGM || activeGM.id === game.user.id;
}

function requestGMAttackStateUpdate(messageId, state) {
	game.socket.emit("system.forbidden-lands", {
		operation: "updateAttackState",
		id: messageId,
		state,
	});
}

async function persistAttackMessageState(message, roll) {
	const state = getAttackStatePayload(roll);
	if (message.isOwner) {
		await saveAttackState(message, roll);
		await refreshAttackMessage(message, roll);
		return;
	}
	requestGMAttackStateUpdate(message.id, state);
}

async function refreshAttackMessage(message, roll) {
	const content = await roll.render();
	await message.update({ content });
}

function getTargetFromRollOptions(roll) {
	const tokenId = roll?.options?.targetTokenId;
	if (!tokenId) return null;
	const sceneId = roll?.options?.targetSceneId;
	const scene = sceneId ? game.scenes.get(sceneId) : null;
	const tokenDoc = scene?.tokens?.get(tokenId);
	const sceneToken = tokenDoc?.object;
	if (sceneToken) return sceneToken;
	return canvas.tokens?.get(tokenId) || null;
}

function getAttackTarget(message, roll = message.rolls?.[0]) {
	const optionTarget = getTargetFromRollOptions(roll);
	if (optionTarget?.actor) return optionTarget.actor;

	const author =
		message.author ||
		game.users.get(message._source?.author) ||
		game.users.get(message.user?.id) ||
		game.users.get(message.user);
	if (!author) return null;

	const targetRef = Array.from(author.targets || [])[0] || null;
	if (!targetRef) return null;

	// UserTargets can hold token objects or token ids depending on context/version.
	const targetToken =
		typeof targetRef === "string" ? canvas.tokens?.get(targetRef) : targetRef;
	return targetToken?.actor || null;
}

function canCurrentUserUseAttackActions(message, roll) {
	const targetActor = getAttackTarget(message, roll);
	return !!targetActor?.isOwner;
}

function getAttackItem(roll) {
	const attacker = game.actors.get(roll.options.actorId);
	if (!attacker) return null;
	const itemId = Array.isArray(roll.options.itemId)
		? roll.options.itemId[0]
		: roll.options.itemId;
	if (!itemId) return null;
	return attacker.items.get(itemId) || null;
}

function isRangedAttack(roll) {
	const optionCategory = String(roll?.options?.attackCategory || "")
		.toLowerCase()
		.trim();
	if (optionCategory.includes("ranged")) return true;

	const item = getAttackItem(roll);
	const itemCategory = String(item?.system?.category || "")
		.toLowerCase()
		.trim();
	return item?.type === "weapon" && itemCategory.includes("ranged");
}

function hasEquippedShield(actor) {
	return actor.items.some((item) => {
		if (item.state !== "equipped") return false;
		if (item.type === "armor" && item.system?.part === "shield") return true;
		return !!item.system?.features?.shield;
	});
}

function getParryItem(actor) {
	return (
		actor.items.find(
			(item) =>
				item.state === "equipped" &&
				item.type === "weapon" &&
				item.system?.category === "melee" &&
				item.system?.features?.parrying,
		) || null
	);
}

async function postRollWarning(localizationKey) {
	return ChatMessage.create({
		content: `<div class="forbidden-lands chat-item"><p>${game.i18n.localize(
			localizationKey,
		)}</p></div>`,
	});
}

function getDamageAttribute(actor, damageType = "other") {
	const type = String(damageType || "").toLowerCase();
	if (type === "empathy") return "empathy";
	if (type === "wits" || type === "fear") return "wits";
	if (type === "endurance") return "agility";
	if (["stab", "slash", "blunt", "fire", "non-typical", "other"].includes(type))
		return "strength";
	return null;
}

function getCriticalInjuryTableByDamageType(damageType = "blunt") {
	const type = String(damageType || "").toLowerCase();
	if (type === "stab" || type === "stabbing")
		return "Critical Injuries - Stab Wounds";
	if (type === "slash" || type === "slashing")
		return "Critical Injuries - Slash Wounds";
	if (type === "blunt") return "Critical Injuries - Blunt Wounds";
	return null;
}

async function tryRunRollOnTable(tableName) {
	try {
		if (typeof globalThis.rollOnTable === "function") {
			await globalThis.rollOnTable(tableName);
			return true;
		}
	} catch (error) {
		console.warn("Forbidden Lands | rollOnTable global call failed", error);
	}

	const macro = game.macros?.getName("rollOnTable");
	if (macro) {
		try {
			await macro.execute(tableName);
			return true;
		} catch (_error) {
			try {
				await macro.execute({ table: tableName, tableName });
				return true;
			} catch (error) {
				console.warn("Forbidden Lands | rollOnTable macro call failed", error);
			}
		}
	}

	try {
		const table = game.tables?.getName(tableName);
		if (!table) return false;
		await table.draw({ displayChat: true });
		return true;
	} catch (error) {
		console.warn("Forbidden Lands | direct table draw failed", error);
		return false;
	}
}

async function tryTriggerTraumaTable(actor, attribute, damageType) {
	const currentValue = Number(actor.system?.attribute?.[attribute]?.value ?? 0);
	if (currentValue > 0) return;

	if (attribute === "wits") {
		await tryRunRollOnTable("Horror Trauma");
		return;
	}

	if (attribute !== "strength") return;
	const tableName = getCriticalInjuryTableByDamageType(damageType);
	if (!tableName) return;
	await tryRunRollOnTable(tableName);
}

function getDefenseSourceRoll(roll) {
	if (roll.options?.linkedDefenseType === "armor")
		return {
			success: Number(roll.successCount || 0),
			failure: Number(roll.gearDamage || roll.baneCount || 0),
		};
	if (roll.options?.linkedDefenseType === "dodge")
		return { success: Number(roll.successCount || 0), failure: 0 };
	if (roll.options?.linkedDefenseType === "parry")
		return { success: Number(roll.successCount || 0), failure: 0 };
	return null;
}

async function syncLinkedAttackFromDefenseRoll(defenseRoll) {
	const linkedAttackMessageId = defenseRoll.options?.linkedAttackMessageId;
	if (!linkedAttackMessageId) return;
	const attackMessage = game.messages.get(linkedAttackMessageId);
	if (!attackMessage) return;
	const attackRoll = attackMessage.rolls?.[0];
	if (!attackRoll?.options?.isAttack) return;

	applyAttackStateToRoll(attackMessage, attackRoll);
	const source = getDefenseSourceRoll(defenseRoll);
	if (!source) return;

	switch (defenseRoll.options.linkedDefenseType) {
		case "armor":
			attackRoll.options.armorUsed = true;
			attackRoll.options.armorSuccess = source.success;
			attackRoll.options.armorFailure = source.failure;
			break;
		case "dodge":
		case "parry":
			attackRoll.options.defenseUsed = true;
			attackRoll.options.defenseType = defenseRoll.options.linkedDefenseType;
			attackRoll.options.defenseSuccess = source.success;
			break;
	}

	await persistAttackMessageState(attackMessage, attackRoll);
}

async function applyAttackArmorDamage(targetActor, roll) {
	if (targetActor.type === "monster") return;
	const armorFailure = Number(roll.options?.armorFailure || 0);
	if (!armorFailure) return;
	if (roll.attackSuccess <= 0) return;
	await applyArmorFailureDamage(targetActor, armorFailure);
}

async function applyDamageToTarget(actor, roll) {
	if (Number(roll.attackSuccess || 0) <= 0) return;
	const damage = Number(roll.damage || 0);
	const attribute = getDamageAttribute(actor, roll.options.damageType);

	if (!damage) return;
	if (!attribute) {
		await postRollWarning("ROLL.WARNING_INVALID_DAMAGE_TYPE");
		return;
	}
	if (
		!actor.system?.attribute ||
		!(attribute in actor.system.attribute) ||
		typeof actor.system.attribute?.[attribute]?.value !== "number"
	) {
		await postRollWarning("ROLL.WARNING_INVALID_DAMAGE_ATTRIBUTE");
		return;
	}

	const currentValue = Number(actor.system?.attribute?.[attribute]?.value ?? 0);
	const newValue = Math.max(currentValue - damage, 0);
	await actor.update({ [`system.attribute.${attribute}.value`]: newValue });

	// Trigger trauma table only when the attribute has just reached zero.
	if (currentValue > 0 && newValue <= 0) {
		await tryTriggerTraumaTable(actor, attribute, roll.options.damageType);
	}
}

async function rollTargetDefense(actor, type, attackMessageId, itemId = null) {
	const result = await actor.sheet.rollAction(type, itemId);
	if (result?.roll) {
		result.roll.options.linkedAttackMessageId = attackMessageId;
		result.roll.options.linkedDefenseType = type;
		await result.message?.update({ content: await result.roll.render() });
	}
	return result;
}

async function rollTargetArmor(actor, attackMessageId) {
	if (actor.type !== "monster") {
		const result = await actor.sheet.rollArmor();
		if (result?.roll) {
			result.roll.options.linkedAttackMessageId = attackMessageId;
			result.roll.options.linkedDefenseType = "armor";
			await result.message?.update({ content: await result.roll.render() });
		}
		return result;
	}

	const armor = Number(actor.system?.armor?.value || 0);
	const rollName = `${game.i18n.localize("ITEM.TypeArmor")}: ${actor.name}`;
	const options = {
		name: rollName,
		maxPush: "0",
		...actor.getRollContext(),
	};

	const roll = FBLRoll.create(`${armor}dg[${rollName}]`, {}, options);
	await roll.roll();
	const message = await roll.toMessage();
	roll.options.linkedAttackMessageId = attackMessageId;
	roll.options.linkedDefenseType = "armor";
	await message.update({ content: await roll.render() });
	return { roll, message };
}

function getAuthorSelectedTargetToken(message) {
	const author =
		message.author ||
		game.users.get(message._source?.author) ||
		game.users.get(message.user?.id) ||
		game.users.get(message.user);
	if (!author) return null;
	const targetRef = Array.from(author.targets || [])[0] || null;
	if (!targetRef) return null;
	return typeof targetRef === "string" ? canvas.tokens?.get(targetRef) : targetRef;
}

async function ensureAttackTargetOnRoll(message, roll) {
	if (roll.options?.targetTokenId) return;
	const targetToken = getAuthorSelectedTargetToken(message);
	if (!targetToken) return;
	roll.options.targetTokenId = targetToken.id;
	roll.options.targetSceneId = targetToken.scene?.id || canvas.scene?.id || null;
	await persistAttackMessageState(message, roll);
}

async function applyArmorFailureDamage(actor, amount) {
	let remaining = Number(amount || 0);
	if (remaining <= 0) return;

	const priorities = { body: 0, head: 1 };
	const armorItems = actor.itemTypes.armor
		.filter((item) => {
			const part = item.system?.part;
			return (
				item.state === "equipped" &&
				(part === "body" || part === "head") &&
				(item.system?.bonus?.value ?? 0) > 0
			);
		})
		.sort((a, b) => priorities[a.system.part] - priorities[b.system.part]);

	const updates = [];
	for (const item of armorItems) {
		if (remaining <= 0) break;
		const value = Number(item.system?.bonus?.value || 0);
		const loss = Math.min(remaining, value);
		remaining -= loss;
		updates.push({
			_id: item.id,
			"system.bonus.value": value - loss,
		});
	}

	if (updates.length) {
		await actor.updateEmbeddedDocuments("Item", updates);
	}
}

/**
 * Registers all hooks that are not 'init' or 'ready'
 */
export default function registerHooks() {
	// Sockets
	game.socket.on("system.forbidden-lands", async (data) => {
		if (data.operation === "pushRoll" && data.isOwner)
			game.messages.get(data.id)?.delete();
		if (data.operation === "updateAttackState") {
			if (!isActiveGM()) return;
			const message = game.messages.get(data.id);
			const roll = message?.rolls?.[0];
			if (!message || !roll?.options?.isAttack) return;
			applyAttackStateToRoll(message, roll);
			foundry.utils.mergeObject(roll.options, data.state || {}, {
				inplace: true,
			});
			await saveAttackState(message, roll);
			await refreshAttackMessage(message, roll);
		}
	});

	Hooks.once("diceSoNiceReady", (dice3d) => {
		registerDiceSoNice(dice3d);
	});

	Hooks.on("yzeCombatReady", () => {
		if (game.settings.get("forbidden-lands", "configuredYZEC")) return;
		try {
			game.settings.set("yze-combat", "resetEachRound", false);
			game.settings.set("yze-combat", "slowAndFastActions", true);
			game.settings.set("yze-combat", "initAutoDraw", true);
			game.settings.set("yze-combat", "duplicateCombatantOnCombatStart", true);
			game.settings.set(
				"yze-combat",
				"actorSpeedAttribute",
				"system.movement.value",
			);
			game.settings.set("forbidden-lands", "configuredYZEC", true);
		} catch (e) {
			console.error("Could not configure YZE Combat", e);
		}
	});

	Hooks.on("renderGamePause", (_, html, options) => {
		const imgElement = html.querySelector("img");
		const caption = html.querySelector("figcaption");

		html.style.height = `${80 + 150}px`;
		html.style.top = `calc(50vh - ${100 + 0.5 * 150}px)`;
		html.style.background = "none";
		imgElement.src = "systems/forbidden-lands/assets/fbl-sun.webp";
		imgElement.style.opacity = 0.8;
		imgElement.style.width = "150px";
		imgElement.style.height = "150px";
		imgElement.style.cssText += "--fa-animation-duration: 5s";
		caption.innerText = "Game Paused";
		caption.style.color = "#EEEEEE";
		caption.style["text-transform"] = "uppercase";
		caption.style["font-size"] = "1.75em";
		caption.style["text-shadow"] = "0px 0px 20px #000000";
	});

	/**
	 * Registers a custom chat command that lets us listen for either "/fblroll" or "/fblr".
	 * The commands take arguments like "2db" or "4ds"
	 */
	Hooks.on("chatMessage", (_html, content, _msg) => {
		const commandR = /^\/fblr(?:oll)?/i;
		if (content.match(commandR)) {
			const diceR = /(\d+d(?:[bsng]|8|10|12))/gi;
			// eslint-disable-next-line no-unused-vars
			const dice = content.match(diceR);
			const data = {
				attribute: { label: "DICE.BASE", value: 0 },
				skill: { label: "DICE.SKILL", value: 0 },
				gear: { label: "DICE.GEAR", value: 0, artifactDie: "" },
			};
			const options = {
				modifiers: [],
			};
			if (dice) {
				for (const term of dice) {
					const [num, deno] = term.split("d");
					const map = {
						b: "attribute",
						s: "skill",
						g: "gear",
						n: "negative",
					};
					if (map[deno] === "negative")
						options.modifiers.push({ value: -Number(num), active: true });
					else if (map[deno]) data[map[deno]].value += Number(num);
					else data.gear.artifactDie += term;
				}
			}
			FBLRollHandler.createRoll(data, options);
			return false;
		}
		return true;
	});

	if (game.settings.get("forbidden-lands", "collapseSheetHeaderButtons"))
		for (const hook of [
			"renderItemSheet",
			"renderActorSheet",
			"renderJournalSheet",
			"renderApplication",
		]) {
			Hooks.on(hook, (_app, html) => {
				html
					.find(".char-gen")
					?.html(
						`<i class="fas fa-leaf" data-tooltip="${game.i18n.localize(
							"SHEET.HEADER.CHAR_GEN",
						)}"></i>`,
					);
				html
					.find(".rest-up")
					?.html(
						`<i class="fas fa-bed" data-tooltip="${game.i18n.localize(
							"SHEET.HEADER.REST",
						)}"></i>`,
					);
				html
					.find(".custom-roll")
					?.html(
						`<i class="fas fa-dice" data-tooltip="${game.i18n.localize(
							"SHEET.HEADER.ROLL",
						)}"></i>`,
					);
				html
					.find(".configure-sheet")
					?.html(
						`<i class="fas fa-cog" data-tooltip="${game.i18n.localize(
							"SHEET.CONFIGURE",
						)}"></i>`,
					);
				html
					.find(".configure-token")
					?.html(
						`<i class="fas fa-user-circle" data-tooltip="${game.i18n.localize(
							"SHEET.TOKEN",
						)}"></i>`,
					);
				html
					.find(".item-post")
					?.html(
						`<i class="fas fa-comment" data-tooltip="${game.i18n.localize(
							"SHEET.HEADER.POST_ITEM",
						)}"></i>`,
					);
				html
					.find(".share-image")
					?.html(
						`<i class="fas fa-eye" data-tooltip="${game.i18n.localize(
							"JOURNAL.ActionShow",
						)}"></i>`,
					);
				html
					.find(".close")
					?.html(
						`<i class="fas fa-times" data-tooltip="${game.i18n.localize(
							"SHEET.CLOSE",
						)}"></i>`,
					);
			});
		}

	/**
	 * Localize header buttons on Item Sheets and Actor Sheets.
	 * These are hardcoded in English in Foundry. Bad practice. Thus we fix.
	 */
	Hooks.on("renderItemSheet", (app) => {
		app._element[0].style.height = "auto";
	});

	Hooks.on("renderActorSheet", (app, html) => {
		if (app.actor.system.type === "party")
			app._element[0].style.height = "auto";

		if (app.cellId?.match(/#gm-screen.+/)) {
			const buttons = html.find("button");
			buttons.each((_i, button) => {
				button.disabled = false;
			});
		}
	});

	Hooks.on("renderJournalSheet", (app, html) => {
		if (app.document.flags["forbidden-lands"]?.isBook) {
			html.addClass("fbl-book");
		}
	});

	Hooks.on("renderChatMessageHTML", (message, htmlElement, data) => {
		const attackRoll = message.rolls?.[0];
		if (attackRoll?.options?.isAttack) {
			applyAttackStateToRoll(message, attackRoll);
			void ensureAttackTargetOnRoll(message, attackRoll);
		}

		// 1. Handle click-to-toggle on the entire roll container
		const roll = htmlElement.querySelector(".fbl-chat-roll");
		if (roll) {
			roll.addEventListener("click", (ev) => {
				// Ignore clicks on interactive buttons
				if (ev.target.closest(".fbl-button")) return;

				const details = roll.querySelector(".fbl-roll-details");
				if (details) details.hidden = !details.hidden;
			});
		}

		// 2. Handle item drag
		const postedItem = htmlElement.querySelector(".chat-item");
		if (postedItem) {
			postedItem.classList.add("draggable");
			postedItem.setAttribute("draggable", "true");

			postedItem.addEventListener("dragstart", (ev) => {
				const itemData = message.getFlag("forbidden-lands", "itemData");
				ev.dataTransfer.setData(
					"text/plain",
					JSON.stringify({
						item: itemData,
						type: "itemDrop",
					}),
				);
			});
		}

		// 3. Handle push button
		const pushButton = htmlElement.querySelector(".fbl-button.push");
		if (pushButton) {
			pushButton.addEventListener("click", async (ev) => {
				ev.stopPropagation();

				if (message.rolls[0]?.pushable) {
					const pushedMessage = await FBLRollHandler.pushRoll(message);
					const pushedRoll = pushedMessage?.rolls?.[0];
					if (pushedRoll?.options?.linkedAttackMessageId) {
						await syncLinkedAttackFromDefenseRoll(pushedRoll);
					}

					const fireEvent = () => {
						if (message.permission === CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)
							message.delete();
						else
							game.socket.emit("system.forbidden-lands", {
								operation: "pushRoll",
								isOwner: message.roll?.isOwner,
								id: message.id,
							});
					};

					if (game.modules.get("dice-so-nice")?.active)
						Hooks.once("diceSoNiceRollComplete", fireEvent);
					else fireEvent();
				}
			});
		}

		// 4. Handle mishap/prey table button
		const tableButton = htmlElement.querySelector(".fbl-button.table");
		if (tableButton) {
			tableButton.addEventListener("click", async (ev) => {
				ev.stopPropagation();

				let table;

				if (tableButton.dataset.action === "prey") {
					const tables = game.settings.get("forbidden-lands", "otherTables");
					table = game.tables.get(tables["travel-find-prey"]);
				} else {
					table = game.tables.get(tableButton.dataset.id);
				}

				if (table) {
					table.draw({ displayChat: true });
				} else {
					ui.notifications?.warn("Could not find mishap table");
				}
			});
		}

		// 5. Handle attack action buttons
		const attackButtons = htmlElement.querySelectorAll(".fbl-button.attack-action");
		if (attackButtons.length) {
			if (!canCurrentUserUseAttackActions(message, attackRoll)) {
				attackButtons.forEach((button) => button.remove());
				return;
			}

			attackButtons.forEach((button) =>
				button.addEventListener("click", async (ev) => {
					ev.stopPropagation();

					try {
						const roll = message.rolls?.[0];
						if (!roll?.options?.isAttack) return;
						applyAttackStateToRoll(message, roll);
						await ensureAttackTargetOnRoll(message, roll);

						const action = button.dataset.action;
						const targetActor = getAttackTarget(message, roll);
						if (!targetActor) {
							await postRollWarning("ROLL.WARNING_NO_TARGET");
							return;
						}
						if (!targetActor.isOwner) {
							await postRollWarning("ROLL.WARNING_NOT_TARGET_OWNER");
							return;
						}

						switch (action) {
							case "apply-damage":
								if (roll.options.attackApplied) return;
								if (Number(roll.attackSuccess || 0) <= 0) return;
								await applyDamageToTarget(targetActor, roll);
								await applyAttackArmorDamage(targetActor, roll);
								roll.options.attackApplied = true;
								break;

							case "defense-dodge": {
								if (roll.options.defenseUsed) return;
								const result = await rollTargetDefense(
									targetActor,
									"dodge",
									message.id,
								);
								if (!result?.roll) return;
								roll.options.defenseUsed = true;
								roll.options.defenseType = "dodge";
								roll.options.defenseSuccess = Number(
									result.roll.successCount || 0,
								);
								break;
							}

							case "defense-parry": {
								if (roll.options.defenseUsed) return;

								if (isRangedAttack(roll) && !hasEquippedShield(targetActor)) {
									await postRollWarning(
										"ROLL.WARNING_PARRY_NO_SHIELD_RANGED",
									);
									return;
								}

								const parryItem = getParryItem(targetActor);
								if (!parryItem) {
									await postRollWarning("ROLL.WARNING_PARRY_NO_WEAPON");
									return;
								}

								const result = await rollTargetDefense(
									targetActor,
									"parry",
									message.id,
									parryItem.id,
								);
								if (!result?.roll) return;
								roll.options.defenseUsed = true;
								roll.options.defenseType = "parry";
								roll.options.defenseSuccess = Number(
									result.roll.successCount || 0,
								);
								break;
							}

							case "defense-armor": {
								if (roll.options.armorUsed) return;
								const armorResult = await rollTargetArmor(
									targetActor,
									message.id,
								);
								if (!armorResult?.roll) return;
								const armorSuccess = Number(armorResult.roll.successCount || 0);
								const armorFailure = Number(
									armorResult.roll.gearDamage ||
										armorResult.roll.baneCount ||
										0,
								);
								roll.options.armorUsed = true;
								roll.options.armorSuccess = armorSuccess;
								roll.options.armorFailure = armorFailure;
								break;
							}

							default:
								return;
						}

						await persistAttackMessageState(message, roll);
					} catch (error) {
						console.error("Forbidden Lands | Attack action failed", error);
						await postRollWarning("ROLL.WARNING_ACTION_FAILED");
					}
				}),
			);
		}
	});

	/**
	 * GM screen module causes buttons in Actor sheets to disable.
	 * Undo this, so its possible to roll Attributes, Skills, etc. from GM Screen.
	 */
	Hooks.on("gmScreenOpenClose", (app, _config) => {
		const html = app.element;
		const buttons = html.find("button");
		buttons.each((_i, button) => {
			button.disabled = false;
		});
	});

	Hooks.on("hotbarDrop", async (_, data, slot) => handleHotbarDrop(data, slot));

	Hooks.on("activateAbstractSidebarTab", (app) => {
		if (app.id !== "settings") return;

		const section = $(app.element).find("section.documentation h4");
		const button = $(
			`<button type="button"><i class='fas fa-book'></i> ${game.i18n.localize(
				"CONFIG.CHANGELOG",
			)}</button>`,
		);

		button.on("click", (ev) => {
			ev.preventDefault();
			new Changelog().render(true);
		});

		section.after(button);
	});

	Hooks.on("renderJournalDirectory", (app) => {
		const header = app.element.querySelector(".header-actions");
		if (!header || header.querySelector("#create-adventure-site")) return;

		const button = document.createElement("button");
		button.id = "create-adventure-site";
		button.innerHTML = `<i class="fas fa-castle"></i> ${t("ADVENTURE_SITE.BUTTON.CREATE")}`;
		button.addEventListener("click", () => adventureSiteCreateDialog());

		header.appendChild(button);
	});

	Hooks.on("renderJournalEntrySheet", (app, html, doc) => {
		const type = doc.document.getFlag("forbidden-lands", "adventureSiteType");
		const isDungeon = ["dungeon", "ice_cave", "elven_ruin"].includes(type);
		if (!isDungeon || !game.user.isGM) return;

		const button = $(
			`<button type="button" class="create" data-action="add-room"><i class="fas fa-plus-circle"></i> ${t("ADVENTURE_SITE.ADD_ROOM")}</button>`,
		);

		button.on("click", async () => {
			const path = CONFIG.fbl.adventureSites.types[type];
			const room = await CONFIG.fbl.adventureSites?.generate(
				path,
				`${type}_rooms`,
			);
			const pageName = $(room)
				.find("h4, strong")
				?.first()
				.text()
				.replace(/[^\p{L}]+/u, " ")
				.trim();
			await doc.document.createEmbeddedDocuments("JournalEntryPage", [
				{
					name: pageName,
					title: { level: 2, show: false },
					text: { content: `<div class="adventure-site">${room}</div>` },
				},
			]);
		});

		$(html).find('[data-action="createPage"]').after(button);
	});
}
