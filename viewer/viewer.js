import { FORMAT, OUTCOME_KINDS, childIds, validate } from "../lib/validate.mjs";
import { COPY } from "./copy.mjs";
import { buildIndex } from "../lib/rollup.mjs";
const KIND_LABEL = COPY.kinds;
const FONT = '"Excalifont", "Virgil", "Segoe Print", "Comic Sans MS", cursive';
const SVG_NS = "http://www.w3.org/2000/svg";

// Sizes, in canvas units.
const S = {
  nodeMinW: 150, nodeMaxText: 210, padX: 16, padY: 11, font: 16, line: 20, hexInset: 16,
  termFont: 14, termLine: 17, termPadX: 15, termPadY: 7, termMaxText: 150,
  labelFont: 13, labelLine: 15, labelW: 130, labelLines: 3,
  busGap: 16, rowGap: 10, gapY: 40, framePad: 20, colGap: 56, forkDrop: 22, diamondText: 150, passW: 150,
};

let graph;
let index;
let rc;
let ancestorsByPath = new Map();
let current = { ops: [], boxes: new Map(), bounds: { x: 0, y: 0, w: 1, h: 1 } };
const state = { epId: null, open: new Set(), view: "none", selected: null, tx: 0, ty: 0, k: 1, panelOpen: true };

const svg = document.getElementById("canvas");
const world = document.getElementById("world");

// ---------------------------------------------------------------------------
// Helpers

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of [].concat(children)) {
    if (child != null && child !== false) el.append(child);
  }
  return el;
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function isComposite(node) {
  return childIds(node).length > 0;
}

function idOf(path) {
  return path.split("/").pop();
}

function seedOf(text) {
  let x = 2166136261;
  for (const ch of text) {
    x ^= ch.codePointAt(0);
    x = Math.imul(x, 16777619);
  }
  return ((x >>> 0) % 2147483646) + 1;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

const measureCtx = document.createElement("canvas").getContext("2d");

function wrap(text, maxW, size, maxLines = Infinity) {
  measureCtx.font = `${size}px ${FONT}`;
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (!line || measureCtx.measureText(candidate).width <= maxW) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/\s+\S*$/, "")}…`;
  }
  const width = Math.max(...lines.map((l) => measureCtx.measureText(l).width));
  return { lines, width };
}

function sortedExits(exitMap) {
  return [...exitMap.entries()].sort(
    (a, b) => OUTCOME_KINDS.indexOf(graph.outcomes[a[0]].kind) - OUTCOME_KINDS.indexOf(graph.outcomes[b[0]].kind)
  );
}

// Every place a node appears in an entry point's flow has its own path, so a
// shared node can be open in one place and closed in another.
function walk(epId, visitor) {
  const visitNode = (id, path, ancestors) => {
    visitor(id, path, ancestors);
    const node = graph.nodes[id];
    (node.steps || []).forEach((child) => visitNode(child, `${path}/${child}`, [...ancestors, path]));
    (node.branches || []).forEach((branch, bi) =>
      branch.steps.forEach((child) => visitNode(child, `${path}/#${bi}/${child}`, [...ancestors, path]))
    );
  };
  index.epById[epId].steps.forEach((id) => visitNode(id, `${epId}/${id}`, []));
}

function pathsWhere(predicate) {
  const found = [];
  walk(state.epId, (id, path) => {
    if (predicate(graph.nodes[id])) found.push(path);
  });
  return found;
}

function openFor(paths) {
  const open = new Set();
  for (const path of paths) {
    (ancestorsByPath.get(path) || []).forEach((p) => open.add(p));
    if (isComposite(graph.nodes[idOf(path)])) open.add(path);
  }
  return open;
}

// ---------------------------------------------------------------------------
// Layout. Each block knows its size, where its spine runs (cx), where the
// incoming arrow lands (inY) and where the outgoing one leaves (outY).

function shapeSpec(id) {
  const node = graph.nodes[id];
  if (node.question) {
    // A rhombus holds a w×h text box when w/W + h/H <= 1.
    const text = wrap(node.question, S.diamondText, S.font);
    const tw = Math.ceil(text.width);
    const th = text.lines.length * S.line;
    const h = th + 2 * S.padY + 24;
    const w = Math.max(S.nodeMinW, Math.ceil(tw / (1 - th / h)) + 18);
    return { kind: "diamond", w, h, lines: text.lines };
  }
  const kind = (node.exits && node.exits.length) || node.branches ? "hex" : "rect";
  const inset = kind === "hex" ? S.hexInset : 0;
  const text = wrap(node.text, S.nodeMaxText, S.font);
  const w = Math.max(S.nodeMinW, Math.ceil(text.width) + 2 * S.padX + 2 * inset);
  const h = text.lines.length * S.line + 2 * S.padY;
  return { kind, w, h, lines: text.lines };
}

function collapsedExits(id) {
  return sortedExits(index.rollup(id).exits).map(([code, whens]) => ({
    code,
    whens,
    label: whens.length === 1 ? whens[0] : COPY.ways(whens.length),
  }));
}

function ownExits(id) {
  const node = graph.nodes[id];
  return [
    ...(node.exits || []).map((e) => ({ code: e.outcome, whens: [e.when], label: e.when })),
    // A helper's result for its caller: drawn like an exit, but it ends only this helper.
    ...(node.returns || []).map((r) => ({ returned: r.value, whens: [r.when], label: r.when })),
  ];
}

function exitStack(exits) {
  const rows = exits.map((exit) => {
    const outcome = exit.returned ? { kind: "return", text: COPY.returnTerm(exit.returned) } : graph.outcomes[exit.code];
    const text = wrap(outcome.text, S.termMaxText, S.termFont);
    const termW = Math.ceil(text.width) + 2 * S.termPadX;
    const termH = text.lines.length * S.termLine + 2 * S.termPadY;
    const label = exit.label ? wrap(exit.label, S.labelW, S.labelFont, S.labelLines) : null;
    const labelH = label ? label.lines.length * S.labelLine + 4 : 0;
    return { exit, outcome, text, termW, termH, label, h: Math.max(termH, labelH) };
  });
  const labelCol = rows.some((r) => r.label) ? S.labelW + 30 : 34;
  const termCol = Math.max(...rows.map((r) => r.termW));
  let y = 0;
  rows.forEach((r) => {
    r.y = y;
    y += r.h + S.rowGap;
  });
  return { rows, w: S.busGap + labelCol + termCol, h: y - S.rowGap, labelCol };
}

// Draws an exit stack whose arrows leave a shape's right edge at (ox, anchorY).
function placeStack(stack, ox, anchorY, top, ownerPath, out) {
  const busX = ox + S.busGap;
  const termX = ox + S.busGap + stack.labelCol;
  const centers = stack.rows.map((r) => top + r.y + r.h / 2);
  const straight = stack.rows.length === 1 && Math.abs(centers[0] - anchorY) < 1;
  if (!straight) {
    out.push({ type: "line", points: [[ox, anchorY], [busX, anchorY]], seed: seedOf(`${ownerPath}:bus0`) });
    const lo = Math.min(anchorY, centers[0]);
    const hi = Math.max(anchorY, centers[centers.length - 1]);
    if (hi - lo > 1) out.push({ type: "line", points: [[busX, lo], [busX, hi]], seed: seedOf(`${ownerPath}:bus`) });
  }
  stack.rows.forEach((r, i) => {
    const cy = centers[i];
    const startX = straight ? ox : busX;
    out.push({ type: "arrow", points: [[startX, cy], [termX - 3, cy]], seed: seedOf(`${ownerPath}:x${i}`) });
    out.push({
      type: "term", x: termX, y: cy - r.termH / 2, w: r.termW, h: r.termH,
      lines: r.text.lines, kind: r.outcome.kind, code: r.exit.code, returned: r.exit.returned, whens: r.exit.whens,
      ownerPath, seed: seedOf(`${ownerPath}:t${i}`),
    });
    if (r.label) {
      out.push({ type: "label", cx: (startX + termX) / 2, cy, lines: r.label.lines, title: r.exit.whens.join("\n") });
    }
  });
}

function itemBlock(id, path, hasNext) {
  const node = graph.nodes[id];
  if (isComposite(node) && state.open.has(path)) return frameBlock(id, path, hasNext);
  return nodeBlock(id, path);
}

function nodeBlock(id, path) {
  const shape = shapeSpec(id);
  const exits = isComposite(graph.nodes[id]) ? collapsedExits(id) : ownExits(id);
  const stack = exits.length ? exitStack(exits) : null;
  const anchorY = shape.h / 2;
  const stackTop = stack ? Math.max(0, anchorY - stack.h / 2) : 0;
  return {
    w: shape.w + (stack ? stack.w : 0),
    h: Math.max(shape.h, stack ? stackTop + stack.h : 0),
    cx: shape.w / 2,
    inY: 0,
    outY: shape.h,
    outLabel: passLabel(graph.nodes[id]),
    place(x, y, out) {
      out.push({ type: "node", id, path, x, y, ...shape, open: false, seed: seedOf(path) });
      if (stack) placeStack(stack, x + shape.w, y + anchorY, y + stackTop, path, out);
    },
  };
}

function frameBlock(id, path, hasNext) {
  const node = graph.nodes[id];
  const P = S.framePad;
  const shape = shapeSpec(id);
  const content = node.branches ? branchesBlock(node, path, hasNext) : flowBlock(node.steps, path);
  const gap = content.isFork ? S.forkDrop : S.gapY;
  const spine = Math.max(shape.w / 2, content.cx);
  const innerW = Math.max(spine + shape.w / 2, spine - content.cx + content.w);
  const contentY = P + shape.h + gap;
  const frameW = innerW + 2 * P;
  const frameH = contentY + content.h + P;
  const exits = ownExits(id);
  const stack = exits.length ? exitStack(exits) : null;
  const anchorY = frameH - P - 6;
  const stackTop = stack ? Math.max(0, anchorY - stack.h / 2) : 0;

  return {
    w: frameW + (stack ? stack.w : 0),
    h: Math.max(frameH, stack ? stackTop + stack.h : 0),
    cx: P + spine,
    inY: P,
    outY: content.isFork ? frameH : contentY + content.outY,
    outLabel: passLabel(node) || content.outLabel || null,
    place(x, y, out) {
      out.push({ type: "frame", x, y, w: frameW, h: frameH, seed: seedOf(`${path}:frame`) });
      const sx = x + P + spine;
      out.push({ type: "node", id, path, x: sx - shape.w / 2, y: y + P, ...shape, open: true, seed: seedOf(path) });
      const cy = y + contentY;
      if (content.isFork) out.push({ type: "line", points: [[sx, y + P + shape.h], [sx, cy]], seed: seedOf(`${path}:fork`) });
      else out.push({ type: "arrow", points: [[sx, y + P + shape.h], [sx, cy + content.inY]], seed: seedOf(`${path}:in`) });
      content.place(sx - content.cx, cy, out);
      if (stack) placeStack(stack, x + frameW, y + anchorY, y + stackTop, path, out);
    },
  };
}

function passLabel(node) {
  return node.pass ? { ...wrap(node.pass, S.passW, S.labelFont, 2), title: COPY.continuesWhen(node.pass) } : null;
}

function flowBlock(steps, prefix) {
  if (!steps.length) return { empty: true, w: 0, h: 0, cx: 0, inY: 0, outY: 0, outLabel: null, place() {} };
  const items = steps.map((id, i) => {
    const path = `${prefix}/${id}`;
    return { id, path, b: itemBlock(id, path, i < steps.length - 1) };
  });
  const spine = Math.max(...items.map((it) => it.b.cx));
  let y = 0;
  items.forEach((it, i) => {
    if (i > 0) {
      const prev = items[i - 1];
      // The next item starts below everything of the previous one, and at
      // least gapY below where the previous one's arrow leaves.
      const labelH = prev.b.outLabel ? prev.b.outLabel.lines.length * S.labelLine + 14 : 0;
      y = Math.max(prev.y + prev.b.h + S.gapY * 0.6, prev.y + prev.b.outY + S.gapY + labelH - it.b.inY);
    }
    it.y = y;
  });
  const last = items[items.length - 1];
  return {
    w: Math.max(...items.map((it) => spine - it.b.cx + it.b.w)),
    h: Math.max(...items.map((it) => it.y + it.b.h)),
    cx: spine,
    inY: items[0].b.inY,
    outY: last.y + last.b.outY,
    outLabel: last.b.outLabel,
    place(x, y0, out) {
      items.forEach((it, i) => {
        it.b.place(x + spine - it.b.cx, y0 + it.y, out);
        if (i > 0) {
          const prev = items[i - 1];
          const from = y0 + prev.y + prev.b.outY;
          const to = y0 + it.y + it.b.inY;
          out.push({ type: "arrow", points: [[x + spine, from], [x + spine, to]], seed: seedOf(`${it.path}:in`) });
          if (prev.b.outLabel) {
            out.push({ type: "label", cx: x + spine, cy: (from + to) / 2, lines: prev.b.outLabel.lines, title: prev.b.outLabel.title, pass: true });
          }
        }
      });
    },
  };
}

function branchesBlock(node, path, hasNext) {
  const cols = node.branches.map((branch, bi) => ({
    branch,
    flow: flowBlock(branch.steps, `${path}/#${bi}`),
    label: wrap(branch.when, 140, S.labelFont, 2),
  }));
  const labelH = Math.max(...cols.map((c) => c.label.lines.length)) * S.labelLine;
  const drop = labelH + 34;
  let x = 0;
  cols.forEach((c) => {
    c.w = Math.max(c.flow.w, Math.ceil(c.label.width) + 24);
    c.x = x + (c.w - c.flow.w) / 2;
    c.spine = c.flow.empty ? x + c.w / 2 : c.x + c.flow.cx;
    x += c.w + S.colGap;
  });
  const spines = cols.map((c) => c.spine);
  const colsH = Math.max(...cols.map((c) => c.flow.h));
  const mergeY = drop + colsH + 18;
  return {
    isFork: true,
    w: x - S.colGap,
    h: hasNext ? mergeY + 8 : drop + colsH,
    cx: (spines[0] + spines[spines.length - 1]) / 2,
    inY: 0,
    outY: hasNext ? mergeY + 8 : drop + colsH,
    place(x0, y0, out) {
      const xs = spines.map((s) => x0 + s);
      const mid = (xs[0] + xs[xs.length - 1]) / 2;
      out.push({ type: "line", points: [[xs[0], y0], [xs[xs.length - 1], y0]], seed: seedOf(`${path}:bus`) });
      cols.forEach((c, i) => {
        const top = y0 + drop + c.flow.inY;
        out.push({ type: "arrow", points: [[xs[i], y0], [xs[i], top]], seed: seedOf(`${path}:b${i}`) });
        out.push({ type: "label", cx: xs[i], cy: y0 + drop / 2, lines: c.label.lines, title: c.branch.when, strong: true });
        c.flow.place(x0 + c.x, y0 + drop, out);
        if (c.flow.empty && !hasNext) out.push({ type: "label", cx: xs[i], cy: top + 12, lines: [COPY.emptyPath], title: COPY.emptyPathTitle });
        if (hasNext) {
          out.push({ type: "line", points: [[xs[i], y0 + drop + c.flow.outY], [xs[i], y0 + mergeY], [mid, y0 + mergeY]], seed: seedOf(`${path}:m${i}`) });
        }
      });
    },
  };
}

function layoutEntryPoint() {
  const ep = index.epById[state.epId];
  const flow = flowBlock(ep.steps, ep.id);
  const start = wrap(ep.name, 280, S.font + 2);
  const sw = Math.ceil(start.width) + 2 * S.padX + 16;
  const sh = start.lines.length * (S.line + 2) + 2 * S.padY;
  const spine = Math.max(flow.cx, sw / 2);
  const ops = [{ type: "start", x: spine - sw / 2, y: 0, w: sw, h: sh, lines: start.lines, seed: seedOf(ep.id) }];
  const fy = sh + S.gapY - flow.inY;
  ops.push({ type: "arrow", points: [[spine, sh], [spine, fy + flow.inY]], seed: seedOf(`${ep.id}:start`) });
  flow.place(spine - flow.cx, fy, ops);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const op of ops) {
    if (op.w == null) continue;
    minX = Math.min(minX, op.x);
    minY = Math.min(minY, op.y);
    maxX = Math.max(maxX, op.x + op.w);
    maxY = Math.max(maxY, op.y + op.h);
  }
  return { ops, bounds: { x: minX - 20, y: minY - 20, w: maxX - minX + 40, h: maxY - minY + 40 } };
}

// ---------------------------------------------------------------------------
// Drawing

function theme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    canvas: v("--canvas"), ink: v("--ink"), muted: v("--muted"), nodeFill: v("--node-fill"),
    frame: v("--frame"), frameFill: v("--frame-fill"), select: v("--select"),
    change: v("--change"), changeFill: v("--change-fill"), note: v("--note"), noteFill: v("--note-fill"),
    kinds: {
      success: [v("--success"), v("--success-fill")],
      "user-error": [v("--user"), v("--user-fill")],
      rejected: [v("--rejected"), v("--rejected-fill")],
      crash: [v("--crash"), v("--crash-fill")],
      return: [v("--muted"), v("--canvas")],
    },
  };
}

function roundRect(x, y, w, h, r) {
  r = Math.min(r, h / 2, w / 2);
  return `M${x + r} ${y} L${x + w - r} ${y} Q${x + w} ${y} ${x + w} ${y + r} L${x + w} ${y + h - r} ` +
    `Q${x + w} ${y + h} ${x + w - r} ${y + h} L${x + r} ${y + h} Q${x} ${y + h} ${x} ${y + h - r} ` +
    `L${x} ${y + r} Q${x} ${y} ${x + r} ${y} Z`;
}

function diamondPoints(x, y, w, h) {
  return [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]];
}

// Where badges sit on each shape: on the corners, or on a diamond's edges.
function corners(op) {
  const { x, y, w, h } = op;
  if (op.kind === "diamond") {
    return { tl: [x + w * 0.25, y + h * 0.25], tr: [x + w * 0.75, y + h * 0.25], br: [x + w * 0.75, y + h * 0.75], bl: [x + w * 0.25, y + h * 0.75] };
  }
  return { tl: [x, y], tr: [x + w, y], br: [x + w, y + h], bl: [x, y + h] };
}

function hexPoints(x, y, w, h) {
  const i = S.hexInset;
  return [[x + i, y], [x + w - i, y], [x + w, y + h / 2], [x + w - i, y + h], [x + i, y + h], [x, y + h / 2]];
}

function textBlock(lines, cx, top, size, lineH, fill, extra = {}) {
  const t = svgEl("text", { "font-family": FONT, "font-size": size, fill, "text-anchor": "middle", ...extra });
  lines.forEach((line, i) => {
    const span = svgEl("tspan", { x: cx, y: top + i * lineH + lineH * 0.76 });
    span.textContent = line;
    t.append(span);
  });
  return t;
}

function arrowHead(points, opts) {
  const [x1, y1] = points[points.length - 2];
  const [x2, y2] = points[points.length - 1];
  const a = Math.atan2(y2 - y1, x2 - x1);
  const len = 10;
  return rc.linearPath([
    [x2 - len * Math.cos(a - 0.45), y2 - len * Math.sin(a - 0.45)],
    [x2, y2],
    [x2 - len * Math.cos(a + 0.45), y2 - len * Math.sin(a + 0.45)],
  ], opts);
}

function draw() {
  const T = theme();
  const layers = {};
  for (const name of ["frames", "lines", "shapes", "labels", "hits"]) layers[name] = svgEl("g");
  world.replaceChildren(...Object.values(layers));
  const base = (seed, extra = {}) => ({ roughness: 1.1, bowing: 0.8, strokeWidth: 1.5, stroke: T.ink, seed, ...extra });

  for (const op of current.ops) {
    if (op.type === "frame") {
      layers.frames.append(rc.path(roundRect(op.x, op.y, op.w, op.h, 16), base(op.seed, {
        stroke: T.frame, strokeWidth: 1.3, strokeLineDash: [8, 7], fill: T.frameFill, fillStyle: "solid", roughness: 0.7,
      })));
    } else if (op.type === "line" || op.type === "arrow") {
      const opts = base(op.seed, { roughness: 0.9 });
      layers.lines.append(rc.linearPath(op.points, opts));
      if (op.type === "arrow") layers.lines.append(arrowHead(op.points, opts));
    } else if (op.type === "label") {
      const lineH = S.labelLine;
      measureCtx.font = `${S.labelFont}px ${FONT}`;
      const w = Math.max(...op.lines.map((l) => measureCtx.measureText(l).width)) + 10;
      const hgt = op.lines.length * lineH + 4;
      const g = svgEl("g");
      g.append(svgEl("rect", { x: op.cx - w / 2, y: op.cy - hgt / 2, width: w, height: hgt, rx: 4, fill: T.canvas }));
      g.append(textBlock(op.lines, op.cx, op.cy - hgt / 2 + 2, S.labelFont, lineH, op.pass ? T.kinds.success[0] : op.strong ? T.ink : T.muted));
      const title = svgEl("title");
      title.textContent = op.title;
      g.append(title);
      layers.labels.append(g);
    } else if (op.type === "start") {
      layers.shapes.append(rc.path(roundRect(op.x, op.y, op.w, op.h, op.h / 2), base(op.seed, {
        strokeWidth: 2, fill: T.nodeFill, fillStyle: "solid",
      })));
      layers.shapes.append(textBlock(op.lines, op.x + op.w / 2, op.y + S.padY, S.font + 2, S.line + 2, T.ink));
    } else if (op.type === "term") {
      const [stroke, fill] = T.kinds[op.kind];
      layers.shapes.append(rc.path(roundRect(op.x, op.y, op.w, op.h, op.h / 2), base(op.seed, {
        stroke, fill, fillStyle: "solid", strokeWidth: 1.4,
      })));
      layers.shapes.append(textBlock(op.lines, op.x + op.w / 2, op.y + S.termPadY, S.termFont, S.termLine, T.ink));
      const hit = svgEl("rect", { class: "hit", x: op.x, y: op.y, width: op.w, height: op.h, rx: op.h / 2, "data-path": op.ownerPath });
      const title = svgEl("title");
      title.textContent = op.returned
        ? `${COPY.returnTitle(op.returned)}\n${op.whens.map((w) => `• ${w}`).join("\n")}`
        : `${graph.outcomes[op.code].text} (${op.code})\n${op.whens.map((w) => `• ${w}`).join("\n")}`;
      hit.append(title);
      layers.hits.append(hit);
    } else if (op.type === "node") {
      drawNode(op, layers, T, base);
    }
  }
}

function drawNode(op, layers, T, base) {
  const node = graph.nodes[op.id];
  const r = index.rollup(op.id);
  const composite = isComposite(node);
  const changeInside = !node.change && !op.open && r.changeIds.size > 0;
  const stroke = node.change || changeInside ? T.change : T.ink;
  const fill = node.change ? T.changeFill : T.nodeFill;
  const strokeWidth = node.change ? 2.6 : changeInside ? 2 : 1.6;
  const outline = (x, y, opts) => op.kind === "diamond"
    ? rc.polygon(diamondPoints(x, y, op.w, op.h), opts)
    : op.kind === "hex"
      ? rc.polygon(hexPoints(x, y, op.w, op.h), opts)
      : rc.path(roundRect(x, y, op.w, op.h, 10), opts);
  const at = corners(op);

  if (composite && !op.open) {
    // A collapsed group reads as a stack of cards.
    layers.shapes.append(outline(op.x + 6, op.y + 6, base(op.seed + 1, { stroke: T.muted, strokeWidth: 1.2, fill: T.nodeFill, fillStyle: "solid" })));
  }
  layers.shapes.append(outline(op.x, op.y, base(op.seed, { stroke, strokeWidth, fill, fillStyle: "solid" })));
  layers.shapes.append(textBlock(op.lines, op.x + op.w / 2, op.y + (op.h - op.lines.length * S.line) / 2, S.font, S.line, T.ink));

  if (composite) {
    const [cx, cy] = op.kind === "diamond" ? [at.br[0] + 6, at.br[1] + 4] : [at.br[0] - 4, at.br[1] - 2];
    layers.shapes.append(rc.circle(cx, cy, 19, base(op.seed + 2, { strokeWidth: 1.3, fill: T.canvas, fillStyle: "solid", roughness: 0.6 })));
    layers.shapes.append(textBlock([op.open ? "−" : "+"], cx, cy - 10, 17, 18, T.ink, { "font-family": "system-ui, sans-serif" }));
  }

  const noteCount = op.open ? (node.notes || []).length : r.noteIds.size;
  if (noteCount) {
    const x = at.tl[0] - (op.kind === "diamond" ? 22 : 10);
    const y = at.tl[1] - (op.kind === "diamond" ? 18 : 12);
    const label = COPY.notesTag(noteCount);
    const w = noteCount > 1 ? 34 : 24;
    layers.shapes.append(rc.rectangle(x, y, w, 22, base(op.seed + 3, { stroke: T.note, strokeWidth: 1.3, fill: T.noteFill, fillStyle: "solid", roughness: 0.8 })));
    layers.shapes.append(textBlock([label], x + w / 2, y + 1, 15, 19, T.ink));
  }

  if (node.change || changeInside) {
    const label = node.change ? COPY.changeTag(node.change) : COPY.changeInsideTag;
    measureCtx.font = `13px ${FONT}`;
    const w = measureCtx.measureText(label).width + 14;
    const x = op.kind === "diamond" ? at.tr[0] - w / 2 + 10 : op.x + op.w - w - 14;
    const y = op.kind === "diamond" ? at.tr[1] - 22 : op.y - 12;
    layers.shapes.append(rc.path(roundRect(x, y, w, 20, 10), base(op.seed + 4, { stroke: T.change, strokeWidth: 1.2, fill: T.changeFill, fillStyle: "solid", roughness: 0.6 })));
    layers.shapes.append(textBlock([label], x + w / 2, y + 2, 13, 16, T.ink));
  }

  const forksInside = [...r.forkIds].filter((f) => f !== op.id).length;
  if (composite && !op.open && forksInside) {
    const label = COPY.forksTag(forksInside);
    measureCtx.font = `13px ${FONT}`;
    const w = measureCtx.measureText(label).width + 14;
    const [bx, by] = op.kind === "diamond" ? [at.bl[0] - w - 4, at.bl[1] + 2] : [at.bl[0] - 8, at.bl[1] - 10];
    layers.shapes.append(rc.path(roundRect(bx, by, w, 20, 10), base(op.seed + 5, { stroke: T.ink, strokeWidth: 1.1, fill: T.canvas, fillStyle: "solid", roughness: 0.6 })));
    layers.shapes.append(textBlock([label], bx + w / 2, by + 2, 13, 16, T.ink));
  }

  if (state.selected === op.path) {
    layers.shapes.append(svgEl("rect", {
      x: op.x - 7, y: op.y - 7, width: op.w + 14, height: op.h + 14, rx: 6,
      fill: "none", stroke: T.select, "stroke-width": 1.5, "stroke-dasharray": "5 4",
    }));
  }

  layers.hits.append(op.kind === "diamond"
    ? svgEl("polygon", { class: "hit", points: diamondPoints(op.x, op.y, op.w, op.h).map((p) => p.join(",")).join(" "), "data-path": op.path })
    : svgEl("rect", { class: "hit", x: op.x, y: op.y, width: op.w, height: op.h, rx: 8, "data-path": op.path }));
}

// ---------------------------------------------------------------------------
// Camera

function applyTransform() {
  world.setAttribute("transform", `translate(${state.tx} ${state.ty}) scale(${state.k})`);
  document.getElementById("zoom-reset").textContent = `${Math.round(state.k * 100)}%`;
}

function usableArea() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const mobile = vw < 760;
  const panelW = !mobile && state.panelOpen ? 376 : 0;
  const bottom = mobile && state.panelOpen ? Math.min(vh * 0.44, 380) + 12 : 0;
  const top = mobile ? 120 : 76;
  return { x: 16, y: top, w: Math.max(120, vw - panelW - 32), h: Math.max(120, vh - top - 64 - bottom) };
}

function zoomAt(factor, sx, sy) {
  const k = clamp(state.k * factor, 0.15, 2.5);
  state.tx = sx - (sx - state.tx) * (k / state.k);
  state.ty = sy - (sy - state.ty) * (k / state.k);
  state.k = k;
  applyTransform();
}

function fit(maxK = 1) {
  const b = current.bounds;
  const a = usableArea();
  state.k = clamp(Math.min(a.w / b.w, a.h / b.h, maxK), 0.15, 2.5);
  state.tx = a.x + (a.w - b.w * state.k) / 2 - b.x * state.k;
  state.ty = a.y + Math.max(0, (a.h - b.h * state.k) / 2) - b.y * state.k;
  applyTransform();
}

function centerOn(path, k = state.k) {
  const box = current.boxes.get(path);
  if (!box) return;
  const a = usableArea();
  state.k = k;
  state.tx = a.x + a.w / 2 - (box.x + box.w / 2) * k;
  state.ty = a.y + a.h / 2 - (box.y + box.h / 2) * k;
  applyTransform();
}

// Fit if everything stays readable; otherwise zoom to a readable size on the target.
function frame(target) {
  fit(1);
  if (state.k >= 0.6) return;
  const k = 0.85;
  if (target) {
    centerOn(target, k);
  } else {
    const a = usableArea();
    const b = current.bounds;
    state.k = k;
    state.tx = a.x + a.w / 2 - (b.x + b.w / 2) * k;
    state.ty = a.y - b.y * k;
    applyTransform();
  }
}

// ---------------------------------------------------------------------------
// State changes

function render() {
  const { ops, bounds } = layoutEntryPoint();
  current = { ops, bounds, boxes: new Map(ops.filter((o) => o.type === "node").map((o) => [o.path, o])) };
  draw();
  applyTransform();
  renderToolbar();
  renderPanel();
}

function setView(view) {
  state.view = view;
  let target = null;
  if (view === "change" || view === "notes") {
    const paths = pathsWhere(view === "change" ? (n) => Boolean(n.change) : (n) => (n.notes || []).length > 0);
    state.open = openFor(paths);
    target = paths[0] || null;
  } else if (view === "forks") {
    // Only the outermost forks: opening every fork at once is unreadable.
    const all = pathsWhere((n) => (n.branches || []).length > 0);
    const depth = (p) => (ancestorsByPath.get(p) || []).length;
    const shallowest = Math.min(...all.map(depth));
    const paths = all.filter((p) => depth(p) === shallowest);
    state.open = openFor(paths);
    target = paths[0] || null;
  } else if (view === "all") {
    state.open = new Set(pathsWhere(isComposite));
  } else if (view === "none") {
    state.open = new Set();
  } else {
    throw new Error(`Unknown view ${view}`);
  }
  state.selected = target;
  render();
  frame(target);
}

function toggle(path) {
  const before = current.boxes.get(path);
  if (state.open.has(path)) state.open.delete(path);
  else state.open.add(path);
  state.view = "custom";
  state.selected = path;
  render();
  // Keep the clicked shape where it was on screen.
  const after = current.boxes.get(path);
  if (before && after) {
    state.tx += (before.x - after.x) * state.k;
    state.ty += (before.y - after.y) * state.k;
    applyTransform();
  }
}

function select(path) {
  state.selected = path;
  render();
}

function focusPath(path) {
  for (const p of ancestorsByPath.get(path) || []) state.open.add(p);
  state.view = "custom";
  state.selected = path;
  render();
  centerOn(path, Math.max(state.k, 0.85));
}

function hashParam(name) {
  return decodeURIComponent((location.hash.match(new RegExp(`[#&]${name}=([^&]+)`)) || [])[1] || "");
}

// #ep=<entry point>&focus=<node id> opens the flow down to that decision.
function focusNode(nodeId) {
  if (!nodeId) return;
  let target = null;
  walk(state.epId, (id, path) => {
    if (!target && id === nodeId) target = path;
  });
  if (target) {
    state.notice = null;
    focusPath(target);
  } else {
    state.notice = COPY.focusMissing(nodeId, state.epId);
    renderPanel();
  }
}

function selectEntryPoint(epId) {
  state.epId = epId;
  history.replaceState(null, "", `${location.search}#ep=${encodeURIComponent(epId)}`);
  ancestorsByPath = new Map();
  walk(epId, (id, path, ancestors) => ancestorsByPath.set(path, ancestors));
  document.getElementById("ep-select").value = epId;
  const r = index.epRollup(index.epById[epId]);
  setView(r.changeIds.size ? "change" : "none");
}

// ---------------------------------------------------------------------------
// Chrome: picker, toolbar, panel

function renderPicker() {
  const select = document.getElementById("ep-select");
  select.replaceChildren(...graph.entryPoints.map((ep) => {
    const r = index.epRollup(ep);
    const marks = [r.changeIds.size ? "★" : "", r.noteIds.size ? `! ${r.noteIds.size}` : ""].filter(Boolean).join("  ");
    return h("option", { value: ep.id, text: marks ? `${ep.name}   ${marks}` : ep.name });
  }));
  select.addEventListener("change", () => selectEntryPoint(select.value));

  const cb = graph.codebase || {};
  document.getElementById("codebase").replaceChildren(
    `${cb.name || ""}`,
    cb.commit ? " · " : "",
    cb.commit ? h("code", { text: cb.commit }) : "",
    ` · ${COPY.entryPointCount(graph.entryPoints.length)}`
  );
}

function renderToolbar() {
  const r = index.epRollup(index.epById[state.epId]);
  const button = (view, label) =>
    h("button", { "aria-pressed": String(state.view === view), onclick: () => setView(view), text: label });
  document.getElementById("toolbar").replaceChildren(...[
    r.changeIds.size ? button("change", COPY.toolbar.change) : null,
    r.forkIds.size ? button("forks", COPY.toolbar.forks(r.forkIds.size)) : null,
    r.noteIds.size ? button("notes", COPY.toolbar.notes) : null,
    button("all", COPY.toolbar.all),
    button("none", COPY.toolbar.none),
  ].filter(Boolean));
}

function pill(code, whens) {
  const outcome = graph.outcomes[code];
  return h("span", {
    class: `pill ${outcome.kind}`,
    title: [`${outcome.text} (${code})`, ...whens.map((w) => `• ${w}`)].join("\n"),
    text: outcome.text,
  });
}

function setPanelOpen(open) {
  state.panelOpen = open;
  document.getElementById("panel").hidden = !open;
  document.getElementById("panel-open").hidden = open;
  document.body.classList.toggle("panel-visible", open);
}

function renderPanel() {
  const panel = document.getElementById("panel");
  const close = h("button", { class: "icon-btn", "aria-label": COPY.hidePanel, text: "×", onclick: () => setPanelOpen(false) });
  const parts = state.selected && current.boxes.has(state.selected) ? nodePanel(state.selected, close) : entryPanel(close);
  if (state.notice) parts.unshift(h("div", { class: "box notice", role: "alert", text: state.notice }));
  panel.replaceChildren(...parts.filter(Boolean));
}

function entryPanel(close) {
  const ep = index.epById[state.epId];
  const r = index.epRollup(ep);
  const notePaths = pathsWhere((n) => (n.notes || []).length > 0);
  const changePaths = pathsWhere((n) => Boolean(n.change));
  return [
    h("div", { class: "panel-head" }, [
      h("div", {}, [h("div", { class: "panel-kicker", text: ep.kind || COPY.entryKicker }), h("h2", { text: ep.name })]),
      close,
    ]),
    ep.trigger ? h("div", { class: "mono muted", text: ep.trigger }) : null,
    ep.summary ? h("p", { text: ep.summary }) : null,
    h("section", {}, [
      h("h3", { text: COPY.endings }),
      h("div", { class: "pills" }, sortedExits(r.exits).map(([code, whens]) => pill(code, whens))),
    ]),
    changePaths.length && graph.change ? h("section", {}, [
      h("h3", { text: COPY.changeHeading }),
      h("div", { class: "box change" }, [h("code", { text: graph.change.commit }), ` ${graph.change.title}`]),
      h("ul", { class: "link-list", style: "margin-top:6px" }, changePaths.map((p) =>
        h("li", {}, h("button", { onclick: () => focusPath(p) }, [graph.nodes[idOf(p)].text]))
      )),
    ]) : null,
    graph.coverage?.uncovered.length ? h("section", {}, [
      h("h3", { text: COPY.uncoveredHeading(graph.coverage.uncovered.length) }),
      h("details", {}, [
        h("summary", { class: "muted", text: COPY.uncoveredSummary }),
        h("ul", { class: "uncovered" }, graph.coverage.uncovered.map((u) => h("li", {}, [h("code", { text: u.where }), h("div", { class: "muted", text: u.reason })]))),
      ]),
    ]) : null,
    notePaths.length ? h("section", {}, [
      h("h3", { text: COPY.notesHeading(notePaths.length) }),
      h("ul", { class: "link-list" }, notePaths.map((p) => {
        const node = graph.nodes[idOf(p)];
        return h("li", {}, h("button", { onclick: () => focusPath(p) }, [
          node.text,
          h("span", { class: "muted", text: node.notes[0] }),
        ]));
      })),
    ]) : null,
    h("section", {}, [
      h("h3", { text: COPY.howToRead }),
      h("p", { class: "muted", text: COPY.legend }),
      h("div", { class: "legend", style: "margin-top:8px" }, OUTCOME_KINDS.map((kind) =>
        h("span", {}, [h("i", { class: "swatch", style: `border-color:var(--${kind === "user-error" ? "user" : kind});background:var(--${kind === "user-error" ? "user" : kind}-fill)` }), KIND_LABEL[kind]])
      )),
    ]),
  ];
}

function nodePanel(path, close) {
  const id = idOf(path);
  const node = graph.nodes[id];
  const composite = isComposite(node);
  const open = state.open.has(path);
  const r = index.rollup(id);
  const sharedBy = index.entryPointsByNode.get(id) || [];
  const kicker = node.branches ? COPY.kicker.fork : node.question || (node.exits && node.exits.length) ? COPY.kicker.decision : composite ? COPY.kicker.group : COPY.kicker.step;
  return [
    h("div", { class: "panel-head" }, [
      h("div", {}, [h("div", { class: "panel-kicker", text: kicker }), h("h2", { text: node.text })]),
      close,
    ]),
    h("div", { style: "margin-top:8px; display:flex; gap:6px; flex-wrap:wrap" }, [
      composite ? h("button", { class: "btn", onclick: () => toggle(path), text: open ? COPY.collapse : COPY.open(childIds(node).length) }) : null,
      h("button", { class: "btn", onclick: () => select(null), text: COPY.back(state.epId) }),
    ]),
    node.question ? h("section", {}, [
      h("h3", { text: COPY.decides }),
      h("div", { text: node.question }),
      node.pass ? h("div", { class: "muted", style: "margin-top:4px", text: COPY.continuesWhen(node.pass) }) : null,
      (node.returns || []).length ? h("div", { class: "muted", style: "margin-top:4px", text: COPY.returns(node.returns.map((r) => `${r.value} (${r.when})`).join(" · ")) }) : null,
      node.branches ? h("div", { class: "muted", style: "margin-top:4px", text: COPY.paths(node.branches.map((b) => b.when).join(" · ")) }) : null,
    ]) : null,
    node.change && graph.change ? h("section", {}, h("div", { class: "box change" }, [
      COPY.changedIn(node.change), h("code", { text: graph.change.commit }), `: ${graph.change.title}`,
    ])) : null,
    node.detail ? h("section", {}, h("p", { text: node.detail })) : null,
    (node.notes || []).length ? h("section", {}, [
      h("h3", { text: COPY.worthALook }),
      ...node.notes.map((note) => h("div", { class: "box note", text: note })),
    ]) : null,
    (node.exits || []).length ? h("section", {}, [
      h("h3", { text: COPY.endsHere }),
      h("div", { class: "exit-list" }, node.exits.map((e) =>
        h("div", { class: "exit-row" }, [h("span", { text: e.when }), h("span", { class: "muted", text: "→" }), pill(e.outcome, [e.when])])
      )),
    ]) : null,
    (node.catches || []).length ? h("section", {}, [
      h("h3", { text: COPY.catches }),
      h("div", { class: "mono muted", text: node.catches.map((c) => (c === "*" ? COPY.anyError : c)).join(", ") }),
    ]) : null,
    composite ? h("section", {}, [
      h("h3", { text: COPY.everyWayInside }),
      h("div", { class: "pills" }, sortedExits(r.exits).map(([code, whens]) => pill(code, whens))),
    ]) : null,
    sharedBy.length > 1 ? h("section", {}, [
      h("h3", { text: COPY.sharedBy(sharedBy.length) }),
      h("div", { class: "muted", text: sharedBy.map((ep) => ep.name).join(", ") }),
    ]) : null,
    (node.source || []).length ? h("section", {}, [
      h("h3", { text: COPY.source }),
      h("div", { class: "source" }, node.source.map((s) => h("div", { text: s }))),
    ]) : null,
  ];
}

// With no ?graph=, the graphs the viewer server has, newest first.
async function showGraphList() {
  let names = [];
  try {
    names = await (await fetch("../graphs/")).json();
  } catch {
    showFatal(COPY.fatal.notLoaded, [COPY.fatal.notLoadedDetail]);
    return;
  }
  if (!names.length) {
    showFatal(COPY.noGraphs, [COPY.noGraphsDetail]);
    return;
  }
  document.getElementById("fatal").replaceChildren(
    h("div", { class: "fatal" }, [
      h("h2", { text: COPY.chooseGraph }),
      h("ul", {}, names.map((n) => h("li", {}, h("a", { href: `?graph=${encodeURIComponent(n)}`, text: n })))),
    ])
  );
}

function showFatal(title, errors) {
  document.getElementById("fatal").replaceChildren(
    h("div", { class: "fatal", role: "alert" }, [
      h("h2", { text: title }),
      h("ul", {}, errors.map((e) => h("li", { text: e }))),
    ])
  );
}

// ---------------------------------------------------------------------------
// Input: click shapes, drag to pan, wheel or pinch to zoom.

function bindInput() {
  const pointers = new Map();
  let drag = null;
  let pinch = null;

  svg.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    svg.setPointerCapture(e.pointerId);
    if (pointers.size === 1) {
      drag = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty, moved: false, target: e.target };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), k: state.k };
      drag = null;
    }
  });

  svg.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt((pinch.k * dist) / pinch.dist / state.k, (a.x + b.x) / 2, (a.y + b.y) / 2);
    } else if (drag) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 4) {
        drag.moved = true;
        svg.classList.add("panning");
      }
      if (drag.moved) {
        state.tx = drag.tx + dx;
        state.ty = drag.ty + dy;
        applyTransform();
      }
    }
  });

  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && !drag.moved && e.type === "pointerup") {
      const path = drag.target.getAttribute && drag.target.getAttribute("data-path");
      if (path) {
        if (isComposite(graph.nodes[idOf(path)])) toggle(path);
        else select(path);
        if (!state.panelOpen) setPanelOpen(true);
      }
    }
    drag = null;
    svg.classList.remove("panning");
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);

  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    else {
      state.tx -= e.deltaX;
      state.ty -= e.deltaY;
      applyTransform();
    }
  }, { passive: false });

  const centerZoom = (factor) => {
    const a = usableArea();
    zoomAt(factor, a.x + a.w / 2, a.y + a.h / 2);
  };
  document.getElementById("zoom-in").addEventListener("click", () => centerZoom(1.2));
  document.getElementById("zoom-out").addEventListener("click", () => centerZoom(1 / 1.2));
  document.getElementById("zoom-reset").addEventListener("click", () => centerZoom(1 / state.k));
  document.getElementById("zoom-fit").addEventListener("click", () => fit(1.5));
  document.getElementById("panel-open").addEventListener("click", () => setPanelOpen(true));

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.selected) select(null);
  });
  window.addEventListener("hashchange", () => {
    const target = hashParam("ep");
    const focus = hashParam("focus");
    if (index.epById[target] && target !== state.epId) selectEntryPoint(target);
    focusNode(focus);
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => draw());
}

// ---------------------------------------------------------------------------
// Boot

async function boot() {
  if (typeof rough === "undefined") {
    showFatal(COPY.fatal.noLibrary, [COPY.fatal.noLibraryDetail]);
    return;
  }
  const name = new URLSearchParams(location.search).get("graph");
  if (!name) {
    await showGraphList();
    return;
  }
  if (!/^[\w.-]+$/.test(name)) {
    showFatal(COPY.fatal.badName, [COPY.fatal.badNameDetail(name)]);
    return;
  }
  let data;
  try {
    const response = await fetch(`../graphs/${name}.json`);
    if (!response.ok) throw new Error(`graphs/${name}.json: HTTP ${response.status}`);
    data = await response.json();
  } catch (error) {
    showFatal(COPY.fatal.notLoaded, [error.message, COPY.fatal.notLoadedDetail]);
    return;
  }

  const errors = validate(data);
  if (errors.length) {
    showFatal(COPY.fatal.invalid(`graphs/${name}.json`, FORMAT), errors);
    return;
  }
  graph = data;
  index = buildIndex(graph);
  rc = rough.svg(svg);

  // Text is measured before drawing, so the hand-drawn font must be ready first.
  await Promise.all([document.fonts.load(`16px Excalifont`), document.fonts.load(`16px Virgil`)]).catch(() => {});

  renderPicker();
  bindInput();
  setPanelOpen(window.innerWidth >= 760);

  const fromHash = hashParam("ep");
  const focus = hashParam("focus");
  const firstWithChange = graph.entryPoints.find((ep) => index.epRollup(ep).changeIds.size);
  selectEntryPoint(index.epById[fromHash] ? fromHash : (firstWithChange || graph.entryPoints[0]).id);
  focusNode(focus);
  window.addEventListener("resize", () => applyTransform());
}

boot();
