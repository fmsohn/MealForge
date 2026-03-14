/**
 * parser.js — extract recipe data from a page URL.
 * Supports (1) JSON-LD Recipe and (2) header-based HTML sections (e.g. "Traditional Method", "Quick Method").
 * Returns an array of recipe objects; each has name, ingredients, instructions, url.
 */

import { normalizeIngredientsForStorage } from '../utils/recipeUtils.js';

/** Section titles to exclude from recipe blocks (case-insensitive) */
const IGNORED_SECTION_TITLES = /Serving Suggestions|Pairings|Tips/i;

/** Section titles that define a recipe block (case-insensitive) */
const RECIPE_SECTION_TITLES = /Method|Recipe/;

/** Sub-headings that introduce an ingredients list (case-insensitive) */
const INGREDIENTS_HEADING = /Ingredients/;

/** Sub-headings that introduce an instructions list (case-insensitive) */
const INSTRUCTIONS_HEADING = /Instructions|Directions|Steps/;

/**
 * Get trimmed text from an element (and its descendants).
 * @param {Element} el
 * @returns {string}
 */
function getTextContent(el) {
  return (el && el.textContent || '').trim();
}

/**
 * Collect sibling elements after a header until the next h2 or h3.
 * @param {Element} header - An h2 or h3 element
 * @returns {Element[]}
 */
function getSectionContent(header) {
  const block = [];
  let el = header.nextElementSibling;
  while (el && el.tagName !== 'H2' && el.tagName !== 'H3') {
    block.push(el);
    el = el.nextElementSibling;
  }
  return block;
}

/**
 * From a list element, collect all <li> text (trimmed, non-empty).
 * @param {Element} list - ul or ol
 * @returns {string[]}
 */
function listItemsToLines(list) {
  if (!list || !list.querySelectorAll) return [];
  const items = list.querySelectorAll('li');
  return Array.from(items).map((li) => getTextContent(li)).filter(Boolean);
}

/**
 * Collect all h3, h4, ul, ol descendants of block elements, in document order.
 * @param {Element[]} block
 * @returns {{ el: Element, type: 'heading'|'list' }[]}
 */
function collectHeadingsAndLists(block) {
  const found = [];
  for (const root of block) {
    if (root.tagName === 'H3' || root.tagName === 'H4') {
      found.push({ el: root, type: 'heading' });
      continue;
    }
    if (root.tagName === 'UL' || root.tagName === 'OL') {
      found.push({ el: root, type: 'list' });
      continue;
    }
    const nodes = root.querySelectorAll ? root.querySelectorAll('h3, h4, ul, ol') : [];
    for (const el of nodes) {
      const type = (el.tagName === 'H3' || el.tagName === 'H4') ? 'heading' : 'list';
      found.push({ el, type });
    }
  }
  found.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
  return found;
}

/**
 * Parse a section block (elements after a Method/Recipe header) into ingredients and instructions.
 * Looks for sub-headings "Ingredients" and "Instructions"/"Directions"/"Steps" and the next list after each.
 * @param {Element[]} block
 * @returns {{ ingredients: string[], instructions: string[] }}
 */
function parseBlockToIngredientsAndInstructions(block) {
  const ingredients = [];
  const instructions = [];
  let nextListIs = null; // 'ingredients' | 'instructions' | null
  const flushList = (list) => {
    const lines = listItemsToLines(list);
    if (nextListIs === 'ingredients') ingredients.push(...lines);
    else if (nextListIs === 'instructions') instructions.push(...lines);
    else instructions.push(...lines);
    nextListIs = null;
  };

  for (const { el, type } of collectHeadingsAndLists(block)) {
    if (type === 'heading') {
      const text = getTextContent(el);
      if (INGREDIENTS_HEADING.test(text)) nextListIs = 'ingredients';
      else if (INSTRUCTIONS_HEADING.test(text)) nextListIs = 'instructions';
      else nextListIs = null;
    } else {
      flushList(el);
    }
  }
  return { ingredients: normalizeIngredientsForStorage(ingredients), instructions };
}

/**
 * Parse document by h2/h3 sections: find headers containing Method/Recipe, exclude Serving Suggestions/Pairings/Tips.
 * @param {Document} doc
 * @param {string} url
 * @returns {{ name: string, ingredients: string[], instructions: string[], url: string }[]}
 */
function parseRecipeSectionsFromDocument(doc, url) {
  const headers = doc.querySelectorAll('h2, h3');
  const recipes = [];
  for (const header of headers) {
    const title = getTextContent(header);
    if (!title) continue;
    if (IGNORED_SECTION_TITLES.test(title)) continue;
    if (!RECIPE_SECTION_TITLES.test(title)) continue;
    const block = getSectionContent(header);
    const { ingredients, instructions } = parseBlockToIngredientsAndInstructions(block);
    if (ingredients.length === 0 && instructions.length === 0) continue;
    recipes.push({
      name: title,
      ingredients,
      instructions,
      url,
    });
  }
  return recipes;
}

/**
 * Find the first Recipe in a JSON-LD node (handles @graph, array, or single object).
 * @param {object} node - Parsed JSON-LD node
 * @returns {object|null} - Recipe object with name, recipeIngredient, or null
 */
function findRecipeInNode(node) {
  if (!node || typeof node !== 'object') return null;
  const type = node['@type'];
  const types = Array.isArray(type) ? type : (type ? [type] : []);
  if (types.some(t => t === 'Recipe' || (typeof t === 'string' && t.endsWith('Recipe'))))
    return node;
  if (Array.isArray(node['@graph'])) {
    for (const item of node['@graph']) {
      const recipe = findRecipeInNode(item);
      if (recipe) return recipe;
    }
  }
  return null;
}

/**
 * Get a single image URL from JSON-LD image field (string, array of strings, or object with url).
 * @param {string|string[]|{ url?: string }|Array<{ url?: string }>} image - Schema.org image value
 * @returns {string} - URL or empty string
 */
function getImageUrl(image) {
  if (!image) return '';
  if (typeof image === 'string') return image.trim();
  if (Array.isArray(image) && image.length > 0) {
    const first = image[0];
    if (typeof first === 'string') return first.trim();
    if (first && typeof first === 'object' && first.url) return String(first.url).trim();
    return '';
  }
  if (typeof image === 'object' && image.url) return String(image.url).trim();
  return '';
}

/**
 * Normalize recipe payload to { name, ingredients, url, instructions, image }.
 * @param {object} recipe - Schema.org Recipe-like object
 * @param {string} url - Source URL
 * @returns {{ name: string, ingredients: string[], url: string, instructions?: string[], image?: string }}
 */
function normalizeRecipe(recipe, url) {
  const name = recipe.name || recipe.title || 'Untitled Recipe';
  const raw = recipe.recipeIngredient;
  const rawIngredients = Array.isArray(raw)
    ? raw.map(i => (typeof i === 'string' ? i : String(i)).trim()).filter(Boolean)
    : [];
  const ingredients = normalizeIngredientsForStorage(rawIngredients);
  const rawSteps = recipe.recipeInstructions;
  let instructions = [];
  if (Array.isArray(rawSteps)) {
    instructions = rawSteps
      .map((s) => (typeof s === 'string' ? s : s && s.text ? s.text : ''))
      .filter(Boolean);
  } else if (typeof rawSteps === 'string') {
    instructions = [rawSteps];
  }
  const image = getImageUrl(recipe.image);
  return { name: String(name), ingredients, url, instructions, image: image || undefined };
}

/** CORS proxies to try in order; on non-200 (e.g. 403), the next is used. */
const CORS_PROXIES = [
  'https://corsproxy.io/?url=',
  'https://api.allorigins.win/get?url=',
  'https://thingproxy.freeboard.io/fetch/',
];
const FETCH_TIMEOUT_MS = 10000;
const COOLDOWN_SECONDS = 6;
const COOLDOWN_STORAGE_KEY = 'last_recipe_import';

/**
 * Check whether a new import is allowed based on 6-second cooldown.
 * @returns {{ allowed: boolean, remaining: number }} - remaining is seconds left (0 if allowed)
 */
function checkCooldown() {
  if (typeof localStorage === 'undefined') return { allowed: true, remaining: 0 };
  const raw = localStorage.getItem(COOLDOWN_STORAGE_KEY);
  const last = raw ? parseInt(raw, 10) : 0;
  const elapsed = (Date.now() - last) / 1000;
  const remaining = Math.max(0, COOLDOWN_SECONDS - elapsed);
  return { allowed: remaining <= 0, remaining: Math.ceil(remaining) };
}

/**
 * Record that an import was started (for cooldown). Call after checkCooldown() allows.
 */
function setCooldownTimestamp() {
  if (typeof localStorage !== 'undefined') localStorage.setItem(COOLDOWN_STORAGE_KEY, String(Date.now()));
}

/**
 * Fetch a URL via CORS proxies with fallback. Tries each proxy until one returns 200.
 * For api.allorigins.win, parses JSON and extracts the 'contents' field.
 * @param {string} targetUrl - The final URL to fetch
 * @param {AbortSignal} signal - AbortSignal for timeout/cancel
 * @returns {Promise<string>} - HTML (or other body) as string
 * @throws {Error} - If all proxies fail or no proxy returns OK
 */
async function fetchWithProxyFallback(targetUrl, signal) {
  const encodedUrl = encodeURIComponent(targetUrl);
  let lastError = null;
  for (const proxyPrefix of CORS_PROXIES) {
    const proxyUrl = proxyPrefix + encodedUrl;
    try {
      const res = await fetch(proxyUrl, { signal });
      if (!res.ok) {
        lastError = new Error(`Proxy returned ${res.status} ${res.statusText}`);
        continue;
      }
      const isAllOrigins = proxyPrefix.includes('allorigins');
      if (isAllOrigins) {
        const json = await res.json();
        const contents = json && json.contents;
        if (typeof contents !== 'string') {
          lastError = new Error('AllOrigins proxy returned invalid contents');
          continue;
        }
        return contents;
      }
      return await res.text();
    } catch (err) {
      lastError = err;
      continue;
    }
  }
  throw lastError || new Error('All proxies failed');
}

/**
 * Get primary image URL for the page: og:image first, then first <img> src.
 * Call before scrubHtml(doc) since scrubbing removes img tags.
 * @param {Document} doc - Parsed document
 * @returns {string} Image URL or empty string
 */
function getPrimaryImage(doc) {
  if (!doc || !doc.head) return '';
  const ogImage = doc.querySelector('meta[property="og:image"]');
  if (ogImage && ogImage.getAttribute('content')) {
    const url = (ogImage.getAttribute('content') || '').trim();
    if (url) return url;
  }
  const firstImg = doc.querySelector('img');
  if (firstImg && firstImg.getAttribute('src')) {
    const url = (firstImg.getAttribute('src') || '').trim();
    if (url) return url;
  }
  return '';
}

/** Tag names to remove from the document (heavy / non-text). */
const HEAVY_TAGS = ['script', 'style', 'link', 'svg', 'img', 'picture', 'video', 'audio', 'iframe', 'canvas', 'noscript', 'map'];

/** Attributes to keep on elements: id, class; on links (a) keep href (source URL). */
function keepAttr(el, name) {
  if (name === 'id' || name === 'class') return true;
  if (el.tagName === 'A' && name === 'href') return true;
  return false;
}

/**
 * Clean HTML for storage: remove heavy elements and strip attributes except id, class, and href on links.
 * Mutates the document. Call before using doc for section parsing so parsing runs on a clean tree.
 * @param {Document} doc - Parsed document
 * @returns {string} doc.body.innerHTML after scrubbing
 */
function scrubHtml(doc) {
  const body = doc.body;
  if (!body) return '';

  for (const tag of HEAVY_TAGS) {
    const list = body.querySelectorAll(tag);
    list.forEach((el) => el.remove());
  }

  const all = [body, ...body.querySelectorAll('*')];
  all.forEach((el) => {
    const names = Array.from(el.attributes).map((a) => a.name);
    for (const name of names) {
      if (!keepAttr(el, name)) el.removeAttribute(name);
    }
  });

  return body.innerHTML;
}

/**
 * Quality gate for JSON-LD Recipe: must have both recipeIngredient and recipeInstructions;
 * instructions must look like real steps, not category lists (e.g. 'Beef', 'Chicken').
 * @param {object} recipe - Raw Recipe node from JSON-LD
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateJsonLdRecipe(recipe) {
  const ingredients = recipe.recipeIngredient;
  const instructions = recipe.recipeInstructions;
  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return { valid: false, reason: 'missing or empty recipeIngredient' };
  }
  if (!Array.isArray(instructions) || instructions.length === 0) {
    console.log('[parser] JSON-LD rejected due to missing instructions');
    return { valid: false, reason: 'missing or empty recipeInstructions' };
  }
  const instructionTexts = instructions
    .map((s) => (typeof s === 'string' ? s : s && s.text ? s.text : ''))
    .map((s) => s.trim())
    .filter(Boolean);
  if (instructionTexts.length === 0) {
    console.log('[parser] JSON-LD rejected due to missing instructions');
    return { valid: false, reason: 'no instruction text' };
  }
  const looksLikeCategories = instructionTexts.every((t) => t.split(/\s+/).length <= 2 && t.length < 25);
  if (looksLikeCategories) {
    console.log('[parser] Poor Quality JSON-LD: instructions look like category list (e.g. Beef, Chicken)');
    return { valid: false, reason: 'instructions look like categories' };
  }
  return { valid: true };
}

/**
 * Classify an error and return a user-facing message. Logs the actual error to console.
 * @param {Error} err
 * @returns {string}
 */
function toUserMessage(err) {
  const msg = err && err.message ? err.message : String(err);
  console.error('[parser] Error:', msg, err);
  if (err && err.name === 'AbortError') {
    console.error('Request timed out after 20s');
    return 'Request timed out';
  }
  const lower = msg.toLowerCase();
  if (lower.includes('failed to fetch') || lower.includes('network') || lower.includes('cors') || lower.includes('load')) return 'Network or CORS error';
  if (err instanceof SyntaxError || lower.includes('json') || lower.includes('parse')) return 'Parsing error';
  return msg;
}

/**
 * Extract recipe data from a URL. Strict priority: (1) JSON-LD, (2) section-based parsing, (3) skeleton.
 * Always returns an array containing exactly one recipe object (or an error object).
 *
 * @param {string} url - Full URL of the recipe page
 * @returns {Promise<Array<{ name: string, ingredients: string[], instructions: string[], url: string, sourceHtml: string, imageUrl: string }>|{ status: 'error', message: string }>}
 */
export async function extractRecipeFromUrl(url) {
  console.log('[parser] extractRecipeFromUrl called with URL:', url);
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    console.log('[parser] Offline — returning error status');
    return { status: 'error', message: 'You are currently offline. Please check your connection.' };
  }
  const cooldown = checkCooldown();
  if (!cooldown.allowed) {
    return {
      status: 'error',
      message: `To keep our import service reliable for everyone, please wait ${cooldown.remaining} seconds before the next recipe.`,
    };
  }
  setCooldownTimestamp();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  console.log('[parser] Starting request via proxy fallback...');
  console.time('ImportDuration');
  try {
    const html = await fetchWithProxyFallback(url, controller.signal);
    clearTimeout(timeoutId);
    if (!html || !html.trim()) {
      console.error('[parser] Proxy returned no contents for:', url);
      console.log('[parser] Returning skeleton recipe (no content)');
      console.timeEnd('ImportDuration');
      return [{ name: 'Imported Recipe', url, sourceHtml: '', imageUrl: '', ingredients: [], instructions: [] }];
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const imageUrl = getPrimaryImage(doc);

    // 1. Early exit: JSON-LD (must run before scrub, which removes script tags)
    let jsonLdRecipe = null;
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent.trim());
        const nodes = Array.isArray(data) ? data : [data];
        for (const node of nodes) {
          const recipe = findRecipeInNode(node);
          if (recipe) {
            const validation = validateJsonLdRecipe(recipe);
            if (!validation.valid) {
              console.log('[parser] Poor Quality JSON-LD:', validation.reason);
              continue;
            }
            jsonLdRecipe = recipe;
            break;
          }
        }
        if (jsonLdRecipe) break;
      } catch (_) {
        continue;
      }
    }

    const scrubbedHtml = scrubHtml(doc);

    if (jsonLdRecipe) {
      const out = normalizeRecipe(jsonLdRecipe, url);
      console.log('[parser] Returning 1 recipe from JSON-LD');
      console.timeEnd('ImportDuration');
      return [{ ...out, sourceHtml: scrubbedHtml, imageUrl }];
    }

    // 2. Fallback: section-based parsing (first valid section only)
    const fromSections = parseRecipeSectionsFromDocument(doc, url);
    if (fromSections.length > 0) {
      const first = fromSections[0];
      console.log('[parser] Returning 1 recipe from sections (first of ' + fromSections.length + ')');
      console.timeEnd('ImportDuration');
      return [{ ...first, sourceHtml: scrubbedHtml, imageUrl }];
    }

    // 3. Final fallback: skeleton
    console.log('[parser] Returning skeleton recipe (no JSON-LD or sections)');
    console.timeEnd('ImportDuration');
    return [{ name: 'Imported Recipe', url, sourceHtml: scrubbedHtml, imageUrl, ingredients: [], instructions: [] }];
  } catch (err) {
    clearTimeout(timeoutId);
    console.timeEnd('ImportDuration');
    if (err && err.name === 'AbortError') {
      console.log('[parser] Request timed out (proxy unresponsive)');
      return { status: 'error', message: 'Request timed out. Please check your connection and try again.' };
    }
    const msg = err && err.message ? err.message : String(err);
    const isProxyBlocked =
      /proxy returned|all proxies failed|allorigins proxy returned invalid/i.test(msg);
    const userMsg = isProxyBlocked
      ? 'This website is currently blocking automatic imports. Please try importing from a different source or use the manual selection tool.'
      : toUserMessage(err);
    return { status: 'error', message: userMsg };
  }
}

/**
 * Parse raw HTML from manual selection into ingredients and instructions (for use with normalizeIngredientsForStorage).
 * Extracts all <li> text; normalizes as ingredients and keeps same list as instructions.
 * @param {string} html - Raw innerHTML of the selected container
 * @returns {{ ingredients: string[], instructions: string[] }}
 */
export function parseSelectionHtml(html) {
  if (!html || typeof html !== 'string') return { ingredients: [], instructions: [] };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const items = doc.querySelectorAll('li');
  const lines = Array.from(items).map((li) => (li.textContent || '').trim()).filter(Boolean);
  const ingredients = normalizeIngredientsForStorage(lines);
  const instructions = lines.slice();
  return { ingredients, instructions };
}
