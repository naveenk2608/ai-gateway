/** Small viewer preferences kept in localStorage; every read and write survives no storage. */
export function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Without storage the preference lasts until the page is reloaded.
  }
}
