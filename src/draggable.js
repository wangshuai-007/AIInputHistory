(function initializeDraggable(namespace) {
  "use strict";

  function enablePointerDrag(options) {
    const { element, handle = element, delay = 0, canStart, onMove, onEnd } = options;
    let state = null;
    let suppressClick = false;

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || (canStart && !canStart(event))) return;
      const rect = element.getBoundingClientRect();
      state = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: rect.left,
        originY: rect.top,
        active: false,
        timer: null
      };
      handle.setPointerCapture(event.pointerId);
      state.timer = setTimeout(() => startDrag(event), delay);
      if (delay === 0) startDrag(event);
    });

    handle.addEventListener("pointermove", (event) => {
      if (!state || state.pointerId !== event.pointerId || !state.active) return;
      event.preventDefault();
      onMove({
        x: state.originX + event.clientX - state.startX,
        y: state.originY + event.clientY - state.startY
      });
    });

    handle.addEventListener("pointerup", finishDrag);
    handle.addEventListener("pointercancel", finishDrag);

    function startDrag(event) {
      if (!state || state.active) return;
      state.active = true;
      element.classList.add("aih-dragging");
      event.preventDefault();
    }

    function finishDrag(event) {
      if (!state || state.pointerId !== event.pointerId) return;
      clearTimeout(state.timer);
      if (state.active) {
        suppressClick = true;
        element.classList.remove("aih-dragging");
        const rect = element.getBoundingClientRect();
        onEnd?.({ x: rect.left, y: rect.top });
        setTimeout(() => { suppressClick = false; }, 0);
      }
      state = null;
    }

    return { shouldSuppressClick: () => suppressClick };
  }

  namespace.enablePointerDrag = enablePointerDrag;
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
