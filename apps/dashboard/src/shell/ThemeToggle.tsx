import { Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { saveTheme, type Theme } from './theme.js';

const current = (): Theme =>
  document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

/** Switches between the dark and light themes and remembers the choice. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(current);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  const label = `Switch to ${next} theme`;
  return (
    <button
      type="button"
      className="ghost icon-button"
      aria-label={label}
      title={label}
      onClick={() => {
        saveTheme(next);
        setTheme(next);
      }}
    >
      {theme === 'dark' ? (
        <Sun size={18} aria-hidden="true" />
      ) : (
        <Moon size={18} aria-hidden="true" />
      )}
    </button>
  );
}
