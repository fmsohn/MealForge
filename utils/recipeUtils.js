/**
 * recipeUtils.js — ingredient parsing, normalization, and display formatting.
 * Used by db.js, parser.js, ui.js, and app.js. All paths are relative (ES modules).
 */

/** Known unit words (lowercase) for Stage 2: only the word immediately after quantity is checked. */
const KNOWN_UNITS = new Set([
  'cup', 'cups', 'tablespoon', 'tablespoons', 'tbsp', 'teaspoon', 'teaspoons', 'tsp',
  'ounce', 'ounces', 'oz', 'pound', 'pounds', 'lb', 'gram', 'grams', 'g',
  'clove', 'cloves', 'pinch', 'pinches', 'can', 'cans', 'slice', 'slices',
  'stalk', 'stalks', 'piece', 'pieces', 'large', 'small', 'medium',
]);

/**
 * Regex: leading quantity — whole numbers, decimals (0.5, .5), fractions (1/2, 1 1/2), range (1-2).
 * First alt: decimal (optional spaces around dot); second: decimal/fraction; third: mixed number.
 */
const LEADING_QUANTITY_REGEX = /^(\d*\s*\.\s*\d+|\d*\.?\d+(?:\s?\/\s?\d+)?|\d+\s\d+\/\d+)(?:\s*-\s*(\d*\s*\.\s*\d+|\d*\.?\d+(?:\s?\/\s?\d+)?|\d+\s\d+\/\d+))?\s*/;

/** Remove internal spaces from a quantity token so "0 .5" becomes "0.5" before parsing. */
function normalizeQuantityToken(str) {
  if (str == null) return '';
  return String(str).replace(/\s+/g, '').trim();
}

/**
 * Coerce a quantity to a Number for math. Strips spaces so "0 .5" or "0 . 5" becomes 0.5.
 * Use before any arithmetic or before saving to DB. Returns NaN if not parseable.
 * @param {string|number} quantity
 * @returns {number}
 */
export function toNumericQuantity(quantity) {
  const s = String(quantity).replace(/\s+/g, '');
  return parseFloat(s);
}

/**
 * Strict numeric coercion for storage/pipeline. Throws if value is not a valid number.
 * @param {string|number} value
 * @returns {number}
 */
export function ensureNumber(value) {
  const n = toNumericQuantity(value);
  if (Number.isNaN(n)) throw new Error('Invalid number: ' + value);
  return n;
}

/**
 * Parse an ingredient line into quantity, unit, and ingredient name.
 * Uses sanitization, then tokenized stages: quantity → optional unit (next word) → remainder as name.
 * Handles "12 ounces dried black beans", "1 bay leaf", "1-2 cloves garlic", "salt and pepper".
 * @param {string} line - Single ingredient string
 * @returns {{ quantity?: number, quantityEnd?: number, unit?: string, ingredient: string }}
 */
export function parseIngredient(line) {
  const original = typeof line === 'string' ? line : String(line);
  try {
    const raw = sanitizeIngredientLine(original);
    if (!raw) return { ingredient: '' };

    const result = { ingredient: raw };

    // Stage 1 (Quantity): regex extract → normalize spaces → parseFraction (or parseFloat) → number
    const numberMatch = raw.match(LEADING_QUANTITY_REGEX);
    let rest = raw;
    if (numberMatch) {
      const qty1Token = normalizeQuantityToken(numberMatch[1]);
      const q1 = parseFraction(qty1Token);
      if (Number.isFinite(q1)) {
        result.quantity = q1;
        if (numberMatch[2]) {
          const qty2Token = normalizeQuantityToken(numberMatch[2]);
          const q2 = parseFraction(qty2Token);
          if (Number.isFinite(q2)) result.quantityEnd = q2;
        }
      }
      rest = raw.slice(numberMatch[0].length).trim();
    }

    if (!rest) {
      return result;
    }

    // Stage 2 (Unit): next token is unit only if it's in KNOWN_UNITS
    const nextWordMatch = rest.match(/^(\S+)(?:\s+(.*))?$/s);
    const firstWord = nextWordMatch ? nextWordMatch[1].toLowerCase() : '';
    const afterFirstWord = (nextWordMatch && nextWordMatch[2] !== undefined) ? nextWordMatch[2].trim() : '';

    if (KNOWN_UNITS.has(firstWord)) {
      result.unit = firstWord;
      result.ingredient = afterFirstWord;
    } else {
      result.ingredient = rest;
    }

    // Debug: warn if we had a quantity but ended up with no clean ingredient name
    if (Number.isFinite(result.quantity) && (!result.ingredient || !result.ingredient.trim())) {
      console.warn('parseIngredient: quantity found but no ingredient name —', original);
    }

    return result;
  } catch (err) {
    console.warn('parseIngredient failed for:', original, err);
    return { ingredient: sanitizeIngredientLine(original) || original.trim() };
  }
}

/**
 * Parse a fraction string to a number (e.g. "1/2" -> 0.5, "1 1/2" -> 1.5).
 * @param {string} s
 * @returns {number}
 */
function parseFraction(s) {
  if (s == null) return NaN;
  const t = String(s).trim();
  const whole = t.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (whole) {
    const w = parseInt(whole[1], 10);
    const n = parseInt(whole[2], 10);
    const d = parseInt(whole[3], 10);
    return d ? w + n / d : w;
  }
  const simple = t.match(/^(\d+)\/(\d+)$/);
  if (simple) {
    const n = parseInt(simple[1], 10);
    const d = parseInt(simple[2], 10);
    return d ? n / d : NaN;
  }
  const num = parseFloat(t);
  return Number.isFinite(num) ? num : NaN;
}

/** Map common Unicode fraction chars to decimal string for sanitization */
const UNICODE_FRACTIONS = {
  '\u00BC': '0.25',  // ¼
  '\u00BD': '0.5',   // ½
  '\u00BE': '0.75',  // ¾
  '\u2153': '0.333', // ⅓
  '\u2154': '0.667', // ⅔
  '\u215B': '0.125', // ⅛
  '\u215C': '0.375', // ⅜
  '\u215D': '0.625', // ⅝
  '\u215E': '0.875', // ⅞
};

/** Checkbox and list-decorator characters to strip from recipe ingredient lines (before regex/tokenization). */
const CHECKBOX_AND_DECORATOR_REGEX = /[▢☐☑✔☒\u2610\u2611\u2612\u2713\u2714]/g;

/**
 * Sanitize a single line: strip checkbox/UI chars, non-breaking spaces, trim, normalize Unicode fractions, collapse spaces.
 * Runs before any regex or tokenization so decorators do not interfere with LEADING_QUANTITY_REGEX.
 * @param {string} line
 * @returns {string}
 */
function sanitizeIngredientLine(line) {
  let s = (typeof line === 'string' ? line : String(line))
    .replace(CHECKBOX_AND_DECORATOR_REGEX, '')
    .replace(/\u00A0/g, ' ')
    .trim();
  Object.keys(UNICODE_FRACTIONS).forEach((char) => {
    s = s.replace(new RegExp(char, 'g'), UNICODE_FRACTIONS[char]);
  });
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Regex: (quantity)(optional unit)(ingredient name).
 * Quantity: digits, optional fraction (1/2, 1 1/2), or decimal.
 * Unit: optional known unit word.
 * Name: rest of line.
 */
const NORMALIZE_INGREDIENT_REGEX = new RegExp(
  '^' +
  '(\\d+(?:\\s+\\d+\\/\\d+|\\/\\d+)?|\\d*\\s*\\.\\s*\\d+)' +  // Group 1: quantity (decimal may have spaces around dot)
  '\\s+' +
  '(?:(cups?|tablespoons?|tbsp|teaspoons?|tsp|ounces?|oz|pounds?|lb|grams?|g|cloves?|pinches?|cans?|slices?|stalks?|pieces?|large|small|medium)\\b\\s+)?' +  // Group 2: optional unit
  '(.+)$',  // Group 3: ingredient name
  'i'
);

/**
 * Normalize ingredient strings for storage: sanitize, parse quantity/unit/name, reassemble consistently.
 * Quantity is stored as decimal; optional unit; rest as ingredient name. Fallback: quantity + rest as name.
 * @param {string[]} raw - Array of ingredient strings
 * @returns {string[]}
 */
export function normalizeIngredientsForStorage(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const line = sanitizeIngredientLine(item);
      if (!line) return null;

      const match = line.match(NORMALIZE_INGREDIENT_REGEX);
      if (!match) {
        console.warn('Failed to parse line:', line);
        return line;
      }

      const qtyStr = normalizeQuantityToken(match[1]);
      const unit = match[2] ? match[2].trim().toLowerCase() : '';
      const name = match[3].trim();

      const qtyNum = parseFraction(qtyStr);
      // Single continuous numeric string (no space): e.g. "0.5" not "0 .5"
      const qtyDisplay = Number.isFinite(qtyNum) ? parseFloat(qtyNum).toString() : normalizeQuantityToken(qtyStr);
      const parts = [qtyDisplay, unit, name].filter(Boolean);
      return parts.join(' ');
    })
    .filter(Boolean);
}

/**
 * Format an ingredient line for display, applying a scale factor to the leading quantity.
 * @param {string} ing - Stored ingredient string (e.g. "2 cups flour")
 * @param {number} scale - Scale factor (1, 2, 3)
 * @returns {string}
 */
export function formatIngredientDisplay(ing, scale) {
  const parsed = parseIngredient(ing);
  const multiplier = Math.max(1, Number(scale) || 1);
  const rawQ1 = parsed.quantity ?? 0;
  const rawQ2 = parsed.quantityEnd;
  const parsedQ1 = parseFloat(String(rawQ1).replace(/\s+/g, ''));
  const parsedQ2 = rawQ2 != null && Number.isFinite(rawQ2) ? parseFloat(String(rawQ2).replace(/\s+/g, '')) : null;
  if (!Number.isFinite(parsedQ1) && parsedQ2 == null) {
    return parsed.ingredient || ing;
  }
  const scaled = Number.isFinite(parsedQ1) ? parsedQ1 * multiplier : 0;
  const scaledEnd = parsedQ2 != null ? parsedQ2 * multiplier : null;
  const qtyStr = scaledEnd != null ? `${formatQuantity(scaled)}–${formatQuantity(scaledEnd)}` : formatQuantity(scaled);
  const parts = [qtyStr, parsed.unit, parsed.ingredient].filter(Boolean);
  return parts.join(' ');
}

/**
 * Standard cooking fraction denominators (1/2, 1/3, 1/4, 1/6, 1/8 and their multiples).
 * Used to round approximate decimals to the nearest readable fraction.
 */
const COOKING_FRACTION_DENOMS = [2, 3, 4, 6, 8];

/**
 * Tolerance for rounding to a standard fraction.
 * e.g. 0.33333 → 1/3, 0.49 → 1/2. Use at display layer only; db and math keep raw Number.
 */
const FRACTION_TOLERANCE = 0.05;

/**
 * Converts a decimal fractional part (0–1) to the nearest standard cooking fraction string.
 * Rounds using FRACTION_TOLERANCE (e.g. 0.33333 → "1/3", 0.49 → "1/2"). Returns '' if negligible.
 * @param {number} frac - Fractional part, 0 <= frac < 1
 * @returns {string} e.g. "1/4", "1/3", "1/2", "2/3", "3/4", "" or decimal fallback
 */
function fractionToDisplayString(frac) {
  if (frac < 0.001) return '';
  for (const d of COOKING_FRACTION_DENOMS) {
    const num = Math.round(frac * d);
    if (num >= d) continue;
    const value = num / d;
    if (Math.abs(value - frac) <= FRACTION_TOLERANCE) return num + '/' + d;
  }
  return String(Math.round(frac * 1000) / 1000);
}

/**
 * Formats a numeric quantity for display only. Does not modify stored data.
 * Use at the render layer; generateShoppingList, scaleRecipe, and db.js must keep using raw ingredient.quantity (Number).
 *
 * Handles:
 * - Whole numbers: 1 → "1"
 * - Common cooking fractions: 0.25 → "1/4", 0.333… → "1/3", 0.5 → "1/2", 0.667… → "2/3", 0.75 → "3/4"
 * - Mixed numbers: 1.5 → "1 1/2", 1.333 → "1 1/3"
 *
 * Uses a rounding tolerance (0.05) so values like 0.33333 display as "1/3" and 0.49 as "1/2".
 *
 * @param {number} qty - Raw decimal quantity (e.g. from DB or scaled math)
 * @returns {string}
 */
export function formatQuantityForDisplay(qty) {
  const n = Number(qty);
  if (!Number.isFinite(n)) return '';
  if (n <= 0) return '0';
  const whole = Math.floor(n);
  const frac = n - whole;
  const fracStr = fractionToDisplayString(frac);
  if (whole === 0) return fracStr || '0';
  if (!fracStr || frac < 0.001) return String(whole);
  return whole + ' ' + fracStr;
}

/**
 * Format a numeric quantity for display (delegates to formatQuantityForDisplay for consistency).
 * @param {number} qty
 * @returns {string}
 */
export function formatQuantity(qty) {
  return formatQuantityForDisplay(qty);
}
