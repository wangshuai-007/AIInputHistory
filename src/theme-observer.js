(function initializeThemeObserver(namespace) {
  "use strict";

  function observePageTheme(host) {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => { host.dataset.theme = detectPageTheme(media.matches); };
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-color-mode"] });
    if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-color-mode"] });
    media.addEventListener?.("change", sync);
    sync();
    return () => {
      observer.disconnect();
      media.removeEventListener?.("change", sync);
    };
  }

  function detectPageTheme(systemDark) {
    const signals = [
      document.documentElement.className,
      document.documentElement.getAttribute("data-theme"),
      document.documentElement.getAttribute("data-color-mode"),
      document.body?.className,
      document.body?.getAttribute("data-theme"),
      document.body?.getAttribute("data-color-mode")
    ].filter((value) => typeof value === "string").join(" ").toLocaleLowerCase();
    if (/(^|\s)(dark|night)(\s|$)/.test(signals)) return "dark";
    if (/(^|\s)light(\s|$)/.test(signals)) return "light";

    const declaredScheme = getComputedStyle(document.documentElement).colorScheme;
    if (declaredScheme === "dark") return "dark";
    if (declaredScheme === "light") return "light";

    const background = visibleBackground();
    if (background) return relativeLuminance(background) < 0.36 ? "dark" : "light";
    return systemDark ? "dark" : "light";
  }

  function visibleBackground() {
    for (const element of [document.body, document.documentElement]) {
      if (!element) continue;
      const match = getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.map(Number);
      if (match?.length >= 3 && (match.length < 4 || match[3] > 0.05)) return match.slice(0, 3);
    }
    return null;
  }

  function relativeLuminance([red, green, blue]) {
    return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  }

  namespace.observePageTheme = observePageTheme;
  namespace.themeModel = { relativeLuminance };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
