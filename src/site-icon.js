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
      } catch {
        // Some sites host favicons on a CDN without CORS. Try the next same-page candidate.
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
    if (!["http:", "https:"].includes(url.protocol)) return null;
    const response = await fetch(url.href, { credentials: "include", cache: "force-cache" });
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
