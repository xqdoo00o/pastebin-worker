/** Runs synchronously in <head> to avoid a light-theme flash before the app mounts. */
export const DARK_MODE_SCRIPT = `(function() {
  const stored = localStorage.getItem('darkModeSelect') || 'system';
  const isDark = stored === 'dark' || (stored === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.classList.add(isDark ? 'dark' : 'light');
  root.style.colorScheme = isDark ? 'dark' : 'light';
  root.style.setProperty('background-color', isDark ? '#000' : '#fff');
  root.style.setProperty('color', isDark ? '#fff' : '#000');
})();`
