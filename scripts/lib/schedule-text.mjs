// scripts/lib/schedule-text.mjs
// Single source of truth for cleaning schedule-block field values.
// The content agent emits markdown: **bold** and `code-ticks`. Older parsers
// only stripped ** which left literal backticks in photo_file, so posters looked
// for a file named `` `name.JPG` `` and silently fell back to text. Strip both.

const BLANK_RE = /^\*?\(?\s*blank\s*\)?\*?$/i; // matches (blank), *(blank)*, blank
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i;

export function cleanField(str) {
  return (str || '')
    .replace(/\*\*/g, '')   // bold
    .replace(/`/g, '')      // code ticks
    .trim();
}

export function normalizePhotoFile(raw) {
  const v = cleanField(raw);
  if (!v) return '';
  if (BLANK_RE.test(v)) return '';
  // Defensive: a leaked prompt or label is not a filename. Only accept values
  // that look like an image file (have a known image extension).
  if (!IMAGE_EXT_RE.test(v)) return '';
  return v;
}
