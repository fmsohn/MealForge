/**
 * db.js — PrepVault IndexedDB layer via Dexie.
 * Uses CDN so Dexie loads when the static server does not serve node_modules
 * (e.g. Live Server). Matches package.json dexie ^3.2.4.
 */

import Dexie from 'https://cdn.jsdelivr.net/npm/dexie@3/dist/dexie.mjs';
import { parseIngredient, toNumericQuantity } from '../utils/recipeUtils.js';

/** Sanitize quantity to Number before save; throw if invalid. */
function ensureNumericQuantity(quantity) {
  const numericQty = parseFloat(String(quantity).replace(/\s+/g, ''));
  if (Number.isNaN(numericQty)) throw new Error('Invalid quantity: ' + quantity);
  return numericQty;
}

const db = new Dexie('PrepVaultDB');

db.version(1).stores({
  recipes: '++id, name, ingredients, url',
  schedule: '++id, weekStart, items',
  groceryList: '++id, planId, items',
});

db.version(2)
  .stores({
    recipes: '++id, name, ingredients, url',
    schedule: '++id, weekStart, items',
    groceryList: '++id, planId, items',
    planner: 'date',
    settings: 'key',
  })
  .upgrade((tx) => {
    return tx
      .table('recipes')
      .toCollection()
      .modify((recipe) => {
        if (!Array.isArray(recipe.tags)) recipe.tags = [];
      });
  });

/**
 * Deletes a recipe and any planner entries that reference it, in a single readwrite transaction.
 * @param {number} recipeId - Primary key of the recipe to delete
 * @returns {Promise<void>}
 */
export async function deleteRecipeCascade(recipeId) {
  await db.transaction('rw', db.recipes, db.planner, async () => {
    await db.recipes.delete(recipeId);
    const plannerRows = await db.planner.toArray();
    for (const row of plannerRows) {
      const entries = Array.isArray(row.entries)
        ? row.entries.filter((e) => e.recipeId !== recipeId)
        : [];
      if (entries.length === 0) {
        await db.planner.delete(row.date);
      } else {
        await db.planner.put({ date: row.date, entries });
      }
    }
  });
}

/** Normalize unit for grouping (e.g. cups/cup -> cup). Uses canonical form before aggregation. */
function canonicalUnit(unit) {
  const u = (unit || '').trim().toLowerCase();
  const map = {
    cups: 'cup',
    tablespoons: 'tablespoon',
    tbsp: 'tablespoon',
    teaspoons: 'teaspoon',
    tsp: 'teaspoon',
    ounces: 'ounce',
    oz: 'ounce',
    pounds: 'pound',
    lb: 'pound',
    grams: 'gram',
    cloves: 'clove',
    pinches: 'pinch',
    cans: 'can',
    slices: 'slice',
    stalks: 'stalk',
  };
  return map[u] || u;
}

/**
 * True if the item was added manually by the user (not from planner aggregation).
 * Used by reconciliation to preserve manual items when syncing.
 * @param {{ origin?: string }} item
 * @returns {boolean}
 */
export function isManualItem(item) {
  return item != null && item.origin === 'manual';
}

function itemKey(item) {
  const ing = (item.ingredient || '').trim().toLowerCase();
  const u = canonicalUnit(item.unit || '');
  return `${ing}\0${u}`;
}

/**
 * Generates a shopping list with reconciliation: build master requirements from the plan,
 * then sync with existing list (update recipe quantities, add new, remove no-longer-in-plan;
 * preserve manual and bought items).
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @returns {Promise<void>}
 */
export async function generateShoppingList(startDate, endDate) {
  const planId = `${startDate}_${endDate}`;

  function newItemId() {
    return `item-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  // Step A: Master Requirement Map — aggregate from planner entries, scaling each entry by its multiplier (canonicalUnit for keys)
  const plannerRows = await db.planner
    .where('date')
    .between(startDate, endDate, true, true)
    .toArray();

  const masterRequirementMap = new Map();
  for (const row of plannerRows) {
    const entries = Array.isArray(row.entries) ? row.entries : [];
    for (const entry of entries) {
      if (entry == null || entry.recipeId == null) continue;
      const recipe = await db.recipes.get(entry.recipeId);
      if (!recipe || !Array.isArray(recipe.ingredients)) continue;
      const scale = Math.max(1, Math.min(3, Number(entry.scale) || 1));
      for (const line of recipe.ingredients) {
        const parsed = parseIngredient(typeof line === 'string' ? line : String(line));
        const baseQ = toNumericQuantity(parsed.quantity ?? 0);
        const endQ = Number.isFinite(parsed.quantityEnd) ? toNumericQuantity(parsed.quantityEnd) : baseQ;
        const q = ((baseQ + endQ) / 2) * scale;
        const ingKey = (parsed.ingredient || '').trim().toLowerCase();
        const unitKey = canonicalUnit(parsed.unit);
        const key = `${ingKey}\0${unitKey}`;
        const existing = masterRequirementMap.get(key);
        if (existing) {
          existing.quantity += q;
        } else {
          masterRequirementMap.set(key, {
            quantity: q,
            unit: parsed.unit || '',
            ingredient: parsed.ingredient || '',
          });
        }
      }
    }
  }

  // Step B: Fetch existing list for this planId
  const existingRecord = await db.groceryList.where('planId').equals(planId).first();
  const existingItems = Array.isArray(existingRecord?.items) ? existingRecord.items : [];
  const existingByKey = new Map();
  for (const item of existingItems) {
    existingByKey.set(itemKey(item), item);
  }

  // Step C: Reconcile — update/add recipe items from master; preserve manual and bought
  const reconciled = [];

  for (const [, req] of masterRequirementMap) {
    if (req.quantity <= 0) continue;
    const key = itemKey(req);
    const existingItem = existingByKey.get(key);
    const quantity = ensureNumericQuantity(Math.round(req.quantity * 1000) / 1000);
    reconciled.push({
      id: existingItem?.id ?? newItemId(),
      quantity,
      unit: req.unit,
      ingredient: req.ingredient,
      status: existingItem?.status === 'bought' ? 'bought' : 'pending',
      origin: 'recipe',
    });
  }

  for (const item of existingItems) {
    if (isManualItem(item)) {
      reconciled.push({ ...item, origin: 'manual', quantity: ensureNumericQuantity(item.quantity ?? 0) });
      continue;
    }
    const key = itemKey(item);
    if (masterRequirementMap.has(key)) continue; // already added from plan
    if (item.status === 'bought') {
      reconciled.push({ ...item, origin: item.origin || 'recipe', quantity: ensureNumericQuantity(item.quantity ?? 0) });
    }
  }

  await db.transaction('rw', db.groceryList, async () => {
    if (existingRecord != null) {
      await db.groceryList.update(existingRecord.id, { items: reconciled });
    } else {
      await db.groceryList.add({ planId, items: reconciled });
    }
  });
}

/**
 * Deletes the entire grocery list record for the given planId from IndexedDB.
 * @param {string} planId - e.g. startDate_endDate
 * @returns {Promise<void>}
 */
export async function deleteShoppingList(planId) {
  const record = await db.groceryList.where('planId').equals(planId).first();
  if (record != null) {
    await db.groceryList.delete(record.id);
  }
}

/**
 * Toggles a grocery list item's status (pending <-> bought) and persists to IndexedDB.
 * @param {string} planId - planId of the grocery list record
 * @param {string} itemId - id of the item within items[]
 * @param {'pending'|'bought'} newStatus
 * @returns {Promise<void>}
 */
export async function toggleItemStatus(planId, itemId, newStatus) {
  const record = await db.groceryList.where('planId').equals(planId).first();
  if (!record || !Array.isArray(record.items)) return;
  const items = record.items.map((item) =>
    item.id === itemId ? { ...item, status: newStatus } : item
  );
  await db.groceryList.update(record.id, { items });
}

/**
 * Removes all items with status 'bought' from the grocery list for the given planId.
 * @param {string} planId
 * @returns {Promise<void>}
 */
export async function clearBoughtItems(planId) {
  const record = await db.groceryList.where('planId').equals(planId).first();
  if (!record || !Array.isArray(record.items)) return;
  const items = record.items.filter((item) => item.status !== 'bought');
  await db.groceryList.update(record.id, { items });
}

export { db };
