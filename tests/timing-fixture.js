// Local-only ChatGPT-shaped DOM fixture. Enabled only with ?timing=1.
if (new URLSearchParams(location.search).has("timing")) {
  const finish = document.createElement("button");
  finish.textContent = "模拟回复完成";
  finish.type = "button";
  document.querySelector(".top").appendChild(finish);
  let turn;
  let requestIndex = 0;
  document.querySelector(".send").addEventListener("click", () => {
    document.querySelector(".composer").value = "";
    turn = document.createElement("article");
    requestIndex += 1;
    turn.innerHTML = `<div data-message-author-role="assistant" data-message-id="test-reply-${requestIndex}">正在生成示例回复……</div><button data-testid="stop-button" type="button">停止生成</button>`;
    document.querySelector(".thread").appendChild(turn);
    turn.querySelector("button").addEventListener("click", () => turn.querySelector("button")?.remove());
  });
  finish.addEventListener("click", () => {
    if (!turn) return;
    turn.querySelector('[data-testid="stop-button"]')?.remove();
    const copy = document.createElement("button");
    copy.dataset.testid = "copy-turn-action-button";
    copy.textContent = "复制回复";
    turn.appendChild(copy);
  });
}
