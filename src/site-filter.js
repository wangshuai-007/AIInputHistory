(function initializeSiteFilter(namespace) {
  "use strict";

  class SiteFilter {
    constructor(root, currentSite, onChange) {
      this.root = root;
      this.currentSite = currentSite;
      this.selectedSite = currentSite;
      this.onChange = onChange;
      this.root.innerHTML = `<button class="site-trigger" type="button" aria-haspopup="listbox" aria-expanded="false"></button><div class="site-menu hidden" role="listbox"></div>`;
      this.trigger = root.querySelector(".site-trigger");
      this.menu = root.querySelector(".site-menu");
      this.focused = false;
      this.bindEvents();
    }

    setSites(sites) {
      this.options = orderSites(this.currentSite, sites);
      if (!this.options.includes(this.selectedSite)) this.selectedSite = this.currentSite;
      this.menu.innerHTML = this.options.map((site) => this.optionMarkup(site)).join("");
      this.updateTrigger();
    }

    select(site) {
      if (!this.options.includes(site)) return;
      this.selectedSite = site;
      this.updateTrigger();
      this.setExpanded(false);
      this.onChange(site);
    }

    bindEvents() {
      this.root.addEventListener("focusin", () => { this.focused = true; });
      this.root.addEventListener("focusout", () => {
        setTimeout(() => {
          this.focused = this.root.contains(this.root.getRootNode().activeElement);
          if (!this.focused) this.setExpanded(false);
        }, 0);
      });
      this.trigger.addEventListener("click", () => this.setExpanded(this.menu.classList.contains("hidden")));
      this.trigger.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowDown") return;
        event.preventDefault();
        this.setExpanded(true);
        this.menu.querySelector(".site-option")?.focus();
      });
      this.menu.addEventListener("click", (event) => {
        const option = event.target.closest(".site-option");
        if (option) this.select(option.dataset.site);
      });
      this.menu.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          this.setExpanded(false);
          this.trigger.focus();
          return;
        }
        if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
        event.preventDefault();
        const options = [...this.menu.querySelectorAll(".site-option")];
        const index = options.indexOf(event.target);
        options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
      });
    }

    setExpanded(expanded) {
      this.menu.classList.toggle("hidden", !expanded);
      this.trigger.setAttribute("aria-expanded", String(expanded));
    }

    isFocused() {
      return this.focused;
    }

    updateTrigger() {
      this.trigger.innerHTML = `${namespace.SiteProfiles.icon(this.selectedSite)}<span>${escapeHtml(this.triggerLabel(this.selectedSite))}</span><svg class="chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
      this.menu.querySelectorAll(".site-option").forEach((option) => {
        const selected = option.dataset.site === this.selectedSite;
        option.classList.toggle("selected", selected);
        option.setAttribute("aria-selected", String(selected));
      });
    }

    triggerLabel(site) {
      if (site === "*") return "全部网站";
      const name = namespace.SiteProfiles.displayName(site);
      return site === this.currentSite ? `当前 · ${name}` : name;
    }

    optionMarkup(site) {
      const name = namespace.SiteProfiles.displayName(site);
      const detail = site === "*" ? "跨站点历史" : site;
      return `<button class="site-option" type="button" role="option" data-site="${escapeHtml(site)}">${namespace.SiteProfiles.icon(site)}<span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(detail)}</small></span></button>`;
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
  }

  function orderSites(currentSite, sites) {
    return ["*", currentSite, ...sites.filter((site, index) => site !== currentSite && sites.indexOf(site) === index)];
  }

  namespace.SiteFilter = SiteFilter;
  namespace.siteFilterModel = { orderSites };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
