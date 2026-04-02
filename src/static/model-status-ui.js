export function setModelTestStatus(card, message, tone = "neutral") {
  const status = card?.querySelector("[data-model-test-status]");
  if (!status) {
    return;
  }

  status.textContent = String(message || "");
  status.dataset.tone = tone || "neutral";
}
