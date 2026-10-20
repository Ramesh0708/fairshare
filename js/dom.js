export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "on") {
      for (const [event, fn] of Object.entries(value)) node.addEventListener(event, fn);
    } else if (key === "attrs") {
      for (const [name, attr] of Object.entries(value)) {
        if (attr != null) node.setAttribute(name, String(attr));
      }
    } else if (key === "style" && typeof value === "string") node.setAttribute("style", value);
    else node[key] = value;
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  if (node) node.replaceChildren();
}

export function safeImageSrc(src) {
  if (typeof src !== "string" || !src) return "";
  if (src.startsWith("data:image/") || src.startsWith("blob:") || src.startsWith("https://")) return src;
  return "";
}
