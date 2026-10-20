import { clear, el } from "./dom.js";
import { formatMoney } from "./money.js";

export function renderChart({ visual, legend, empty, area, kind, entries, currency, emptyText }) {
  if (!visual || !legend) return;
  clear(visual);
  clear(legend);
  const total = entries.reduce((sum, item) => sum + item.value, 0);
  if (total <= 0) {
    if (empty) {
      empty.hidden = false;
      empty.textContent = emptyText || "Nothing to chart yet.";
    }
    if (area) area.hidden = true;
    return;
  }
  if (empty) empty.hidden = true;
  if (area) area.hidden = false;

  visual.setAttribute("role", "img");
  visual.setAttribute("aria-label", entries.map((item) => `${item.label} ${formatMoney(item.value, currency)}`).join(", "));

  if (kind === "pie") {
    const pie = el("div", { class: "chart-pie" });
    if (entries.length === 1) {
      pie.style.background = entries[0].color;
    } else {
      let angle = 0;
      const stops = entries.map((item, index) => {
        const sweep = (item.value / total) * 360;
        const end = index === entries.length - 1 ? 360 : angle + sweep;
        const stop = `${item.color} ${angle}deg ${end}deg`;
        angle = end;
        return stop;
      });
      pie.style.background = `conic-gradient(${stops.join(", ")})`;
    }
    visual.append(pie);
  } else {
    const wrap = el("div", { class: "chart-bar-block" });
    for (const item of entries) {
      const pct = Math.max(2, (item.value / total) * 100);
      const row = el("div", {}, [
        el("div", { class: "transaction-meta" }, [
          el("span", { text: item.label }),
          el("span", { text: `${Math.round((item.value / total) * 100)}%` })
        ]),
        el("div", { style: "background:var(--border);border-radius:6px;height:10px;overflow:hidden;" }, [
          el("div", { style: `background:${item.color};width:${pct}%;height:100%;` })
        ])
      ]);
      const meta = row.querySelector(".transaction-meta");
      if (meta) meta.style.display = "flex";
      if (meta) meta.style.justifyContent = "space-between";
      wrap.append(row);
    }
    visual.append(wrap);
  }

  for (const item of entries) {
    const pct = ((item.value / total) * 100).toFixed(1);
    const dot = el("span", { class: "legend-color-dot", attrs: { "aria-hidden": "true" } });
    dot.style.background = item.color;
    legend.append(el("div", { class: "legend-item" }, [
      el("span", { class: "legend-label" }, [dot, document.createTextNode(item.label)]),
      el("span", { class: "legend-value", text: `${formatMoney(item.value, currency)} (${pct}%)` })
    ]));
  }
}
