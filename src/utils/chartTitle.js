// Titles for exported charts. A PNG leaves the app without its selectors, so its title has
// to carry them: what the chart shows, then the choices that produced it.

/** Joins the parts of a title, dropping the ones that are empty for this selection. */
export function ttl(...parts) {
  return parts.filter(p => p != null && p !== '' && p !== false).join(' · ');
}

/** A scenario selection, short enough to stay a title. */
export function scenList(scenarios, max = 3) {
  const a = [...(scenarios || [])];
  if (!a.length) return '';
  return a.length > max ? `${a.slice(0, max).join(', ')} +${a.length - max}` : a.join(', ');
}
