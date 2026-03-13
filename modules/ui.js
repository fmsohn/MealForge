/**
 * ui.js — DOM rendering for MealForge.
 * Relative paths and ES modules only; no backend.
 */

import { VALID_THEMES } from '../app.js';
import { formatQuantityForDisplay, parseIngredient } from '../utils/recipeUtils.js';

/**
 * Escape HTML to prevent XSS when injecting user content.
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

/**
 * Validates that no ingredient has a number immediately followed by a letter (e.g. '4garlic').
 * Keeps 1x base data clean for scaling.
 * @param {string[]} ingredients - Trimmed, non-empty ingredient strings
 * @returns {{ isValid: true } | { isValid: false, message: string }}
 */
function validateIngredients(ingredients) {
  const bad = /^\d+(?:\.\d+)?[a-zA-Z]/;
  for (const ing of ingredients) {
    const trimmed = (ing || '').trim();
    if (!trimmed) continue;
    if (bad.test(trimmed)) {
      const fixed = trimmed.replace(/^(\d+(?:\.\d+)?)([a-zA-Z])/, '$1 $2');
      return {
        isValid: false,
        message: `Wait! Looks like you forgot a space after the quantity in "${trimmed}". Try changing it to "${fixed}".`,
      };
    }
  }
  return { isValid: true };
}

/**
 * Strict numeric scaling: data model only (recipe.ingredients), never DOM.
 * Flow: ingredient string → parseIngredient → parseFloat(quantity) → * multiplier → formatQuantityForDisplay → UI.
 * @param {string[]} ingredients - From data model (recipe.ingredients), not textContent
 * @param {number} scale - Scale factor (1, 2, 3)
 * @returns {HTMLUListElement}
 */
function buildIngredientsList(ingredients, scale) {
  const ul = document.createElement('ul');
  ul.className = 'recipe-ingredients';
  const multiplier = Math.max(1, Number(scale) || 1);
  for (const ing of ingredients) {
    const parsed = parseIngredient(ing);
    const quantityFromData = parsed.quantity ?? 0;
    const parsedQty = parseFloat(String(quantityFromData).replace(/\s+/g, ''));
    const scaled = Number.isFinite(parsedQty) ? parsedQty * multiplier : 0;
    console.log('Scaling math:', { input: quantityFromData, parsed: parsedQty, result: scaled });
    const quantityEndFromData = parsed.quantityEnd;
    const parsedEnd = quantityEndFromData != null && Number.isFinite(quantityEndFromData)
      ? parseFloat(String(quantityEndFromData).replace(/\s+/g, ''))
      : null;
    const scaledEnd = parsedEnd != null ? parsedEnd * multiplier : null;
    const q1 = scaled;
    const q2 = scaledEnd;
    const displayQty = (Number.isFinite(parsedQty) && parsedQty !== 0) || scaledEnd != null
      ? (q2 != null ? `${formatQuantityForDisplay(q1)}–${formatQuantityForDisplay(q2)}` : formatQuantityForDisplay(q1))
      : '';
    const displayStr = [displayQty, parsed.unit, parsed.ingredient].filter(Boolean).join(' ') || ing;
    const li = document.createElement('li');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'ingredient-checkbox';
    checkbox.setAttribute('aria-label', `Mark "${displayStr}" as done`);
    const label = document.createElement('span');
    label.className = 'ingredient-text';
    label.textContent = displayStr;
    li.appendChild(checkbox);
    li.appendChild(label);
    ul.appendChild(li);
  }
  return ul;
}

/**
 * Opens edit mode for a recipe card: replaces body with textareas, tags, and Save/Cancel.
 * Call when Edit is clicked (e.g. from delegated handler). Uses 1x base data only.
 * @param {HTMLElement} card - The .recipe-card element
 * @param {{ id: number, ingredients: string[], instructions?: string[], tags?: string[] }} recipe - Recipe from DB
 * @param {{ onSaveRecipe: (id: number, data: { ingredients: string[], instructions: string[], tags?: string[] }) => void|Promise<void>, onCancelEdit: () => void, getTagLibrary?: () => string[], onRefineImport?: (recipe: object) => void|Promise<void> }} callbacks
 */
export function openRecipeEdit(card, recipe, callbacks) {
  const body = card.querySelector('.recipe-card-body');
  if (!body || card.classList.contains('is-editing')) return;
  const id = recipe.id;
  const onSaveRecipe = callbacks.onSaveRecipe;
  const onCancelEdit = callbacks.onCancelEdit;
  const onRefineImport = callbacks.onRefineImport;
  const getTagLibrary = typeof callbacks.getTagLibrary === 'function' ? callbacks.getTagLibrary : () => [];
  const ingredients1x = (recipe.ingredients || []).slice();
  const instructions1x = Array.isArray(recipe.instructions) ? recipe.instructions.slice() : (recipe.instructions ? [recipe.instructions] : []);
  const existingTags = Array.isArray(recipe.tags) ? recipe.tags.slice() : [];

  card.classList.add('is-editing');
  body.innerHTML = '';
  const errorEl = document.createElement('div');
  errorEl.className = 'recipe-edit-error';
  errorEl.setAttribute('role', 'alert');
  body.appendChild(errorEl);

  const tagLibrary = getTagLibrary();
  const selectedLibraryTags = new Set(existingTags.filter((t) => tagLibrary.includes(t)));
  const customTags = existingTags.filter((t) => !tagLibrary.includes(t));

  const tagsSection = document.createElement('div');
  tagsSection.className = 'recipe-edit-tags';
  const tagsTitle = document.createElement('div');
  tagsTitle.className = 'recipe-card-section-title';
  tagsTitle.textContent = 'Tags';
  tagsSection.appendChild(tagsTitle);
  const tagPillsWrap = document.createElement('div');
  tagPillsWrap.className = 'recipe-edit-tag-pills';
  tagLibrary.forEach((tag) => {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'recipe-edit-tag-pill' + (selectedLibraryTags.has(tag) ? ' selected' : '');
    pill.textContent = tag;
    pill.addEventListener('click', () => {
      if (selectedLibraryTags.has(tag)) selectedLibraryTags.delete(tag);
      else selectedLibraryTags.add(tag);
      pill.classList.toggle('selected', selectedLibraryTags.has(tag));
    });
    tagPillsWrap.appendChild(pill);
  });
  tagsSection.appendChild(tagPillsWrap);
  const customInput = document.createElement('input');
  customInput.type = 'text';
  customInput.className = 'recipe-edit-tags-custom';
  customInput.placeholder = 'Custom tags (comma-separated)';
  customInput.value = customTags.join(', ');
  customInput.setAttribute('aria-label', 'Custom tags');
  tagsSection.appendChild(customInput);
  body.appendChild(tagsSection);

  const ingLabel = document.createElement('div');
  ingLabel.className = 'recipe-card-section-title';
  ingLabel.textContent = 'Ingredients (one per line)';
  body.appendChild(ingLabel);
  const ingTa = document.createElement('textarea');
  ingTa.className = 'recipe-edit-textarea recipe-edit-ingredients';
  ingTa.rows = Math.min(12, Math.max(4, ingredients1x.length));
  ingTa.value = ingredients1x.join('\n');
  ingTa.addEventListener('input', () => {
    ingTa.classList.remove('recipe-edit-ingredients--error');
    errorEl.classList.remove('is-visible');
    errorEl.textContent = '';
  });
  body.appendChild(ingTa);
  const instLabel = document.createElement('div');
  instLabel.className = 'recipe-card-section-title';
  instLabel.textContent = 'Instructions (one per line)';
  body.appendChild(instLabel);
  const instTa = document.createElement('textarea');
  instTa.className = 'recipe-edit-textarea recipe-edit-instructions';
  instTa.rows = Math.min(12, Math.max(4, instructions1x.length));
  instTa.value = instructions1x.map((s) => (typeof s === 'string' ? s : String(s))).join('\n');
  body.appendChild(instTa);
  const editActions = document.createElement('div');
  editActions.className = 'recipe-edit-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', async () => {
    errorEl.classList.remove('is-visible');
    errorEl.textContent = '';
    const newIngredients = ingTa.value.split('\n').map((s) => s.trim()).filter(Boolean);
    const newInstructions = instTa.value.split('\n').map((s) => s.trim()).filter(Boolean);
    const customParts = customInput.value.split(',').map((s) => s.trim()).filter(Boolean);
    const newTags = [...selectedLibraryTags].concat(customParts);
    const validation = validateIngredients(newIngredients);
    if (!validation.isValid) {
      errorEl.textContent = validation.message;
      errorEl.classList.add('is-visible');
      ingTa.classList.add('recipe-edit-ingredients--error');
      return;
    }
    ingTa.classList.remove('recipe-edit-ingredients--error');
    if (onSaveRecipe) await onSaveRecipe(id, { ingredients: newIngredients, instructions: newInstructions, tags: newTags });
  });
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn cancel-edit-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    card.classList.remove('is-editing');
    if (onCancelEdit) onCancelEdit();
  });
  editActions.appendChild(saveBtn);
  editActions.appendChild(cancelBtn);
  if (onRefineImport && recipe && recipe.url) {
    const refineImportBtn = document.createElement('button');
    refineImportBtn.type = 'button';
    refineImportBtn.className = 'btn cancel-edit-btn recipe-edit-refine-import-btn';
    refineImportBtn.textContent = 'Refine Import';
    refineImportBtn.addEventListener('click', () => {
      console.log('DEBUG: UI Trigger - Refine Import Clicked', { id, recipe });
      onRefineImport(recipe);
    });
    editActions.appendChild(refineImportBtn);
  }
  body.appendChild(editActions);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      card.scrollIntoView({ behavior: 'auto', block: 'start' });
      window.scrollBy(0, -20);
    });
  });
}

/**
 * Clears #recipe-list and renders each recipe with header (title + scale), link, ingredients (checkboxes), instructions, footer (Share, Delete, Edit, Plan).
 * @param {Array<{ id?: number, name: string, ingredients: string[], url: string, instructions?: string[], image?: string, tags?: string[] }>} recipes
 * @param {{ onShare?: (id: number) => void, onDelete?: (id: number) => void, onSaveRecipe?: (id: number, data: { ingredients: string[], instructions: string[], tags?: string[] }) => void|Promise<void>, onCancelEdit?: () => void, onAddToPlanner?: (recipe: { id: number, name: string }) => void, getTagLibrary?: () => string[] }} [callbacks]
 */
export function renderRecipeList(recipes, callbacks) {
  const container = document.getElementById('recipe-list');
  if (!container) return;
  container.innerHTML = '';
  if (!recipes || recipes.length === 0) {
    container.innerHTML = '<p class="recipe-list-empty">No recipes yet. Paste a recipe URL and click Add Recipe.</p>';
    return;
  }
  const onShare = callbacks && typeof callbacks.onShare === 'function' ? callbacks.onShare : null;
  const onDelete = callbacks && typeof callbacks.onDelete === 'function' ? callbacks.onDelete : null;
  const onSaveRecipe = callbacks && typeof callbacks.onSaveRecipe === 'function' ? callbacks.onSaveRecipe : null;
  const onCancelEdit = callbacks && typeof callbacks.onCancelEdit === 'function' ? callbacks.onCancelEdit : null;
  const onAddToPlanner = callbacks && typeof callbacks.onAddToPlanner === 'function' ? callbacks.onAddToPlanner : null;
  const getTagLibrary = typeof (callbacks && callbacks.getTagLibrary) === 'function' ? callbacks.getTagLibrary : () => [];

  for (const recipe of recipes) {
    const name = escapeHtml(recipe.name || 'Untitled');
    const url = escapeHtml(recipe.url || '#');
    const id = recipe.id;
    const ingredients = recipe.ingredients || [];
    const instructions = recipe.instructions || (recipe.instruction ? [recipe.instruction] : []);

    const card = document.createElement('div');
    card.className = 'recipe-card';
    card.setAttribute('data-recipe-id', String(id));

    const details = document.createElement('details');
    details.className = 'recipe-card-details';

    const summary = document.createElement('summary');
    summary.className = 'recipe-card-summary';

    const title = document.createElement('h3');
    title.textContent = recipe.name || 'Untitled';
    summary.appendChild(title);

    details.appendChild(summary);

    const accordionInner = document.createElement('div');
    accordionInner.className = 'recipe-card-accordion-inner';

    const accordionBody = document.createElement('div');
    accordionBody.className = 'accordion-body';

    const rawImage = recipe.imageUrl || recipe.image;
    const imageUrl = typeof rawImage === 'string' ? rawImage.trim() : '';
    if (imageUrl) {
      const img = document.createElement('img');
      img.src = imageUrl;
      img.alt = recipe.name ? `${recipe.name} recipe` : 'Recipe image';
      img.className = 'recipe-card-image';
      accordionBody.appendChild(img);
    }

    const scaleControl = document.createElement('div');
    scaleControl.className = 'scale-control';
    scaleControl.setAttribute('aria-label', 'Servings scale');
    [1, 2, 3].forEach((scale) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-scale', String(scale));
      btn.textContent = `${scale}x`;
      if (scale === 1) btn.classList.add('active');
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        scaleControl.querySelectorAll('[data-scale]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const body = card.querySelector('.recipe-card-body');
        const ingredientsContainer = body && body.querySelector('.recipe-ingredients-wrap');
        if (ingredientsContainer) {
          const newList = buildIngredientsList(ingredients, scale);
          ingredientsContainer.innerHTML = '';
          ingredientsContainer.appendChild(newList);
        }
      });
      scaleControl.appendChild(btn);
    });
    accordionBody.appendChild(scaleControl);

    const link = document.createElement('a');
    const rawUrl = recipe.url || '';
    link.href = rawUrl.startsWith('http://') || rawUrl.startsWith('https://') ? rawUrl : '#';
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = 'recipe-card-link';
    link.textContent = rawUrl || '';
    accordionBody.appendChild(link);

    const tags = recipe.tags && Array.isArray(recipe.tags) ? recipe.tags : [];
    if (tags.length > 0) {
      const tagsWrap = document.createElement('div');
      tagsWrap.className = 'recipe-card-tags';
      tags.forEach((tag) => {
        const span = document.createElement('span');
        span.className = 'recipe-card-tag';
        span.textContent = tag;
        tagsWrap.appendChild(span);
      });
      accordionBody.appendChild(tagsWrap);
    }

    const body = document.createElement('div');
    body.className = 'recipe-card-body';

    if (ingredients.length > 0) {
      const sectionTitle = document.createElement('div');
      sectionTitle.className = 'recipe-card-section-title';
      sectionTitle.textContent = 'Ingredients';
      body.appendChild(sectionTitle);
      const ingredientsWrap = document.createElement('div');
      ingredientsWrap.className = 'recipe-ingredients-wrap';
      ingredientsWrap.appendChild(buildIngredientsList(ingredients, 1));
      body.appendChild(ingredientsWrap);
    }

    if (instructions.length > 0) {
      const sectionTitle = document.createElement('div');
      sectionTitle.className = 'recipe-card-section-title';
      sectionTitle.textContent = 'Instructions';
      body.appendChild(sectionTitle);
      const instructionsEl = document.createElement('ol');
      instructionsEl.className = 'recipe-instructions';
      const instructionList = Array.isArray(instructions) ? instructions : [instructions];
      instructionList.forEach((step, index) => {
        const stepText = typeof step === 'string' ? step : (step && step.text ? step.text : String(step));
        const li = document.createElement('li');
        const indicator = document.createElement('span');
        indicator.className = 'step-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        indicator.setAttribute('data-debug', 'true');
        // Ensure no accidental text nodes or innerHTML
        indicator.textContent = '';
        const number = document.createElement('span');
        number.className = 'step-number';
        number.setAttribute('aria-hidden', 'true');
        number.textContent = `${index + 1}.`;
        const text = document.createElement('span');
        text.className = 'step-text';
        text.textContent = stepText;
        li.appendChild(indicator);
        li.appendChild(number);
        li.appendChild(text);
        instructionsEl.appendChild(li);
      });
      body.appendChild(instructionsEl);
    }

    accordionBody.appendChild(body);

    const hasActions = id != null && (onShare || onDelete || onSaveRecipe || onAddToPlanner);
    if (hasActions) {
      const footer = document.createElement('div');
      footer.className = 'recipe-card-footer';
      if (onShare) {
        const shareBtn = document.createElement('button');
        shareBtn.type = 'button';
        shareBtn.className = 'btn share-btn';
        shareBtn.textContent = 'Share';
        shareBtn.addEventListener('click', () => onShare(id));
        footer.appendChild(shareBtn);
      }
      if (onAddToPlanner) {
        const planBtn = document.createElement('button');
        planBtn.type = 'button';
        planBtn.className = 'btn calendar-btn';
        planBtn.setAttribute('aria-label', 'Add to planner');
        planBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
        planBtn.addEventListener('click', () => onAddToPlanner({ id, name: recipe.name || 'Untitled' }));
        footer.appendChild(planBtn);
      }
      if (onSaveRecipe) {
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn edit-btn';
        editBtn.setAttribute('data-recipe-id', String(id));
        editBtn.textContent = 'Edit';
        footer.appendChild(editBtn);
      }
      if (onDelete) {
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn delete-btn';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', () => onDelete(id));
        footer.appendChild(deleteBtn);
      }
      accordionBody.appendChild(footer);
    }

    accordionInner.appendChild(accordionBody);
    details.appendChild(accordionInner);
    card.appendChild(details);

    container.appendChild(card);
  }
}

const ADD_BTN_LABEL = 'Add Recipe';
const ADD_BTN_BUSY_LABEL = 'Adding...';
const EXPORT_BTN_LABEL = 'Export Cookbook';
const EXPORT_BTN_BUSY_LABEL = 'Exporting...';

const DEFAULT_MEAL_LABELS = ['Breakfast', 'Lunch', 'Dinner'];

/**
 * Renders the tag filter row (All + tag library pills). Call when tag library or selection changes.
 * @param {string[]} tagLibrary
 * @param {string|null} selectedTag - Currently selected tag for filtering, or null for "All"
 * @param {(tag: string|null) => void} onSelectTag
 */
export function renderTagFilters(tagLibrary, selectedTag, onSelectTag) {
  const wrap = document.getElementById('tag-filters-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';
  const allPill = document.createElement('button');
  allPill.type = 'button';
  allPill.className = 'tag-pill' + (selectedTag === null ? ' active' : '');
  allPill.textContent = 'All';
  allPill.addEventListener('click', () => {
    requestAnimationFrame(() => onSelectTag(null));
  });
  wrap.appendChild(allPill);
  tagLibrary.forEach((tag) => {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'tag-pill' + (selectedTag === tag ? ' active' : '');
    pill.textContent = tag;
    pill.addEventListener('click', () => {
      requestAnimationFrame(() => onSelectTag(tag));
    });
    wrap.appendChild(pill);
  });
  wrap.classList.toggle('is-hidden', tagLibrary.length === 0);
}

/**
 * Renders the planner view: 7 days from startDate, each with header (date) and Add Recipe button.
 * @param {Array<{ date: string, dateLabel: string, entries: Array<{ recipeId: number, recipeName: string, label: string }> }>} days
 * @param {string[]} mealLabels
 * @param {(date: string) => void} onAddRecipe
 * @param {(date: string, index: number) => void} onRemoveEntry
 */
export function renderPlanner(days, mealLabels, onAddRecipe, onRemoveEntry) {
  const container = document.getElementById('planner-days');
  if (!container) return;
  container.innerHTML = '';
  days.forEach((day, index) => {
    const dayEl = document.createElement('div');
    dayEl.className = 'planner-day' + (index === 0 ? ' is-today' : '');
    const header = document.createElement('div');
    header.className = 'planner-day-header';
    const title = document.createElement('h3');
    title.textContent = day.dateLabel;
    header.appendChild(title);
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-primary planner-day-add';
    addBtn.textContent = 'Add Recipe';
    addBtn.addEventListener('click', () => onAddRecipe(day.date));
    header.appendChild(addBtn);
    dayEl.appendChild(header);
    const list = document.createElement('ul');
    list.className = 'planner-entries';
    day.entries.forEach((entry, index) => {
      const li = document.createElement('li');
      li.className = 'planner-entry';
      const left = document.createElement('span');
      left.innerHTML = `<span class="planner-entry-label">${escapeHtml(entry.label)}</span>${escapeHtml(entry.recipeName)}`;
      li.appendChild(left);
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'planner-entry-remove';
      removeBtn.textContent = 'Remove';
      removeBtn.setAttribute('aria-label', `Remove ${entry.recipeName} from ${day.dateLabel}`);
      removeBtn.addEventListener('click', () => onRemoveEntry(day.date, index));
      li.appendChild(removeBtn);
      list.appendChild(li);
    });
    dayEl.appendChild(list);
    container.appendChild(dayEl);
  });
}

/**
 * Renders the shopping list for a planId. Caller passes items (from DB), hasRecord, and callbacks.
 * Only shows #btn-delete-list and #shopping-list-actions when a valid grocery list record exists (hasRecord).
 * @param {string} planId - planId for the list (e.g. startDate_endDate)
 * @param {Array<{ id: string, quantity: number, unit: string, ingredient: string, status?: string }>} items
 * @param {{ hasRecord: boolean, onToggleStatus?: (itemId: string, newStatus: 'pending'|'bought') => void|Promise<void>, onClearBought?: () => void|Promise<void> }} callbacks
 */
export function renderShoppingList(planId, items, callbacks) {
  const container = document.getElementById('shopping-list-container');
  const actionsWrap = document.getElementById('shopping-list-actions');
  const deleteListBtn = document.getElementById('btn-delete-list');
  if (!container) return;

  const hasRecord = callbacks.hasRecord === true;

  if (deleteListBtn) {
    deleteListBtn.classList.toggle('is-hidden', !hasRecord);
  }
  if (actionsWrap) {
    actionsWrap.classList.add('is-hidden');
  }

  container.innerHTML = '';
  if (!hasRecord || !items || items.length === 0) {
    const emptyMessage = !hasRecord
      ? 'No list for this date range. Select start and end dates, then click Generate List.'
      : 'List is empty. Generate again to refresh from planner, or add manual items.';
    container.innerHTML = `<p class="shopping-list-empty">${emptyMessage}</p>`;
    if (actionsWrap && hasRecord && items && items.length === 0) {
      actionsWrap.classList.add('is-hidden');
    }
    return;
  }

  const onToggleStatus = callbacks.onToggleStatus;
  const onClearBought = callbacks.onClearBought;

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'shopping-list-item' + (item.status === 'bought' ? ' bought' : '');
    const qty = Number(item.quantity);
    const qtyStr = formatQuantityForDisplay(qty);
    console.log('renderShoppingList', { rawQuantity: item.quantity, afterFormatter: qtyStr });
    const labelText = [qtyStr, item.unit, item.ingredient].filter(Boolean).join(' ');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = item.status === 'bought';
    checkbox.setAttribute('aria-label', `Mark ${labelText} as bought`);
    checkbox.dataset.itemId = item.id;

    const textSpan = document.createElement('span');
    textSpan.className = 'shopping-list-item-text';
    textSpan.textContent = labelText;

    checkbox.addEventListener('change', () => {
      const newStatus = checkbox.checked ? 'bought' : 'pending';
      if (onToggleStatus) Promise.resolve(onToggleStatus(item.id, newStatus)).then(() => {
        row.classList.toggle('bought', newStatus === 'bought');
      });
    });

    row.appendChild(checkbox);
    row.appendChild(textSpan);
    container.appendChild(row);
  }

  if (actionsWrap) {
    actionsWrap.classList.remove('is-hidden');
    actionsWrap.innerHTML = '';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn cancel-edit-btn';
    clearBtn.id = 'btn-clear-bought';
    clearBtn.textContent = 'Clear Bought Items';
    clearBtn.addEventListener('click', () => {
      if (onClearBought) Promise.resolve(onClearBought()).catch(() => {});
    });
    actionsWrap.appendChild(clearBtn);
  }
}

/**
 * Opens the Add to Planner modal for a recipe. Fills date (today), meal label, and servings (1x/2x/3x).
 * @param {{ id: number, name: string }} recipe
 * @param {string[]} mealLabels
 * @param {(date: string, label: string, scale: number) => void|Promise<void>} onSave
 */
export function openAddToPlannerModal(recipe, mealLabels, onSave) {
  const modal = document.getElementById('add-to-planner-modal');
  const dateInput = document.getElementById('planner-date');
  const labelSelect = document.getElementById('planner-label');
  const scaleSelect = document.getElementById('planner-scale');
  const saveBtn = document.getElementById('add-to-planner-save');
  const cancelBtn = document.getElementById('add-to-planner-cancel');
  if (!modal || !dateInput || !labelSelect || !saveBtn || !cancelBtn) return;
  const today = new Date();
  dateInput.value = today.toISOString().slice(0, 10);
  labelSelect.innerHTML = '';
  const labels = mealLabels && mealLabels.length > 0 ? mealLabels : DEFAULT_MEAL_LABELS;
  labels.forEach((label) => {
    const opt = document.createElement('option');
    opt.value = label;
    opt.textContent = label;
    labelSelect.appendChild(opt);
  });
  if (scaleSelect) {
    scaleSelect.value = '1';
  }
  let resolved = false;
  const close = () => {
    if (resolved) return;
    resolved = true;
    requestAnimationFrame(() => {
      modal.classList.remove('open');
    });
  };
  const save = async () => {
    if (resolved) return;
    const date = dateInput.value;
    const label = labelSelect.value;
    const scale = scaleSelect ? Math.max(1, Math.min(3, parseInt(scaleSelect.value, 10) || 1)) : 1;
    if (!date) return;
    await onSave(date, label, scale);
    close();
  };
  saveBtn.replaceWith(saveBtn.cloneNode(true));
  cancelBtn.replaceWith(cancelBtn.cloneNode(true));
  const newSave = document.getElementById('add-to-planner-save');
  const newCancel = document.getElementById('add-to-planner-cancel');
  newSave.addEventListener('click', save);
  newCancel.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); }, { once: true });
  requestAnimationFrame(() => modal.classList.add('open'));
}

/**
 * Opens the Pick Recipe modal (mini-gallery) for adding a recipe to a planner day.
 * Supports live filtering by title and ingredients.
 * @param {Array<{ id: number, name: string, ingredients: string[] }>} recipes
 * @param {string} selectedDate - YYYY-MM-DD
 * @param {string[]} mealLabels
 * @param {(recipeId: number, label: string) => void|Promise<void>} onSelect
 */
export function openPickRecipeModal(recipes, selectedDate, mealLabels, onSelect) {
  const modal = document.getElementById('pick-recipe-modal');
  const searchInput = document.getElementById('pick-recipe-search');
  const listEl = document.getElementById('pick-recipe-list');
  const labelSelect = document.getElementById('pick-recipe-label');
  const cancelBtn = document.getElementById('pick-recipe-cancel');
  if (!modal || !searchInput || !listEl || !cancelBtn) return;
  const labels = mealLabels && mealLabels.length > 0 ? mealLabels : DEFAULT_MEAL_LABELS;
  if (labelSelect) {
    labelSelect.innerHTML = '';
    labels.forEach((label) => {
      const opt = document.createElement('option');
      opt.value = label;
      opt.textContent = label;
      labelSelect.appendChild(opt);
    });
  }
  let resolved = false;
  const close = () => {
    if (resolved) return;
    resolved = true;
    requestAnimationFrame(() => modal.classList.remove('open'));
  };
  const getSelectedLabel = () => (labelSelect && labelSelect.value) || labels[0];
  function filterRecipes(query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return recipes;
    return recipes.filter((r) => {
      const name = (r.name || '').toLowerCase();
      const ingStr = (r.ingredients || []).join(' ').toLowerCase();
      return name.includes(q) || ingStr.includes(q);
    });
  }
  function renderList(recipeList) {
    listEl.innerHTML = '';
    recipeList.forEach((r) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pick-recipe-item';
      const name = escapeHtml(r.name || 'Untitled');
      const ingPreview = (r.ingredients || []).slice(0, 3).join(', ');
      btn.innerHTML = `<strong>${name}</strong><span>${escapeHtml(ingPreview)}</span>`;
      btn.addEventListener('click', async () => {
        await onSelect(r.id, getSelectedLabel());
        close();
      });
      listEl.appendChild(btn);
    });
  }
  searchInput.value = '';
  renderList(recipes);
  searchInput.addEventListener('input', () => {
    requestAnimationFrame(() => renderList(filterRecipes(searchInput.value)));
  });
  cancelBtn.replaceWith(cancelBtn.cloneNode(true));
  document.getElementById('pick-recipe-cancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); }, { once: true });
  requestAnimationFrame(() => modal.classList.add('open'));
}

/**
 * Renders the settings modal lists (meal labels and tag library). Call when modal opens or after add/remove.
 * @param {string[]} mealLabels
 * @param {string[]} tagLibrary
 * @param {{ onAddMealLabel: (label: string) => void, onRemoveMealLabel: (label: string) => void, onAddTag: (tag: string) => void, onRemoveTag: (tag: string) => void }} handlers
 */
export function renderSettingsContent(mealLabels, tagLibrary, handlers) {
  const mealList = document.getElementById('settings-meal-labels');
  const tagList = document.getElementById('settings-tag-library');
  if (mealList) {
    mealList.innerHTML = '';
    (mealLabels || []).forEach((label) => {
      const item = document.createElement('span');
      item.className = 'settings-list-item';
      item.textContent = label;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${label}`);
      remove.addEventListener('click', () => handlers.onRemoveMealLabel(label));
      item.appendChild(remove);
      mealList.appendChild(item);
    });
  }
  if (tagList) {
    tagList.innerHTML = '';
    (tagLibrary || []).forEach((tag) => {
      const item = document.createElement('span');
      item.className = 'settings-list-item';
      item.textContent = tag;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${tag}`);
      remove.addEventListener('click', () => handlers.onRemoveTag(tag));
      item.appendChild(remove);
      tagList.appendChild(item);
    });
  }
}

/**
 * Sets the progress bar on the Add Recipe button. Use 0–100. Button should have .is-adding and text "Adding..." for the bar to show.
 * @param {number} percent - 0 to 100
 */
export function updateImportProgress(percent) {
  const btn = document.getElementById('add-recipe-btn');
  if (!btn) return;
  btn.style.setProperty('--progress', String(Math.max(0, Math.min(100, percent))));
}

/**
 * Attaches event listeners: tabs, Add Recipe, Export Cookbook, Import, Edit, Settings (meal labels + tag library), tag filter.
 * @param {{ onAddRecipe?: (url: string) => Promise<void>, onExportCookbook?: () => Promise<void>, onImportCookbookFile?: (file: File) => Promise<void>, onEditRecipeClick?: (id: string, card: HTMLElement) => void|Promise<void>, getSettings?: () => Promise<{ mealLabels: string[], tagLibrary: string[] }>, onAddMealLabel?: (label: string) => Promise<void>, onRemoveMealLabel?: (label: string) => Promise<void>, onAddTag?: (tag: string) => Promise<void>, onRemoveTag?: (tag: string) => Promise<void>, onThemeChange?: (themeName: string) => void, onGenerateList?: () => void|Promise<void>, onDeleteList?: () => void|Promise<void>, onShoppingTabShow?: () => void|Promise<void> }} handlers
 */
export function initUI(handlers) {
  const addBtn = document.getElementById('add-recipe-btn');
  const urlInput = document.getElementById('recipe-url');
  const addHeader = document.querySelector('.header-add-recipe');
  const exportBtn = document.getElementById('export-cookbook-btn');
  const fileInput = document.getElementById('import-cookbook-file');
  const settingsBtn = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const recipeList = document.getElementById('recipe-list');
  const tabCookbook = document.getElementById('tab-cookbook');
  const tabPlanner = document.getElementById('tab-planner');
  const tabShopping = document.getElementById('tab-shopping');
  const viewCookbook = document.getElementById('view-cookbook');
  const viewPlanner = document.getElementById('view-planner');
  const viewShopping = document.getElementById('view-shopping');

  if (addHeader && typeof handlers.onManualEntry === 'function') {
    const manualBtn = document.createElement('button');
    manualBtn.type = 'button';
    manualBtn.className = 'btn btn-primary btn-manual-entry';
    manualBtn.textContent = 'Enter Manually';
    manualBtn.addEventListener('click', () => {
      handlers.onManualEntry();
    });
    addHeader.appendChild(manualBtn);
  }

  if (tabCookbook && tabPlanner && tabShopping && viewCookbook && viewPlanner && viewShopping) {
    const switchTo = (tab) => {
      const isCookbook = tab === 'cookbook';
      const isPlanner = tab === 'planner';
      const isShopping = tab === 'shopping';
      tabCookbook.setAttribute('aria-selected', isCookbook ? 'true' : 'false');
      tabPlanner.setAttribute('aria-selected', isPlanner ? 'true' : 'false');
      tabShopping.setAttribute('aria-selected', isShopping ? 'true' : 'false');
      viewCookbook.classList.toggle('is-active', isCookbook);
      viewPlanner.classList.toggle('is-active', isPlanner);
      viewShopping.classList.toggle('is-active', isShopping);
    };
    tabCookbook.addEventListener('click', () => requestAnimationFrame(() => switchTo('cookbook')));
    tabPlanner.addEventListener('click', () => requestAnimationFrame(() => switchTo('planner')));
    tabShopping.addEventListener('click', () => {
      requestAnimationFrame(() => {
        switchTo('shopping');
        if (typeof handlers.onShoppingTabShow === 'function') handlers.onShoppingTabShow();
      });
    });
  }

  const generateListBtn = document.getElementById('btn-generate-list');
  if (generateListBtn && typeof handlers.onGenerateList === 'function') {
    generateListBtn.addEventListener('click', () => {
      requestAnimationFrame(() => handlers.onGenerateList());
    });
  }
  const deleteListBtn = document.getElementById('btn-delete-list');
  if (deleteListBtn && typeof handlers.onDeleteList === 'function') {
    deleteListBtn.addEventListener('click', () => {
      requestAnimationFrame(() => handlers.onDeleteList());
    });
  }

  const refreshSettingsModal = async () => {
    const themeSelect = document.getElementById('settings-theme');
    if (themeSelect) {
      const current = document.documentElement.getAttribute('data-theme') || 'classic';
      themeSelect.value = VALID_THEMES.includes(current) ? current : 'classic';
    }
    if (typeof handlers.getSettings !== 'function') return;
    const { mealLabels = [], tagLibrary = [] } = await handlers.getSettings();
    renderSettingsContent(mealLabels, tagLibrary, {
      onAddMealLabel: (label) => handlers.onAddMealLabel && handlers.onAddMealLabel(label).then(refreshSettingsModal),
      onRemoveMealLabel: (label) => handlers.onRemoveMealLabel && handlers.onRemoveMealLabel(label).then(refreshSettingsModal),
      onAddTag: (tag) => handlers.onAddTag && handlers.onAddTag(tag).then(refreshSettingsModal),
      onRemoveTag: (tag) => handlers.onRemoveTag && handlers.onRemoveTag(tag).then(refreshSettingsModal),
    });
  };
  if (settingsBtn && settingsModal) {
    const themeSelect = document.getElementById('settings-theme');
    if (themeSelect && typeof handlers.onThemeChange === 'function') {
      themeSelect.addEventListener('change', () => {
        handlers.onThemeChange(themeSelect.value);
      });
    }
    settingsBtn.addEventListener('click', () => {
      const willOpen = !settingsModal.classList.contains('open');
      settingsModal.classList.toggle('open');
      if (willOpen) refreshSettingsModal();
    });
    settingsModal.addEventListener('click', (e) => {
      if (e.target === settingsModal) settingsModal.classList.remove('open');
    });
    const mealInput = document.getElementById('settings-meal-label-input');
    const addMealBtn = document.getElementById('settings-add-meal-label');
    const tagInput = document.getElementById('settings-tag-input');
    const addTagBtn = document.getElementById('settings-add-tag');
    if (addMealBtn && mealInput && handlers.onAddMealLabel) {
      addMealBtn.addEventListener('click', async () => {
        const label = mealInput.value.trim();
        if (!label) return;
        await handlers.onAddMealLabel(label);
        mealInput.value = '';
        await refreshSettingsModal();
      });
    }
    if (addTagBtn && tagInput && handlers.onAddTag) {
      addTagBtn.addEventListener('click', async () => {
        const tag = tagInput.value.trim();
        if (!tag) return;
        await handlers.onAddTag(tag);
        tagInput.value = '';
        await refreshSettingsModal();
      });
    }
  }

  if (recipeList && typeof handlers.onEditRecipeClick === 'function') {
    recipeList.addEventListener('click', (e) => {
      const editBtn = e.target.closest('.edit-btn');
      if (!editBtn) return;
      e.preventDefault();
      const card = editBtn.closest('.recipe-card');
      if (!card) return;
      const id = card.getAttribute('data-recipe-id') || editBtn.getAttribute('data-recipe-id');
      if (!id) return;
      handlers.onEditRecipeClick(id, card);
    });
  }

  if (addBtn && urlInput && handlers.onAddRecipe) {
    const btnText = addBtn.querySelector('.btn-text');
    const setBtnLabel = (text) => { if (btnText) btnText.textContent = text; else addBtn.textContent = text; };
    addBtn.addEventListener('click', async () => {
      const url = (urlInput.value || '').trim();
      if (!url) return;
      addBtn.disabled = true;
      addBtn.classList.add('is-adding');
      setBtnLabel(ADD_BTN_BUSY_LABEL);
      updateImportProgress(0);
      try {
        const saved = await handlers.onAddRecipe(url);
        if (saved && saved.id) urlInput.value = '';
      } finally {
        addBtn.disabled = false;
        addBtn.classList.remove('is-adding');
        setBtnLabel(ADD_BTN_LABEL);
        updateImportProgress(0);
      }
    });
  }

  if (exportBtn && handlers.onExportCookbook) {
    exportBtn.addEventListener('click', async () => {
      exportBtn.disabled = true;
      exportBtn.textContent = EXPORT_BTN_BUSY_LABEL;
      try {
        await handlers.onExportCookbook();
      } finally {
        exportBtn.disabled = false;
        exportBtn.textContent = EXPORT_BTN_LABEL;
      }
    });
  }

  if (fileInput && handlers.onImportCookbookFile) {
    fileInput.addEventListener('change', async (e) => {
      const file = e.target && e.target.files && e.target.files[0];
      if (!file) return;
      try {
        await handlers.onImportCookbookFile(file);
      } finally {
        fileInput.value = '';
      }
    });
  }
}
