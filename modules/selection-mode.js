/**
 * selection-mode.js — Manual selection overlay when automated parsing returns no recipes.
 * Renders page HTML, highlights ul/ol/div on hover, captures innerHTML on click and confirms.
 * Supports optional Manual Entry to add an ingredient to the current recipe (options.recipeId + options.onAddIngredient),
 * and can be opened from the main dashboard with html === null to show only the manual-entry flow.
 */

import { ensureNumber } from '../utils/recipeUtils.js';

const OVERLAY_CLASS = 'selection-mode-overlay';
const CONTENT_CLASS = 'selection-mode-content';
const HEADER_CLASS = 'selection-mode-header';
const HIGHLIGHT_CLASS = 'selection-mode-highlight';

function createSectionWrapper(className) {
  const wrap = document.createElement('div');
  if (className) wrap.className = className;
  wrap.style.marginTop = 'var(--mf-spacing-lg, 1.5rem)';
  wrap.style.paddingTop = 'var(--mf-spacing-md, 1rem)';
  wrap.style.borderTop = '1px solid var(--mf-border)';
  return wrap;
}

/** Strip script tags from HTML string for safe injection */
function stripScripts(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script').forEach((s) => s.remove());
  return doc.body ? doc.body.innerHTML : html;
}

/** Tag names that can be selected (headings for title, list/block for ingredients/instructions) */
const SELECTABLE_TAGS = ['H1', 'H2', 'H3', 'UL', 'OL', 'DIV'];

/** Find nearest parent that is a selectable element (max depth 15) */
function findSelectableParent(el) {
  let node = el;
  let depth = 0;
  while (node && node.nodeType === Node.ELEMENT_NODE && depth < 15) {
    const tag = node.tagName;
    if (SELECTABLE_TAGS.includes(tag)) return node;
    node = node.parentElement;
    depth++;
  }
  return null;
}

let overlayEl = null;
let contentEl = null;
let currentHighlight = null;
let confirmModalEl = null;
let onExtractCallback = null;

/** Three-step extraction: 'title' -> 'ingredients' -> 'instructions' */
let selectionState = 'title';
/** Stores HTML for each step: { title: '', ingredients: '', instructions: '' } */
let collectedData = { title: '', ingredients: '', instructions: '' };
let instructionHeaderEl = null;
let stepTextEl = null;

function removeHighlight() {
  if (currentHighlight) {
    currentHighlight.classList.remove(HIGHLIGHT_CLASS);
    currentHighlight = null;
  }
}

function closeOverlay() {
  if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
  }
  contentEl = null;
  removeHighlight();
  if (confirmModalEl) {
    confirmModalEl.remove();
    confirmModalEl = null;
  }
  onExtractCallback = null;
  selectionState = 'title';
  collectedData = { title: '', ingredients: '', instructions: '' };
  instructionHeaderEl = null;
  stepTextEl = null;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

const STEP_LABELS = {
  title: 'Step 1 of 3: Select the Recipe Title',
  ingredients: 'Step 2 of 3: Select the Ingredients',
  instructions: 'Step 3 of 3: Select the Instructions',
};

function getStepHeaderText() {
  return STEP_LABELS[selectionState] || STEP_LABELS.title;
}

function updateInstructionHeader() {
  if (stepTextEl) stepTextEl.textContent = getStepHeaderText();
}

function showCaptureFlash(el) {
  if (!el) return;
  el.style.setProperty('outline', '3px solid var(--mf-primary)', 'important');
  el.style.setProperty('background', 'color-mix(in srgb, var(--mf-primary) 15%, transparent)', 'important');
  setTimeout(() => {
    el.style.removeProperty('outline');
    el.style.removeProperty('background');
  }, 600);
}

const COMMON_UNITS = ['', 'cup', 'cups', 'tablespoon', 'tablespoons', 'tbsp', 'teaspoon', 'teaspoons', 'tsp', 'ounce', 'ounces', 'oz', 'g', 'gram', 'grams', 'clove', 'cloves', 'pinch', 'can', 'cans', 'slice', 'slices', 'pc'];

/**
 * Open the manual selection overlay. Three-step flow: title -> ingredients -> instructions.
 * @param {string} html - Page HTML (e.g. doc.body.innerHTML from failed parse)
 * @param {(data: { title: string, ingredients: string, instructions: string }) => void|Promise<void>} onExtract - Called with collectedData when step 3 is selected
 * @param {{ recipeId?: number, onAddIngredient?: (recipeId: number, ingredientLine: string) => void|Promise<void> }} [options] - Optional: recipeId + callback to add manual ingredient and refresh UI
 */
export function openSelectionMode(html, onExtract, options = {}) {
  closeOverlay();
  onExtractCallback = typeof onExtract === 'function' ? onExtract : () => {};
  const { recipeId, onAddIngredient } = options;
  selectionState = 'title';
  collectedData = { title: '', ingredients: '', instructions: '', imageFile: null, ingredientsList: [] };

  const safeHtml = html ? stripScripts(html) : '';
  const isManualMode = !html;

  overlayEl = document.createElement('div');
  overlayEl.className = OVERLAY_CLASS;
  overlayEl.setAttribute('role', 'dialog');
  overlayEl.setAttribute('aria-label', 'Selection Mode');

  const header = document.createElement('div');
  header.className = 'selection-mode-topbar';
  header.style.cssText = 'flex-shrink:0;padding:var(--mf-spacing-md, 1rem);background:var(--mf-surface);border-bottom:1px solid var(--mf-border);display:flex;align-items:center;flex-wrap:wrap;gap:var(--mf-spacing-sm, 0.5rem);font-family:var(--mf-font-family, inherit);';
  header.innerHTML = '<h2 style="margin:0;font-size:1.25rem;color:var(--mf-text);">Refine Import</h2>';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn cancel-edit-btn';
  closeBtn.textContent = 'Cancel';
  closeBtn.style.marginLeft = 'auto';
  closeBtn.addEventListener('click', () => closeSelectionMode());
  header.appendChild(closeBtn);
  overlayEl.appendChild(header);

  const wrap = document.createElement('div');
  wrap.style.cssText = 'flex:1;overflow:auto;padding:var(--mf-spacing-md, 1rem);';
  contentEl = document.createElement('div');
  contentEl.className = CONTENT_CLASS;
  contentEl.style.overflow = 'visible';
  instructionHeaderEl = document.createElement('div');
  instructionHeaderEl.className = HEADER_CLASS;
  instructionHeaderEl.style.cssText = 'position:sticky;top:0;z-index:10000;font-weight:bold;padding:var(--mf-spacing-md, 1rem);border-bottom:1px solid var(--mf-border);margin-bottom:var(--mf-spacing-lg, 1.25rem);background:var(--mf-surface);color:var(--mf-text);font-family:var(--mf-font-family, inherit);display:flex;align-items:center;justify-content:space-between;gap:var(--mf-spacing-sm, 0.5rem);';
  stepTextEl = document.createElement('span');
  stepTextEl.className = 'selection-mode-step-text';
  stepTextEl.textContent = isManualMode ? 'Manual entry: build your recipe details' : getStepHeaderText();
  instructionHeaderEl.appendChild(stepTextEl);
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'btn btn-primary selection-mode-reset-btn';
  resetBtn.textContent = 'Reset';
  resetBtn.title = 'Start over from Step 1';
  resetBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    selectionState = 'title';
    collectedData = { title: '', ingredients: '', instructions: '' };
    updateInstructionHeader();
  });
  instructionHeaderEl.appendChild(resetBtn);

  const refineImportCard = document.createElement('div');
  refineImportCard.className = 'refine-import-card';
  refineImportCard.appendChild(instructionHeaderEl);
  if (isManualMode) {
    // Manual dashboard mode: menu-driven entry (Title, Picture, Ingredients)
    const menu = document.createElement('div');
    menu.className = 'manual-entry-menu';
    menu.style.display = 'flex';
    menu.style.flexWrap = 'wrap';
    menu.style.gap = 'var(--mf-spacing-sm, 0.5rem)';
    menu.style.marginBottom = 'var(--mf-spacing-md, 1rem)';

    const btnTitle = document.createElement('button');
    btnTitle.type = 'button';
    btnTitle.className = 'btn selection-mode-manual-title-btn';
    btnTitle.textContent = 'Add Title';

    const btnPicture = document.createElement('button');
    btnPicture.type = 'button';
    btnPicture.className = 'btn selection-mode-manual-picture-btn';
    btnPicture.textContent = 'Add Picture';

    const btnIngredients = document.createElement('button');
    btnIngredients.type = 'button';
    btnIngredients.className = 'btn selection-mode-manual-ingredients-btn';
    btnIngredients.textContent = 'Add Ingredients';

    const btnInstructions = document.createElement('button');
    btnInstructions.type = 'button';
    btnInstructions.className = 'btn selection-mode-manual-instructions-btn';
    btnInstructions.textContent = 'Add Instructions';

    menu.appendChild(btnTitle);
    menu.appendChild(btnPicture);
    menu.appendChild(btnIngredients);
    menu.appendChild(btnInstructions);
    refineImportCard.appendChild(menu);

    // Title input
    const titleSection = createSectionWrapper('manual-entry-title-section');
    const titleWrap = document.createElement('div');
    titleWrap.className = 'manual-entry-title-wrap';
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.placeholder = 'Recipe title…';
    titleInput.setAttribute('aria-label', 'Recipe title');
    titleInput.value = collectedData.title || '';
    titleInput.addEventListener('input', () => {
      collectedData.title = titleInput.value.trim();
    });
    titleWrap.appendChild(titleInput);
    titleWrap.hidden = true;
    titleSection.appendChild(titleWrap);
    refineImportCard.appendChild(titleSection);

    // Picture input (hidden file input)
    const pictureSection = createSectionWrapper('manual-entry-picture-section');
    const pictureInfo = document.createElement('div');
    pictureInfo.className = 'manual-entry-picture-info';
    pictureInfo.textContent = 'No image selected';
    const pictureInput = document.createElement('input');
    pictureInput.type = 'file';
    pictureInput.accept = 'image/*';
    pictureInput.style.display = 'none';
    pictureInput.addEventListener('change', () => {
      const file = pictureInput.files && pictureInput.files[0];
      collectedData.imageFile = file || null;
      pictureInfo.textContent = file ? `Selected: ${file.name}` : 'No image selected';
    });
    pictureSection.appendChild(pictureInput);
    pictureSection.appendChild(pictureInfo);
    refineImportCard.appendChild(pictureSection);

    // Ingredients sub-view
    const ingSectionWrapper = createSectionWrapper('manual-entry-ingredients-section-wrapper');
    const ingSection = document.createElement('div');
    ingSection.className = 'manual-entry-ingredients-section';
    ingSection.hidden = true;
    const ingNameLabel = document.createElement('label');
    ingNameLabel.textContent = 'Ingredient Name';
    const ingNameInput = document.createElement('input');
    ingNameInput.type = 'text';
    ingNameInput.placeholder = 'e.g. diced onion';
    const ingQtyLabel = document.createElement('label');
    ingQtyLabel.textContent = 'Quantity';
    const ingQtyInput = document.createElement('input');
    ingQtyInput.type = 'number';
    ingQtyInput.step = 'any';
    ingQtyInput.min = '0';
    ingQtyInput.placeholder = 'e.g. 1 or 0.5';
    const ingUnitLabel = document.createElement('label');
    ingUnitLabel.textContent = 'Unit';
    const ingUnitSelect = document.createElement('select');
    COMMON_UNITS.forEach((u) => {
      const opt = document.createElement('option');
      opt.value = u;
      opt.textContent = u || '—';
      ingUnitSelect.appendChild(opt);
    });
    const ingAddBtn = document.createElement('button');
    ingAddBtn.type = 'button';
    ingAddBtn.className = 'btn selection-mode-manual-add-btn';
    ingAddBtn.textContent = 'Add';
    const ingList = document.createElement('ul');
    ingList.className = 'manual-entry-ingredients-list';

    function renderIngredientsList() {
      ingList.innerHTML = '';
      (collectedData.ingredientsList || []).forEach((item) => {
        const li = document.createElement('li');
        const parts = [item.quantity, item.unit, item.name].filter(Boolean).join(' ');
        li.textContent = parts;
        ingList.appendChild(li);
      });
    }

    ingAddBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = (ingNameInput.value || '').trim();
      const qtyRaw = (ingQtyInput.value || '').trim();
      const unit = (ingUnitSelect.value || '').trim();
      if (!name) return;
      let qtyNum = 1;
      if (qtyRaw !== '') {
        try {
          qtyNum = ensureNumber(qtyRaw);
        } catch (err) {
          console.warn('Manual entry (dashboard): invalid quantity', qtyRaw, err);
          return;
        }
      }
      const entry = { name, quantity: qtyNum, unit };
      collectedData.ingredientsList.push(entry);
      renderIngredientsList();
      ingNameInput.value = '';
      ingQtyInput.value = '';
      ingUnitSelect.value = '';
    });

    ingSection.appendChild(ingNameLabel);
    ingSection.appendChild(ingNameInput);
    ingSection.appendChild(ingQtyLabel);
    ingSection.appendChild(ingQtyInput);
    ingSection.appendChild(ingUnitLabel);
    ingSection.appendChild(ingUnitSelect);
    ingSection.appendChild(ingAddBtn);
    ingSection.appendChild(ingList);
    ingSectionWrapper.appendChild(ingSection);
    refineImportCard.appendChild(ingSectionWrapper);

    // Instructions sub-view
    const instSection = createSectionWrapper('manual-entry-instructions-section');
    const instWrap = document.createElement('div');
    instWrap.className = 'manual-entry-instructions-wrap';
    instWrap.hidden = true;
    const instLabel = document.createElement('label');
    instLabel.textContent = 'Instructions';
    const instTextarea = document.createElement('textarea');
    instTextarea.rows = 6;
    instTextarea.placeholder = 'Type the cooking instructions…';
    instTextarea.value = collectedData.instructions || '';
    instTextarea.addEventListener('input', () => {
      collectedData.instructions = instTextarea.value;
    });
    instWrap.appendChild(instLabel);
    instWrap.appendChild(instTextarea);
    instSection.appendChild(instWrap);
    refineImportCard.appendChild(instSection);

    // Menu button behavior
    btnTitle.addEventListener('click', () => {
      titleWrap.hidden = !titleWrap.hidden;
    });
    btnPicture.addEventListener('click', () => {
      pictureInput.click();
    });
    btnIngredients.addEventListener('click', () => {
      ingSection.hidden = !ingSection.hidden;
    });

    btnInstructions.addEventListener('click', () => {
      instWrap.hidden = !instWrap.hidden;
    });

    // Initialize list if there are pre-existing items
    if (Array.isArray(collectedData.ingredientsList) && collectedData.ingredientsList.length > 0) {
      renderIngredientsList();
    }

    // Save Recipe button (manual mode only)
    const saveWrap = createSectionWrapper('manual-entry-save-wrap');
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-primary manual-entry-save-btn';
    saveBtn.textContent = 'Save Recipe';
    saveBtn.style.width = '100%';
    saveBtn.addEventListener('click', () => {
      if (typeof onExtractCallback === 'function') {
        onExtractCallback({ ...collectedData });
      }
      closeOverlay();
    });
    saveWrap.appendChild(saveBtn);
    refineImportCard.appendChild(saveWrap);
  } else {
    // Refine Import mode (html provided): no dashboard manual UI here.
  }
  contentEl.appendChild(refineImportCard);
  if (!isManualMode) {
    const pageContent = document.createElement('div');
    pageContent.innerHTML = safeHtml;
    contentEl.appendChild(pageContent);
  }
  wrap.appendChild(contentEl);
  overlayEl.appendChild(wrap);

  const style = document.createElement('style');
  style.textContent = `
.${OVERLAY_CLASS} { position: fixed; top: 0; left: 0; width: 100%; height: 100%; overflow-y: auto; background: var(--mf-overlay); z-index: 9999; display: flex; flex-direction: column; font-family: var(--mf-font-family, inherit); }
.${CONTENT_CLASS} { background: var(--mf-surface); color: var(--mf-text); margin: 40px auto; padding: 40px; max-width: 800px; border-radius: var(--mf-border-radius); box-shadow: var(--mf-card-shadow); min-height: 200px; border: 1px solid var(--mf-border); }
.${HIGHLIGHT_CLASS} { outline: 2px solid var(--mf-primary) !important; background: color-mix(in srgb, var(--mf-primary) 15%, transparent) !important; cursor: pointer; position: relative; z-index: 1; }
.${OVERLAY_CLASS} input,
.${OVERLAY_CLASS} textarea,
.${OVERLAY_CLASS} select,
.${OVERLAY_CLASS} button {
  font-family: var(--mf-font-family, inherit);
  border-radius: var(--mf-border-radius, 8px);
  border: 1px solid var(--mf-border);
  padding: var(--mf-spacing-sm, 0.5rem);
}
.${OVERLAY_CLASS} input,
.${OVERLAY_CLASS} textarea,
.${OVERLAY_CLASS} select {
  width: 100%;
}
.${OVERLAY_CLASS} input:focus,
.${OVERLAY_CLASS} textarea:focus,
.${OVERLAY_CLASS} select:focus {
  outline: 2px solid var(--mf-primary);
  outline-offset: 1px;
  border-color: var(--mf-primary);
}
`;
  overlayEl.appendChild(style);

  if (!isManualMode) {
    // Only enable DOM selection/highlight in Refine Import mode
    contentEl.addEventListener('mousemove', (e) => {
      removeHighlight();
      const target = e.target;
      const selectable = findSelectableParent(target);
      if (selectable && contentEl.contains(selectable)) {
        selectable.classList.add(HIGHLIGHT_CLASS);
        currentHighlight = selectable;
      }
    });

    contentEl.addEventListener('mouseleave', removeHighlight);

    contentEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.target;
      const selectable = findSelectableParent(target);
      if (!selectable || !contentEl.contains(selectable) || typeof onExtractCallback !== 'function') return;
      const innerHTML = selectable.innerHTML;

      collectedData[selectionState] = innerHTML;
      showCaptureFlash(selectable);

      if (selectionState === 'instructions') {
        onExtractCallback({ ...collectedData });
        closeOverlay();
        return;
      }

      selectionState = selectionState === 'title' ? 'ingredients' : 'instructions';
      updateInstructionHeader();
    });
  }

  document.body.appendChild(overlayEl);
}

export function closeSelectionMode() {
  closeOverlay();
}
