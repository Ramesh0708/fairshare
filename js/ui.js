import { $ } from "./dom.js";

let toastTimer = 0;

export function toast(message, options = {}) {
  const root = $("#toast");
  if (!root) return;
  root.replaceChildren();
  const text = document.createElement("span");
  text.textContent = message;
  root.append(text);
  if (options.actionLabel && options.onAction) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = options.actionLabel;
    button.addEventListener("click", () => {
      hideToast();
      options.onAction();
    });
    root.append(button);
  }
  root.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, options.duration || (options.actionLabel ? 7000 : 3400));
}

export function hideToast() {
  const root = $("#toast");
  if (root) root.hidden = true;
}

function dialogParts() {
  return {
    backdrop: $("#app-dialog"),
    title: $("#dialog-title"),
    message: $("#dialog-message"),
    input: $("#dialog-input"),
    ok: $("#dialog-ok"),
    cancel: $("#dialog-cancel")
  };
}

function openDialog({ title, message, mode, defaultValue = "", placeholder = "", confirmLabel, cancelLabel, danger = false }) {
  const ui = dialogParts();
  return new Promise((resolve) => {
    ui.title.textContent = title || "FairShare";
    ui.message.textContent = message || "";
    ui.message.hidden = !message;
    ui.input.hidden = mode !== "prompt";
    ui.input.value = defaultValue;
    ui.input.placeholder = placeholder;
    ui.ok.textContent = confirmLabel || (mode === "confirm" ? "Confirm" : "OK");
    ui.ok.classList.toggle("btn-danger", danger);
    ui.cancel.hidden = mode === "alert";
    ui.cancel.textContent = cancelLabel || "Cancel";
    ui.backdrop.hidden = false;
    ui.backdrop.classList.add("active");

    const finish = (value) => {
      ui.backdrop.classList.remove("active");
      ui.backdrop.hidden = true;
      ui.ok.removeEventListener("click", onOk);
      ui.cancel.removeEventListener("click", onCancel);
      ui.backdrop.removeEventListener("click", onBackdrop);
      ui.input.removeEventListener("keydown", onInput);
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onOk = () => finish(mode === "prompt" ? ui.input.value : true);
    const onCancel = () => finish(mode === "prompt" ? null : false);
    const onBackdrop = (event) => { if (event.target === ui.backdrop) onCancel(); };
    const onKey = (event) => { if (event.key === "Escape") onCancel(); };
    const onInput = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        onOk();
      }
    };
    ui.ok.addEventListener("click", onOk);
    ui.cancel.addEventListener("click", onCancel);
    ui.backdrop.addEventListener("click", onBackdrop);
    ui.input.addEventListener("keydown", onInput);
    document.addEventListener("keydown", onKey);
    if (mode === "prompt") ui.input.focus();
    else ui.ok.focus();
  });
}

export function confirmDialog(options) {
  return openDialog({ ...options, mode: "confirm" });
}

export function promptDialog(options) {
  return openDialog({ ...options, mode: "prompt" });
}

export function alertDialog(options) {
  return openDialog({ ...options, mode: "alert" });
}
