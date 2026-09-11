// Local-only ChatGPT-shaped DOM fixture. Enabled only with ?timing=1.
if (new URLSearchParams(location.search).has("timing")) {
  const finish = document.createElement("button");
  finish.textContent = "模拟回复完成";
  finish.type = "button";
  document.querySelector(".top").appendChild(finish);
  let turn;
  let requestIndex = Number(localStorage.getItem("aih-fixture-request-index") || 0);
  function renderRequest(state) {
    if (!state) return;
    turn = document.createElement("article");
    turn.innerHTML = `<div data-message-author-role="assistant" data-message-id="test-reply-${state.id}">${state.complete ? "示例回复已完成" : "正在生成示例回复……"}</div>${state.complete ? '<button data-testid="copy-turn-action-button" type="button">复制回复</button>' : '<button data-testid="stop-button" type="button">停止生成</button>'}`;
    document.querySelector(".thread").appendChild(turn);
    turn.querySelector('[data-testid="stop-button"]')?.addEventListener("click", () => turn.querySelector('[data-testid="stop-button"]')?.remove());
  }
  renderRequest(JSON.parse(localStorage.getItem("aih-fixture-request") || "null"));
  document.querySelector(".send").addEventListener("click", () => {
    document.querySelector(".composer").value = "";
    turn?.remove();
    requestIndex += 1;
    localStorage.setItem("aih-fixture-request-index", String(requestIndex));
    const state = { id: requestIndex, complete: false };
    localStorage.setItem("aih-fixture-request", JSON.stringify(state));
    renderRequest(state);
  });
  finish.addEventListener("click", () => {
    if (!turn) return;
    const state = JSON.parse(localStorage.getItem("aih-fixture-request") || "null");
    if (!state) return;
    state.complete = true;
    localStorage.setItem("aih-fixture-request", JSON.stringify(state));
    turn.querySelector('[data-testid="stop-button"]')?.remove();
  });
}
