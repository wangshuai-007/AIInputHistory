(function initializeInputAdapter(namespace) {
  "use strict";

  const PROMPT_PATTERN = /(message|prompt|chat|ask|send|reply|question|输入|提问|聊天|消息|发送|回复)/i;

  function isTextInput(element) {
    return element instanceof HTMLInputElement && ["text", "search"].includes(element.type);
  }

  function resolveEditable(element) {
    if (!(element instanceof Element)) return null;
    if (element instanceof HTMLTextAreaElement || isTextInput(element) || element.matches("[contenteditable='true'],[role='textbox']")) return element;
    return element.closest("textarea,input[type='text'],input[type='search'],[contenteditable='true'],[role='textbox']");
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
    return Boolean(editable && !editable.matches("[disabled], [aria-disabled='true']"));
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

  function shouldNavigateHistory(element, direction) {
    element = resolveEditable(element);
    if (!element) return false;
    if (element instanceof HTMLInputElement) {
      return direction === "up" ? element.selectionStart === 0 : element.selectionEnd === element.value.length;
    }
    if (element instanceof HTMLTextAreaElement) {
      if (!element.value) return true;
      return direction === "up" ? element.selectionStart === 0 : element.selectionEnd === element.value.length;
    }
    return !getText(element).trim();
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

  namespace.InputAdapter = { composerScore, fieldKey, getText, isEditable, resolveEditable, resolveEventEditable, setText, shouldNavigateHistory };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
