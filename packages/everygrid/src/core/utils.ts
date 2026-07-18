import {I18n} from '../i18n/I18n';

/**
 * Sanitizes a JSON-like string by replacing non-standard values like Infinity and NaN with their string equivalents.
 */
const sanitizeJsonString = (val: string): string => {
  return val.replace(/:\s*(-?Infinity|NaN)\b/g, ': "$1"')
    .replace(/\[\s*(-?Infinity|NaN)\b/g, '["$1"')
    .replace(/,\s*(-?Infinity|NaN)\b/g, ', "$1"');
};

/**
 * Checks if a value is a valid JSON string that represents an object or array.
 * Supports non-standard JSON values like Infinity and NaN for better developer experience.
 */
export const isJsonString = (val: unknown): boolean => {
  if (typeof val !== 'string') { return false; }
  const trimmed = val.trim();
  if (!((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) {
    return false;
  }
  try {
    // Replace non-standard JSON values with null to check for structural validity
    const sanitized = sanitizeJsonString(val);
    const parsed = JSON.parse(sanitized);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
};

/**
 * Parses a value if it's a valid JSON string, otherwise returns the value as is.
 * Supports non-standard JSON values like Infinity and NaN by converting them to null.
 */
// Full ISO datetime (with a time part) → "YYYY-MM-DD HH:mm:ss". Drops milliseconds and the
// timezone suffix and does NOT convert timezones (pure string cleanup). Date-only values and
// any non-ISO string are returned unchanged.
const ISO_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;
export const formatIsoTimestamp = (val: string): string => {
  const m = ISO_DATETIME_RE.exec(val);
  return m ? `${m[1]} ${m[2]}` : val;
};

export const parseIfJson = (val: unknown): unknown => {
  if (isJsonString(val)) {
    try {
      const sanitized = sanitizeJsonString(val as string);
      return JSON.parse(sanitized);
    } catch {
      return val;
    }
  }
  return val;
};

/**
 * Determines if an object/array is too complex to be rendered in-place.
 */
export const isTooComplex = (val: unknown): boolean => {
  if (typeof val !== 'object' || val === null) { return false; }
  if (Array.isArray(val)) {
    if (val.length > 5) { return true; }
    return val.some(item => typeof item === 'object' && item !== null);
  }
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length > 5) { return true; }
  return keys.some(key => typeof obj[key] === 'object' && obj[key] !== null);
};

/**
 * Generates a summary label for objects and arrays.
 */
export const getSummaryLabel = (val: unknown): string => {
  if (Array.isArray(val)) {
    // Check for array of same single key objects
    if (val.length > 1 && val.every(item => typeof item === 'object' && item !== null && Object.keys(item as object).length === 1)) {
      const firstKey = Object.keys(val[0] as object)[0];
      if (val.every(item => Object.keys(item as object)[0] === firstKey)) {
        return `${firstKey}[] (${val.length})`;
      }
    }
    return I18n.t('popup.itemsCount', {count: val.length});
  }

  if (typeof val === 'object' && val !== null) {
    const keys = Object.keys(val as object);
    if (keys.length <= 3) {
      return keys.join(', ');
    }
    return keys.slice(0, 3).join(', ') + '...';
  }

  return String(val);
};

/**
 * Checks if a value is a valid XML string.
 */
export const isXmlString = (val: unknown): boolean => {
  if (typeof val !== 'string') { return false; }
  const trimmed = val.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>') && trimmed.includes('</');
};
