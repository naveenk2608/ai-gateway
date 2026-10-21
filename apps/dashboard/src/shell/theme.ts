/** The colour theme (ADR 020): dark by default; the viewer's choice is kept in localStorage. */
export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'ai-gateway.theme';

export function storedTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    // Storage can be unavailable (privacy settings); the default applies.
    return 'dark';
  }
}

/** Switches the tokens in tokens.css by setting `data-theme` on <html>. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Without storage the choice lasts until the page is reloaded.
  }
}
