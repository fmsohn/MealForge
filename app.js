console.log('app.js: Loading started');

/**
 * MealForge — offline-first PWA entry point.
 * Uses ES modules; all paths are relative to project root.
 *
 * If you changed asset paths (e.g. /styles → /css), unregister the Service Worker
 * so the browser stops using the old cache: DevTools → Application → Service Workers
 * → Unregister. Then hard refresh (Ctrl+Shift+R / Cmd+Shift+R).
 */

const isStandalone = !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

document.addEventListener('DOMContentLoaded', () => {
  if (!isStandalone) return;
  const btn = document.getElementById('installBtn');
  if (btn) {
    btn.remove();
  }
  const storedTheme = localStorage.getItem('theme') || localStorage.getItem(THEME_STORAGE_KEY) || 'forge';
  applyTheme(storedTheme);
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    try {
      const env = { isSecureContext: window.isSecureContext, origin: window.location.origin };
      console.log('[SW] Environment:', env);
      if (!window.isSecureContext) {
        console.error('SECURE CONTEXT MISSING: Check chrome://flags for http://[YOUR-IP]:5500');
        return;
      }
      const swScope = './';
      console.log('[SW] Registering service-worker.js with scope:', swScope);
      navigator.serviceWorker
        .register('./service-worker.js', { scope: swScope })
        .then((reg) => {
          console.log('[SW] Registration successful, scope:', reg.scope);
        })
        .catch((err) => {
          console.error('[SW] Registration failed, full error:', err);
          console.error('[SW] Registration failed, error.message:', err?.message);
          console.error('[SW] Registration failed, error.stack:', err?.stack);
        });
    } catch (e) {
      console.error('[SW] Registration threw:', e);
      console.error('[SW] error.message:', e?.message);
      console.error('[SW] error.stack:', e?.stack);
    }
  });
}

let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) {
    e.preventDefault();
    return;
  }
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById('installBtn');
  if (btn) {
    btn.classList.remove('is-hidden');
    btn.style.display = '';
  }
});

window.addEventListener('appinstalled', () => {
  const btn = document.getElementById('installBtn');
  if (btn) {
    btn.style.display = 'none';
    btn.classList.add('is-hidden');
  }
});

const THEME_STORAGE_KEY = 'mealforge-theme';

/** theme-color meta values for PWA/browser chrome per theme */
const THEME_META_COLORS = {
  classic: '#ffffff',
  forge: '#1A1A1A',
  midnight: '#050505',
  relaxed: '#F4F1EA',
};

const VALID_THEMES = ['classic', 'forge', 'midnight', 'relaxed'];
export { VALID_THEMES };

export function applyTheme(themeName) {
  const theme = VALID_THEMES.includes(themeName) ? themeName : 'forge';
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.className = (document.documentElement.className || '').replace(/\btheme-\w+\b/g, '').trim();
  document.documentElement.classList.add('theme-' + theme);
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  localStorage.setItem('theme', theme);
  const meta = document.getElementById('meta-theme-color');
  if (meta) meta.setAttribute('content', THEME_META_COLORS[theme] || THEME_META_COLORS.forge);
}

/**
 * Set app theme and persist to localStorage. Delegates to applyTheme.
 * @param {string} themeName - 'classic' | 'forge' | 'midnight' | 'relaxed'
 */
export function setTheme(themeName) {
  applyTheme(themeName);
}

import { extractRecipeFromUrl, parseSelectionHtml } from './modules/parser.js';
import { openSelectionMode } from './modules/selection-mode.js';
import { db, deleteRecipeCascade, generateShoppingList, toggleItemStatus, clearBoughtItems, deleteShoppingList } from './modules/db.js';
import { normalizeIngredientsForStorage } from './utils/recipeUtils.js';
import {
  initUI,
  renderRecipeList,
  renderTagFilters,
  renderPlanner,
  renderShoppingList,
  updateImportProgress,
  openRecipeEdit,
  openAddToPlannerModal,
  openPickRecipeModal,
} from './modules/ui.js';

/** Regex to extract the first http(s) URL from a string (e.g. "Link: https://example.com/recipe") */
const URL_EXTRACT_PATTERN = /(https?:\/\/[^\s]+)/;

/**
 * Extracts the first valid URL (http:// or https://) from input. Use to tolerate prefixes like "URL: " or "Link: ".
 * @param {string} input - Raw input (may contain leading text or extra whitespace)
 * @returns {string} - Extracted URL or the trimmed original if no match
 */
function extractUrlFromInput(input) {
  const trimmed = (input || '').trim();
  const match = trimmed.match(URL_EXTRACT_PATTERN);
  const sanitized = match ? match[1].trim() : trimmed;
  return sanitized;
}

/**
 * Import a recipe from a URL: fetch JSON-LD, normalize, and save to db.recipes.
 * @param {string} url - Full URL of the recipe page
 * @param {{ onProgress?: (percent: number) => void }} [opts] - Optional progress callback (0–100)
 * @returns {Promise<{ id: number, name: string, ingredients: string[], url: string }|{ duplicate: true }|null>}
 */
export async function importNewRecipe(url, opts = {}) {
  const raw = (url || '').trim();
  url = extractUrlFromInput(raw);
  if (raw !== url) {
    console.log('[import] URL sanitized — input:', raw, '→ extracted:', url);
  } else {
    console.log('[import] importNewRecipe called with URL:', url);
  }
  const recipeListEl = document.getElementById('recipe-list');
  console.log('[import] #recipe-list exists:', !!recipeListEl, 'is-hidden:', recipeListEl?.classList?.contains('is-hidden') ?? 'N/A');
  const onProgress = opts.onProgress;
  if (onProgress) onProgress(25);
  const result = await extractRecipeFromUrl(url);
  if (onProgress) onProgress(60);
  if (result && result.status === 'error') {
    console.log('[import] Parser returned error:', result.message);
    return { status: 'error', message: result.message };
  }
  if (result && result.status === 'ambiguous') {
    console.log('[import] Parser returned ambiguous — manual selection available');
    return { status: 'ambiguous', html: result.html };
  }
  const recipes = Array.isArray(result) ? result : [];
  console.log('[import] extractRecipeFromUrl result: array length', recipes.length);
  if (recipes.length === 0) return null;
  const existingByUrl = await db.recipes.where('url').equals(url).toArray();
  const existingNames = new Set((existingByUrl || []).map((r) => r.name));
  const toAdd = recipes.filter((r) => !existingNames.has(r.name));
  if (toAdd.length === 0) return { duplicate: true };
  try {
    const ids = [];
    for (const recipe of toAdd) {
      if (!Array.isArray(recipe.tags)) recipe.tags = [];
      const id = await db.recipes.add(recipe);
      ids.push(id);
    }
    if (onProgress) onProgress(100);
    const first = toAdd[0];
    return { id: ids[0], ...first, addedCount: ids.length };
  } catch (error) {
    console.error('DB Add Failed:', error);
    throw error;
  }
}

const DEFAULT_MEAL_LABELS = ['Breakfast', 'Lunch', 'Dinner'];

/**
 * Reads start/end date from the shopping list date inputs. Use for generating, deleting, or refreshing the list.
 * @returns {{ start: string, end: string }}
 */
function getShoppingDateRange() {
  const startEl = document.getElementById('list-start-date');
  const endEl = document.getElementById('list-end-date');
  return {
    start: (startEl?.value ?? '').trim(),
    end: (endEl?.value ?? '').trim(),
  };
}

/** @returns {Promise<{ mealLabels: string[], tagLibrary: string[] }>} */
async function getSettings() {
  const mealRow = await db.settings.get('mealLabels');
  const tagRow = await db.settings.get('tagLibrary');
  return {
    mealLabels: Array.isArray(mealRow?.value) ? mealRow.value : DEFAULT_MEAL_LABELS.slice(),
    tagLibrary: Array.isArray(tagRow?.value) ? tagRow.value : [],
  };
}

/** Tag filter state: null = All, string = filter by that tag */
let selectedTagFilter = null;

/** Load recipes (optionally filtered by tag), refresh tag filters, and render list. */
async function refreshRecipeList() {
  const [recipes, settings] = await Promise.all([db.recipes.toArray(), getSettings()]);
  let list = recipes;
  if (selectedTagFilter != null) {
    list = list.filter((r) => Array.isArray(r.tags) && r.tags.includes(selectedTagFilter));
  }
  requestAnimationFrame(() => {
    renderTagFilters(settings.tagLibrary, selectedTagFilter, (tag) => {
      selectedTagFilter = tag;
      refreshRecipeList();
    });
  });
  renderRecipeList(list, {
    onShare: (id) => exportSingleRecipe(id),
    onDelete: (id) => deleteRecipe(id),
    onSaveRecipe: (id, data) => updateRecipe(id, data),
    onCancelEdit: () => refreshRecipeList(),
    getTagLibrary: () => settings.tagLibrary,
    onAddToPlanner: (recipe) => addRecipeToPlannerFromCard(recipe),
  });
}

/**
 * Update a recipe's 1x base data (and tags) in the DB and refresh the list.
 * @param {number} id - Recipe primary key
 * @param {{ ingredients?: string[], instructions?: string[], tags?: string[] }} data - Fields to update
 */
async function updateRecipe(id, data) {
  if (Array.isArray(data.ingredients)) {
    data = { ...data, ingredients: normalizeIngredientsForStorage(data.ingredients) };
  }
  await db.recipes.update(id, data);
  await refreshRecipeList();
}

/**
 * Delete a recipe (and any planner entries referencing it) after user confirmation. Refreshes the list on success.
 * @param {number} id - Recipe primary key
 */
async function deleteRecipe(id) {
  if (!confirm('Are you sure you want to delete this recipe?')) return;
  await deleteRecipeCascade(id);
  await refreshRecipeList();
  await refreshPlanner();
}

/**
 * Export full backup: recipes, planner, settings, and groceryList as a single JSON file.
 * Structure: { recipes: [...], planner: [...], settings: [...], groceryList: [...] } for reliable restore.
 * @returns {Promise<void>}
 */
export async function exportCookbook() {
  const [recipes, planner, settings, groceryList] = await Promise.all([
    db.recipes.toArray(),
    db.planner.toArray(),
    db.settings.toArray(),
    db.groceryList.toArray(),
  ]);
  const exportPackage = { recipes, planner, settings, groceryList };
  const blob = new Blob([JSON.stringify(exportPackage, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'my-cookbook.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Import recipes from a JSON file. Accepts either a raw array of recipes or a backup object with a recipes property.
 * Skips recipes whose url already exists.
 * @param {File} file - JSON file (array of recipe objects, or { recipes: [...] } backup)
 * @returns {Promise<{ imported: number, duplicates: number }>}
 */
export function importRecipesFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const text = reader.result;
        let data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          reject(new Error('Invalid JSON in file.'));
          return;
        }
        let recipeList = null;
        if (Array.isArray(data)) {
          recipeList = data;
        } else if (data && typeof data === 'object' && Array.isArray(data.recipes)) {
          recipeList = data.recipes;
        }
        if (!recipeList) {
          reject(new Error('Invalid file format: Could not find a recipe list or a valid backup structure.'));
          return;
        }
        let imported = 0;
        let duplicates = 0;
        for (const item of recipeList) {
          const url = item && (item.url ?? item.sourceUrl);
          if (!url || typeof url !== 'string') continue;
          const existing = await db.recipes.where('url').equals(url).first();
          if (existing) {
            duplicates++;
            continue;
          }
          const img = item.image;
          const imageUrl = typeof img === 'string' ? img : Array.isArray(img) && img.length > 0 ? (typeof img[0] === 'string' ? img[0] : img[0] && img[0].url) : (img && img.url);
          const rawIng = Array.isArray(item.ingredients) ? item.ingredients : [];
          const recipe = {
            name: item.name ?? item.title ?? 'Untitled',
            ingredients: normalizeIngredientsForStorage(rawIng.map((i) => (typeof i === 'string' ? i : String(i)).trim()).filter(Boolean)),
            url,
            instructions: Array.isArray(item.instructions) ? item.instructions : [],
            tags: Array.isArray(item.tags) ? item.tags : [],
            ...(imageUrl != null && imageUrl !== '' && { image: String(imageUrl).trim() }),
          };
          await db.recipes.add(recipe);
          imported++;
        }
        resolve({ imported, duplicates });
      } catch (err) {
        if (err instanceof SyntaxError) {
          reject(new Error('Invalid JSON in file.'));
        } else {
          reject(err);
        }
      }
    };
    reader.onerror = () => reject(new Error('Could not read file.'));
    reader.readAsText(file, 'UTF-8');
  });
}

/**
 * Export a single recipe by ID as a JSON file.
 * @param {number} id - Recipe primary key
 */
export async function exportSingleRecipe(id) {
  const recipe = await db.recipes.get(id);
  if (!recipe) return;
  const name = (recipe.name || 'recipe').replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').slice(0, 40) || 'recipe';
  const blob = new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Format date for planner day header (e.g. "Mon, Mar 10"). */
function formatPlannerDateLabel(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Get 7 days starting today. */
function getPlannerDateRange() {
  const out = [];
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Load planner data for the next 7 days and render the planner view. */
async function refreshPlanner() {
  const dates = getPlannerDateRange();
  const settings = await getSettings();
  const days = await Promise.all(
    dates.map(async (date) => {
      const row = await db.planner.get(date);
      const entries = Array.isArray(row?.entries) ? row.entries : [];
      return {
        date,
        dateLabel: formatPlannerDateLabel(date),
        entries,
      };
    })
  );
  requestAnimationFrame(() => {
    renderPlanner(days, settings.mealLabels, onPlannerAddRecipe, onPlannerRemoveEntry);
  });
}

/** Called when user clicks "Add Recipe" on a planner day: open picker modal. */
async function onPlannerAddRecipe(date) {
  const recipes = await db.recipes.toArray();
  const settings = await getSettings();
  openPickRecipeModal(recipes, date, settings.mealLabels, async (recipeId, label) => {
    await addToPlanner(date, recipeId, label, 1);
    await refreshPlanner();
  });
}

/** Add a recipe to a planner day. */
async function addToPlanner(date, recipeId, label, scale = 1) {
  const recipe = await db.recipes.get(recipeId);
  const recipeName = recipe ? (recipe.name || 'Untitled') : 'Untitled';
  const row = await db.planner.get(date);
  const entries = Array.isArray(row?.entries) ? row.entries.slice() : [];
  const scaleNum = Math.max(1, Math.min(3, Number(scale) || 1));
  entries.push({ recipeId, recipeName, label, scale: scaleNum });
  await db.planner.put({ date, entries });
}

/** Remove an entry from a planner day by index. */
async function onPlannerRemoveEntry(date, index) {
  const row = await db.planner.get(date);
  const entries = Array.isArray(row?.entries) ? row.entries.slice() : [];
  entries.splice(index, 1);
  if (entries.length === 0) await db.planner.delete(date);
  else await db.planner.put({ date, entries });
  await refreshPlanner();
}

/** Open "Add to Planner" modal from a recipe card (push flow). */
async function addRecipeToPlannerFromCard(recipe) {
  const settings = await getSettings();
  openAddToPlannerModal(recipe, settings.mealLabels, async (date, label, scale) => {
    await addToPlanner(date, recipe.id, label, scale);
    await refreshPlanner();
  });
}

/** Fetches grocery list for planId and re-renders the shopping list UI. */
async function refreshShoppingList(planId) {
  const record = await db.groceryList.where('planId').equals(planId).first();
  const hasRecord = record != null;
  const items = Array.isArray(record?.items) ? record.items : [];
  renderShoppingList(planId, items, {
    hasRecord,
    onToggleStatus: (itemId, newStatus) =>
      toggleItemStatus(planId, itemId, newStatus).then(() => refreshShoppingList(planId)),
    onClearBought: () =>
      clearBoughtItems(planId).then(() => refreshShoppingList(planId)),
  });
}

function runApp() {
  const installBtn = document.getElementById('installBtn');
  if (installBtn) {
    installBtn.addEventListener('click', () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.then((choice) => {
        if (choice.outcome === 'accepted') installBtn.classList.add('is-hidden');
        deferredInstallPrompt = null;
      });
    });
  }
  initUI({
    onAddRecipe: async (url) => {
      try {
        const saved = await importNewRecipe(url, { onProgress: updateImportProgress });
        console.log('[import] importNewRecipe return value:', saved);

        if (saved?.status === 'error') {
          console.error('[import] status: error —', saved.message);
          alert(saved.message || 'Import failed. Please try again.');
          return saved;
        }

        if (saved === null) {
          alert('Could not import recipe. The URL may be invalid or the page has no recipe data.');
          return saved;
        }
        if (saved.duplicate) {
          alert('This recipe is already in your cookbook!');
          return saved;
        }
        await refreshRecipeList();
        return saved;
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.error('[Import] Error:', msg, err);
        alert('Import failed: ' + msg + '. Please check the browser console for details.');
      }
    },
  onExportCookbook: async () => {
    try {
      await exportCookbook();
    } catch (err) {
      console.error('[Export] Error:', err);
      alert('Export failed: ' + (err && err.message ? err.message : String(err)));
    }
  },
  onImportCookbookFile: async (file) => {
    try {
      const { imported, duplicates } = await importRecipesFromFile(file);
      const parts = [];
      if (imported > 0) parts.push(`Successfully imported ${imported} recipe${imported !== 1 ? 's' : ''}`);
      if (duplicates > 0) parts.push(`${duplicates} duplicate${duplicates !== 1 ? 's' : ''} skipped`);
      alert(parts.length ? parts.join('. ') : 'No valid recipes found in file.');
      await refreshRecipeList();
    } catch (err) {
      console.error('[Import file] Error:', err);
      alert(err && err.message ? err.message : 'Import failed.');
    }
  },
  onEditRecipeClick: async (id, card) => {
    const recipe = await db.recipes.get(Number(id));
    if (!recipe) return;
    const settings = await getSettings();
    openRecipeEdit(card, recipe, {
      onSaveRecipe: (recipeId, data) => updateRecipe(recipeId, data),
      onCancelEdit: () => refreshRecipeList(),
      getTagLibrary: () => settings.tagLibrary,
      onRefineImport: async (r) => {
        console.log('DEBUG: Logic Trigger - onRefineImport reached', { id: r.id, sourceHtmlPresent: !!r.sourceHtml, sourceHtmlSample: r.sourceHtml && String(r.sourceHtml).slice(0, 120) });
        const html = r.sourceHtml;
        if (!r.sourceHtml) {
          alert('Source HTML not available for this recipe. Re-import from URL to enable Refine Import.');
          return;
        }
        openSelectionMode(html, async ({ title: titleHtml, ingredients: ingredientsHtml, instructions: instructionsHtml }) => {
          const nameFromTitle = (function () {
            if (!titleHtml || typeof titleHtml !== 'string') return '';
            const div = document.createElement('div');
            div.innerHTML = titleHtml;
            return (div.textContent || '').trim();
          })();
          const fromIng = parseSelectionHtml(ingredientsHtml || '');
          const fromInst = parseSelectionHtml(instructionsHtml || '');
          const ingredients = fromIng.ingredients.length > 0 ? fromIng.ingredients : fromInst.ingredients;
          const instructions = fromInst.instructions.length > 0 ? fromInst.instructions : fromIng.instructions;
          const updates = { ingredients, instructions, imageUrl: r.imageUrl };
          if (nameFromTitle) updates.name = nameFromTitle;
          await updateRecipe(r.id, updates);
          await refreshRecipeList();
        }, {
          recipeId: r.id,
          onAddIngredient: async (recipeId, ingredientLine) => {
            const recipe = await db.recipes.get(recipeId);
            if (!recipe) return;
            const list = Array.isArray(recipe.ingredients) ? recipe.ingredients.slice() : [];
            list.push(ingredientLine);
            await updateRecipe(recipeId, { ingredients: list });
          },
        });
      },
    });
  },
  onManualEntry: () => {
    // Dashboard-level manual entry: open selection mode with no HTML, show manual-entry menu-only flow.
    openSelectionMode(null, async (manualData) => {
      console.log('DEBUG: Manual entry onExtractCallback received', manualData);
      try {
        const ingredientsList = Array.isArray(manualData?.ingredientsList) ? manualData.ingredientsList : [];
        const ingredientLines = ingredientsList.map((item) => {
          const parts = [item.quantity, item.unit, item.name].filter(Boolean);
          return parts.join(' ');
        });
        const instructionsText = typeof manualData?.instructions === 'string' ? manualData.instructions.trim() : '';
        const recipe = {
          name: (manualData?.title || '').trim() || 'Untitled',
          ingredients: ingredientLines,
          instructions: instructionsText ? instructionsText.split('\n').map((s) => s.trim()).filter(Boolean) : [],
          url: '',
        };
        if (manualData && manualData.imageFile instanceof File) {
          try {
            const objectUrl = URL.createObjectURL(manualData.imageFile);
            recipe.imageUrl = objectUrl;
          } catch (e) {
            console.warn('DEBUG: Failed to create object URL for manual image', e);
          }
        }
        console.log('DEBUG: Manual entry recipe to save', recipe);
        const id = await db.recipes.add(recipe);
        console.log('DEBUG: Manual entry saved with id', id);
        await refreshRecipeList();
      } catch (err) {
        console.error('DEBUG: Manual entry save failed', err);
        alert('Manual entry save failed: ' + (err && err.message ? err.message : String(err)));
      }
    });
  },
  getSettings,
  onAddMealLabel: async (label) => {
    const row = await db.settings.get('mealLabels');
    const value = Array.isArray(row?.value) ? row.value.slice() : DEFAULT_MEAL_LABELS.slice();
    if (value.includes(label)) return;
    value.push(label);
    await db.settings.put({ key: 'mealLabels', value });
  },
  onRemoveMealLabel: async (label) => {
    const row = await db.settings.get('mealLabels');
    const value = Array.isArray(row?.value) ? row.value.slice() : [];
    const next = value.filter((l) => l !== label);
    await db.settings.put({ key: 'mealLabels', value: next });
  },
  onAddTag: async (tag) => {
    const row = await db.settings.get('tagLibrary');
    const value = Array.isArray(row?.value) ? row.value.slice() : [];
    if (value.includes(tag)) return;
    value.push(tag);
    await db.settings.put({ key: 'tagLibrary', value });
  },
  onRemoveTag: async (tag) => {
    const row = await db.settings.get('tagLibrary');
    const value = Array.isArray(row?.value) ? row.value.slice() : [];
    const next = value.filter((t) => t !== tag);
    await db.settings.put({ key: 'tagLibrary', value: next });
  },
  onGenerateList: async () => {
    const { start, end } = getShoppingDateRange();
    if (!start || !end) {
      alert('Please select start and end dates.');
      return;
    }
    if (start > end) {
      alert('Start date must be on or before end date.');
      return;
    }
    try {
      await generateShoppingList(start, end);
      await refreshShoppingList(`${start}_${end}`);
    } catch (err) {
      console.error('[Shopping list] Error:', err);
      alert(err?.message || 'Failed to generate list.');
    }
  },
  onDeleteList: async () => {
    const { start, end } = getShoppingDateRange();
    if (!start || !end) {
      alert('Please select start and end dates for the list to delete.');
      return;
    }
    const planId = `${start}_${end}`;
    try {
      await deleteShoppingList(planId);
      await refreshShoppingList(planId);
    } catch (err) {
      console.error('[Shopping list] Delete error:', err);
      alert(err?.message || 'Failed to delete list.');
    }
  },
  onShoppingTabShow: () => {
    const { start, end } = getShoppingDateRange();
    if (start && end) refreshShoppingList(`${start}_${end}`);
    else {
      renderShoppingList('', [], {
        hasRecord: false,
        onToggleStatus: () => {},
        onClearBought: () => {},
      });
    }
  },
  onThemeChange: (themeName) => setTheme(themeName),
  });

  refreshRecipeList();
  refreshPlanner();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', runApp);
} else {
  runApp();
}
