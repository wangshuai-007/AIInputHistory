(function initializeInputAdapter(namespace) {
  "use strict";

  const PROMPT_PATTERN = /(message|prompt|chat|ask|send|reply|question|输入|提问|聊天|消息|发送|回复)/i;
  const EDITABLE_SELECTOR = "textarea,input[type='text'],input[type='search'],input:not([type]),[contenteditable='true'],[contenteditable='plaintext-only'],[role='textbox']";

  function isTextInput(element) {
    return element instanceof HTMLInputElement && ["text", "search"].includes(element.type);
  }

  function resolveEditable(element) {
    if (!(element instanceof Element)) return null;
    if (element instanceof HTMLTextAreaElement || isTextInput(element) || element.matches("[contenteditable='true'],[contenteditable='plaintext-only'],[role='textbox']")) return element;
    return element.closest(EDITABLE_SELECTOR);
  }

  function resolveEventEditable(event) {
    const path = typeof event?.composedPath === "function" ? event.composedPath() : [event?.target];
    for (const node of path) {
      const editable = resolveEditable(node);
      if (editable) return editable;
    }
    return null;
  }

  function isEditable(element) {
    const editable = resolveEditable(element);
    if (!editable || editable.matches(":disabled,[disabled],[readonly],[aria-disabled='true'],[aria-readonly='true']")) return false;
    return editable instanceof HTMLTextAreaElement || isTextInput(editable) || editable.isContentEditable;
  }

  /** Finds an existing visible composer without changing page focus. */
  function findComposer(root = document, excludedHost = null) {
    let focused = root.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    const candidates = [focused, ...root.querySelectorAll(EDITABLE_SELECTOR)];
    return candidates.filter((element) => element && element !== excludedHost && !excludedHost?.contains(element))
      .map((element) => ({ element, score: composerScore(element) }))
      .filter(({ element, score }) => {
        const rect = element.getBoundingClientRect();
        return score >= 4 && element.isConnected && rect.width > 0 && rect.height > 0;
      })
      .sort((left, right) => Number(right.element === focused) - Number(left.element === focused) || right.score - left.score)[0]?.element || null;
  }

  function composerScore(element) {
    element = resolveEditable(element);
    if (!isEditable(element)) return 0;
    let score = 0;
    if (element instanceof HTMLTextAreaElement || element.isContentEditable) score += 5;
    if (element.getAttribute("role") === "textbox") score += 2;
    const signals = [element.getAttribute("placeholder"), element.getAttribute("aria-label"), element.getAttribute("data-placeholder"), element.getAttribute("name")]
      .filter(Boolean).join(" ");
    if (PROMPT_PATTERN.test(signals)) score += 5;
    if (namespace.SiteProfiles.matchesComposer(element, location.hostname)) score += 10;
    if (element.closest("form")) score += 1;
    if (element.getBoundingClientRect().width >= 240) score += 1;
    return score;
  }

  function getText(element) {
    element = resolveEditable(element);
    if (!element) return "";
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
    return element.innerText || element.textContent || "";
  }

  function setText(element, value) {
    element = resolveEditable(element);
    if (!element) return;
    element.focus({ preventScroll: true });
    let nativeInputDispatched = false;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value").set;
      setter.call(element, value);
      element.setSelectionRange(value.length, value.length);
    } else {
      nativeInputDispatched = replaceContentEditableText(element, value);
      placeCaretAtEnd(element);
    }
    if (!nativeInputDispatched) {
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function replaceContentEditableText(element, value) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    try {
      if (document.execCommand("insertText", false, value)) return true;
    } catch (error) {
      console.debug("[AI 输入历史] 富文本原生插入不可用，改用 DOM 写入", error);
    }
    element.replaceChildren(document.createTextNode(value));
    return false;
  }

  function placeCaretAtEnd(element) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function fieldKey(element) {
    element = resolveEditable(element);
    const identity = [location.origin, location.pathname, element.id, element.getAttribute("name"), element.getAttribute("aria-label"), element.getAttribute("placeholder"), element.tagName]
      .filter(Boolean).join("|");
    let hash = 2166136261;
    for (let index = 0; index < identity.length; index += 1) {
      hash ^= identity.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${location.hostname}:${(hash >>> 0).toString(36)}`;
  }

  namespace.InputAdapter = { composerScore, fieldKey, findComposer, getText, isEditable, resolveEditable, resolveEventEditable, setText };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
