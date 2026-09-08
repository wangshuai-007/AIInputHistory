(function initializeSiteIcon(namespace) {
  "use strict";

  async function captureSiteIcon(store, site) {
    const candidates = iconCandidates();
    for (const source of candidates) {
      try {
        const dataUrl = await readIcon(source);
        if (!dataUrl) continue;
        await store.saveSiteIcon(site, dataUrl);
        return dataUrl;
      } catch (error) {
        console.debug("[AI Input History] 网站图标不可用，保留本地图标", error.name);
      }
    }
    return null;
  }

  function iconCandidates() {
    const links = [...document.querySelectorAll("link[rel~='icon'],link[rel='apple-touch-icon']")]
      .map((link) => link.href).filter(Boolean);
    return [...new Set([...links, new URL("/favicon.ico", location.origin).href])];
  }

  async function readIcon(source) {
    if (source.startsWith("data:image/") && source.length <= 180_000) return source;
    const url = new URL(source, location.href);
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== location.origin) return null;
    const response = await fetch(url.href, {
      credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "force-cache",
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (blob.size > 130_000 || (blob.type && !blob.type.startsWith("image/"))) return null;
    return blobToDataUrl(blob);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  namespace.captureSiteIcon = captureSiteIcon;
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
