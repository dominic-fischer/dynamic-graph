const DynamicGraph = (d3SelectedVisContainer, d3, optionalPubVars) => {
  // 1. GLOBAL VARIABLES -------------------------------------------------------------------------
  let pubVar = {
    topOffset: 0,
    width: window.innerWidth,
    height: window.innerHeight,
    // CHANGING YEARS: the new layout is computed first, then every person glides
    // from where they are to their new place along this curve (slow start,
    // speeding up, slowing down, settling), in exactly this time.
    transitionDuration: 4000, // milliseconds
    transitionEase: d3.easeCubicInOut,
    // persons, names and edges that leave fade out during the first part of the
    // transition, those that arrive fade in during the last part
    fadeShare: 0.6, // share of the transition each fade takes (0..1)
    layoutAlpha: 0.4, // how much the layout may rearrange per change (simulation energy)
    // how long the simulation runs (in advance) before it settles, relative to
    // d3's default: higher = more time to sort itself out, tidier result
    // (the animation still takes transitionDuration)
    layoutRunLength: 3.5,

    // LAYOUT -- all distances scale with the space per person on screen
    // (sqrt(graph area / number of persons)), so the layout behaves the same
    // with 10 or 120 persons.
    layout: {
      fillRatio: 0.12, // max. share of the graph area covered by circles; circles shrink (keeping their proportions) when needed
      minRadius: 3, // px, smallest circle after shrinking
      nodePadding: 6, // px kept free around every circle
      repulsion: 2.5, // how strongly persons push each other apart (x space per person)
      repulsionRange: 8, // up to which distance they push (x space per person); limits the push towards the screen edges
      greetingLength: 0.6, // preferred extra length of greeting edges (x space per person, on top of the two radii)
      letterLength: 1.0, // same for letter edges
      greetingPull: 0.3, // how strongly greeting edges pull to that length (0..1)
      letterPull: 0.03, // same for letter edges (weak: almost all letters go to Bullinger)
      centering: 0.005, // pull towards the centre of the graph area
      wallMargin: 0.3, // soft walls: within this distance of the screen edge (x space per person) ...
      wallStrength: 3, // ... persons are pushed back inwards this strongly
      friction: 0.6, // 0..1, higher = calmer
    },
    // rectangles (graph coordinates) persons must stay out of, e.g. the legend
    avoidRects: () => [],
    nodeRefProp: "id",
    unfocusOpacity: 0.8,
    focusOpacity: 0.95,
    unfocusBrightness: 0.6,
    unfocusStrokeThickness: 0.5,

    // Each link carries d.strands = [{ dir: "ab" | "ba", count, color }]:
    // one strand per direction and kind (greeting type I / II, or letters).
    // "ab" runs sourceId -> targetId, "ba" the other way.
    // Link types drawn as a row of arrows ( -->--> ) instead of solid strands
    arrowRowLinkTypes: { correspondence: true },
    arrowColor: "white", // single arrow on solid strands
    // greeting and letter edges between the same two persons sit side by side
    siblingGap: 4, // px between them

    nodeColor: (node) => node.color || "gray",
    nodeRadius: (node) => 5,
    tooltipXOffset: 12,
    tooltipYOffset: 12,

    tooltipInnerHTML: (node) => {
      const year = pubVar.year ?? 1500;
      const entry = node.colorSchedule?.find(([, start, end]) => year >= start && year <= end);
      return `${entry?.[3] || "unknown"}`;
    },
    linkTooltipInnerHTML: (link) => `${link.thickness}`,
  };

  // layout settings are merged, so passing only some of them keeps the rest
  const mergeVars = (base, updates) => ({
    ...base,
    ...updates,
    ...(updates.layout ? { layout: { ...base.layout, ...updates.layout } } : {}),
  });
  if (optionalPubVars) pubVar = mergeVars(pubVar, optionalPubVars);

  // Private state
  let link, node, label, simulation;
  // elements of persons / edges that are leaving and still fading out
  let nodeExit = d3.select(null), labelExit = d3.select(null), linkExit = d3.select(null);
  // transition between two updates
  let tween = null; // d3.timer while a transition runs
  let tweenE = null; // eased progress 0..1 while a transition runs, else null
  let scaleFrom = 1, scaleTo = 1;
  let frameCount = 0;
  let focusId = null; // id of the hovered node
  let hoveredLink = null; // hovered link datum
  // Ids of lit (non-dimmed) nodes. Rebuilt from focusId / hoveredLink on every
  // change, never stored on the node data, so nothing can stay lit by accident.
  let litIds = new Set();
  const idOf = (end) => (typeof end === "object" ? end[pubVar.nodeRefProp] : end);

  // circle and edge sizes on screen = data sizes x scale (scale <= 1, set per update)
  let scale = 1;
  let spacing = 100; // space per person in px, set per update
  const R = (d) => Math.max(pubVar.layout.minRadius, pubVar.nodeRadius(d) * scale);

  const svg = d3SelectedVisContainer
    .append("svg")
    .attr("width", pubVar.width)
    .attr("height", pubVar.height)
    .style("display", "block");

  svg.on("click", () => {
    if (typeof pubVar.onBackgroundClick === "function") pubVar.onBackgroundClick();
  });
  // leaving the graph always clears any highlight
  svg.on("mouseleave", () => clearFocus());

  // Layer order: links below nodes below labels
  const linkLayer = svg.append("g").attr("class", "links");
  const nodeLayer = svg.append("g").attr("class", "nodes");
  const labelLayer = svg.append("g").attr("class", "labels");

  // 2. TOOLTIP -------------------------------------------------------------------------
  const tooltip = d3SelectedVisContainer
    .append("div")
    .attr("class", "d3-dynamic-graph-tooltip")
    .style("opacity", 0)
    .style("position", "absolute")
    .style("background-color", "rgba(0,0,0,0.88)")
    .style("color", "white")
    .style("padding", "6px 8px")
    .style("border-radius", "4px")
    .style("font-size", "12px")
    .style("line-height", "1.45")
    .style("font-family", "sans-serif")
    .style("text-align", "left")
    .style("white-space", "nowrap")
    .style("pointer-events", "none")
    .style("z-index", 10);

  const moveTooltip = (event) => {
    const src = event.sourceEvent || event;
    const [x, y] = d3.pointer(src, d3SelectedVisContainer.node());
    const box = d3SelectedVisContainer.node().getBoundingClientRect();
    const tip = tooltip.node();
    // keep tooltip inside the container
    const left = Math.min(x + pubVar.tooltipXOffset, box.width - tip.offsetWidth - 4);
    const top = y + pubVar.tooltipYOffset + tip.offsetHeight > box.height
      ? y - tip.offsetHeight - pubVar.tooltipYOffset
      : y + pubVar.tooltipYOffset;
    tooltip.style("left", `${Math.max(4, left)}px`).style("top", `${Math.max(4, top)}px`);
  };

  const showTooltip = (event, html) => {
    tooltip.interrupt().style("opacity", 0.95).html(html);
    moveTooltip(event);
  };

  const hideTooltip = () => {
    tooltip.transition().duration(300).style("opacity", 0);
  };

  // 3. LINK STYLING & GEOMETRY ------------------------------------------------------------
  // Each link is a <g>; its parts are kept in this.__refs (created on enter):
  //   lines[0..3], arrows[0..3]  solid strands with one white arrow each (greetings)
  //   rows[0..1]                 arrow rows -->--> , one per direction (letters)
  //   hit                        invisible wide line for hovering / clicking
  // Strands going a -> b sit on the right-hand side of a -> b, strands going
  // b -> a on the other side; their widths add up to the edge's total.
  // If a greeting and a letter edge join the same two persons in the same year,
  // the two edges are drawn next to each other (d.__sibling).
  const MAX_STRANDS = 4;

  const isIncident = (d, id) => idOf(d.source) === id || idOf(d.target) === id;
  const isFocusedLink = (d) => d === hoveredLink || (focusId !== null && isIncident(d, focusId));
  const isArrowRow = (d) => !!pubVar.arrowRowLinkTypes[d.linkType];

  function linkWidth(d) {
    const base = Math.max(1, (d.thickness || pubVar.unfocusStrokeThickness) * scale);
    if (!isFocusedLink(d)) return base;
    // emphasise on focus: double, but no wider than the smaller node's diameter
    const maxAllowed = Math.min(R(d.source), R(d.target)) * 2;
    return base * Math.max(1, Math.min(2, maxAllowed / base));
  }

  // arrow heads stick out beyond the shafts, so arrow rows take a bit more room
  // (capped, so thick letter edges read as thick dashes with modest heads)
  const headExtra = (shaft) => Math.min(8, Math.max(4, shaft * 0.4));
  const visualWidth = (d) => {
    const W = d.__wNow ?? d.__w ?? linkWidth(d);
    return isArrowRow(d) ? W + headExtra(W / Math.max(1, (d.__strands || []).length)) : W;
  };

  // strands in drawing order across the edge: b->a ones first (left of a->b), then a->b
  const orderedStrands = (d) => {
    const s = (d.strands || []).filter((x) => x.count > 0);
    return [...s.filter((x) => x.dir === "ba"), ...s.filter((x) => x.dir === "ab")].slice(0, MAX_STRANDS);
  };

  function styleLinks() {
    if (!link) return;
    link.each(function (d) {
      const r = this.__refs;
      d.__strands = orderedStrands(d);
      d.__w = linkWidth(d);
      const rows = isArrowRow(d);
      this.__baseOpacity = isFocusedLink(d) ? pubVar.focusOpacity : pubVar.unfocusOpacity;
      this.style.opacity = this.__baseOpacity * (this.__fade ?? 1);
      for (let i = 0; i < MAX_STRANDS; i++) {
        const s = !rows && d.__strands[i];
        r.lines[i].style.display = s ? null : "none";
        r.arrows[i].style.display = s ? null : "none";
        if (s) {
          r.lines[i].setAttribute("stroke", s.color);
          r.arrows[i].setAttribute("fill", pubVar.arrowColor);
        }
      }
      for (let i = 0; i < 2; i++) {
        const s = rows && d.__strands[i];
        r.rows[i].style.display = s ? null : "none";
        if (s) r.rows[i].firstChild.setAttribute("fill", s.color);
      }
    });
  }

  function setLine(el, ax, ay, bx, by, w) {
    el.setAttribute("x1", ax);
    el.setAttribute("y1", ay);
    el.setAttribute("x2", bx);
    el.setAttribute("y2", by);
    el.setAttribute("stroke-width", w);
  }

  // Triangle centred at (cx, cy) pointing along (ux, uy); s = base width
  function setArrow(el, cx, cy, ux, uy, nx, ny, s) {
    const l = s * 0.9; // length along the edge
    const tipX = cx + (ux * l) / 2, tipY = cy + (uy * l) / 2;
    const bx = cx - (ux * l) / 2, by = cy - (uy * l) / 2;
    el.setAttribute(
      "d",
      `M${tipX},${tipY}L${bx + (nx * s) / 2},${by + (ny * s) / 2}L${bx - (nx * s) / 2},${by - (ny * s) / 2}Z`
    );
  }

  // Arrow row -->--> along +x from 0 to len, centred on y = 0. The <g> is moved
  // and rotated every tick; the path is rebuilt only when the number of arrows
  // or their size changes.
  function setArrowRow(row, x, y, angleDeg, len, shaft) {
    row.setAttribute("transform", `translate(${x},${y}) rotate(${angleDeg})`);
    const s = Math.max(1.5, shaft); // shaft thickness
    const H = s + headExtra(s); // head height
    const L = Math.min(14, Math.max(5, H * 0.6)); // head length
    const S = Math.max(10, L * 1.5); // shaft length
    const G = Math.max(4, L * 0.5); // gap
    const period = S + L + G;
    const n = Math.max(1, Math.floor(len / period));
    const key = `${n}|${s.toFixed(1)}`;
    if (row.__shapeKey === key) return;
    row.__shapeKey = key;
    let d = "";
    for (let i = 0; i < n; i++) {
      const x0 = i * period + G / 2;
      d += `M${x0},${-s / 2}h${S}v${(s - H) / 2}L${x0 + S + L},0L${x0 + S},${H / 2}v${(s - H) / 2}h${-S}Z`;
    }
    row.firstChild.setAttribute("d", d);
  }

  // lateral shift of an edge so that greeting and letter edges between the same
  // two persons lie next to each other (greetings left of a -> b, letters right)
  function siblingOffset(d) {
    const sib = d.__sibling;
    if (!sib || !sib.source || typeof sib.source !== "object") return 0;
    const me = visualWidth(d), other = visualWidth(sib);
    const total = me + pubVar.siblingGap + other;
    return isArrowRow(d) ? total / 2 - me / 2 : -total / 2 + me / 2;
  }

  // during a transition, widths and side-by-side offsets blend from what was
  // on screen before to their new values
  const blend = (from, to) => (tweenE === null || from == null ? to : from + (to - from) * tweenE);

  function positionLinks(sel = link) {
    if (!sel) return;
    // widths first, so side-by-side edges can use each other's current width
    sel.each(function (d) {
      d.__wNow = blend(this.__wFrom, d.__w ?? linkWidth(d));
    });
    sel.each(function (d) {
      const r = this.__refs;
      const strands = d.__strands || orderedStrands(d);
      const W = d.__wNow;
      const a = d.source, b = d.target;
      if (typeof a !== "object" || typeof b !== "object") return;

      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len; // a -> b
      const nx = -uy, ny = ux; // right-hand side of a -> b (y points down)
      const shift = (d.__offNow = blend(this.__offFrom, siblingOffset(d)));
      const ax = a.x + nx * shift, ay = a.y + ny * shift;
      const bx = b.x + nx * shift, by = b.y + ny * shift;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;

      setLine(r.hit, ax, ay, bx, by, Math.max(visualWidth(d), 10));

      const total = strands.reduce((sum, s) => sum + s.count, 0) || 1;
      let offset = -W / 2; // left edge of the next strand
      const angle = (Math.atan2(uy, ux) * 180) / Math.PI;
      strands.forEach((s, i) => {
        const w = (W * s.count) / total;
        const o = offset + w / 2; // centre of this strand
        offset += w;
        if (isArrowRow(d)) {
          if (i > 1) return;
          // a -> b rows start at a; b -> a rows start at b and point back
          if (s.dir === "ab") setArrowRow(r.rows[i], ax + nx * o, ay + ny * o, angle, len, w);
          else setArrowRow(r.rows[i], bx + nx * o, by + ny * o, angle + 180, len, w);
          return;
        }
        setLine(r.lines[i], ax + nx * o, ay + ny * o, bx + nx * o, by + ny * o, w);
        const [dx, dy] = s.dir === "ab" ? [ux, uy] : [-ux, -uy];
        setArrow(r.arrows[i], mx + nx * o, my + ny * o, dx, dy, nx, ny, Math.max(7, w));
      });
    });
  }

  // 4. FOCUS: hovering a node lights it and every node it is linked to;
  //    hovering an edge lights its two endpoints. Otherwise all nodes are dimmed.
  function computeLitIds() {
    litIds = new Set();
    if (focusId !== null) {
      litIds.add(focusId);
      link.each((d) => {
        if (isIncident(d, focusId)) {
          litIds.add(idOf(d.source));
          litIds.add(idOf(d.target));
        }
      });
    }
    if (hoveredLink) {
      litIds.add(idOf(hoveredLink.source));
      litIds.add(idOf(hoveredLink.target));
    }
  }

  // Dimmed nodes get a darker fill colour (same effect as brightness(0.6)).
  // Not done with a CSS filter: Safari ignores filters on SVG shapes, which
  // left every node looking lit.
  const dimColor = (c) => {
    const rgb = d3.color(c)?.rgb();
    if (!rgb) return c;
    const k = pubVar.unfocusBrightness;
    return d3.rgb(rgb.r * k, rgb.g * k, rgb.b * k).formatHex();
  };
  const nodeFill = (n) => {
    const c = pubVar.nodeColor(n);
    return litIds.has(n.id) ? c : dimColor(c);
  };

  function applyNodeHighlight() {
    node.attr("fill", nodeFill);
    label
      .style("opacity", (n) => (litIds.has(n.id) ? pubVar.focusOpacity : pubVar.unfocusOpacity))
      .style("font-size", (n) => (litIds.has(n.id) ? "16px" : "12px"));
    declutterLabels();
  }

  // Names that would overlap are hidden: highlighted persons first, then larger
  // circles win. Hidden names show up again when their person is highlighted.
  function declutterLabels() {
    if (!label) return;
    const items = [];
    label.each(function (d) {
      if (this.__w === undefined || this.__wText !== this.textContent) {
        this.__w = this.getComputedTextLength() || 0;
        this.__wText = this.textContent;
        this.__wSize = this.style.fontSize;
      }
      const lit = litIds.has(d.id);
      const w = lit ? this.__w * (16 / 12) : this.__w; // measured at 12px
      const h = lit ? 16 : 12;
      const x = d.x, y = d.y - R(d) - 6;
      items.push({ el: this, lit, r: R(d), box: [x - w / 2 - 2, y - h, x + w / 2 + 2, y + 3] });
    });
    items.sort((a, b) => (b.lit - a.lit) || (b.r - a.r));
    const placed = [];
    for (const it of items) {
      const [x1, y1, x2, y2] = it.box;
      const clash = placed.some(([a1, b1, a2, b2]) => x1 < a2 && a1 < x2 && y1 < b2 && b1 < y2);
      const show = it.lit || !clash;
      it.el.style.visibility = show ? "visible" : "hidden";
      if (show) placed.push(it.box);
    }
  }

  function refreshFocus() {
    if (!link || !node) return;
    computeLitIds();
    styleLinks();
    positionLinks();
    applyNodeHighlight();
  }

  function clearFocus() {
    focusId = null;
    hoveredLink = null;
    hideTooltip();
    refreshFocus();
  }

  // 5. DRAWING -------------------------------------------------------------------------
  function drawNodes(sel) {
    sel.each(function (d) {
      const r = R(d);
      d.x = Math.max(r, Math.min(pubVar.width - r, d.x));
      d.y = Math.max(pubVar.topOffset + r, Math.min(pubVar.height - r, d.y));
      this.setAttribute("r", r);
      this.setAttribute("cx", d.x);
      this.setAttribute("cy", d.y);
    });
  }

  function drawLabels(sel) {
    sel.attr("x", (d) => d.x).attr("y", (d) => d.y - R(d) - 6);
  }

  // live simulation (only runs while a person is dragged)
  let tickCount = 0;
  function ticked() {
    drawNodes(node);
    node.attr("fill", nodeFill);
    positionLinks();
    drawLabels(label);
    if (++tickCount % 5 === 0 || simulation.alpha() < simulation.alphaMin() * 2) declutterLabels();
  }

  // 6. TRANSITION BETWEEN TWO UPDATES ---------------------------------------------------
  // Each element keeps its own fade: __fade (now), __fadeFrom -> __fadeTo (this transition)
  function setFade(sel, to) {
    sel.each(function () {
      this.__fadeFrom = this.__fade ?? 0;
      this.__fadeTo = to;
    });
  }

  // leaving elements fade during the first part, arriving ones during the last part
  function fadeAt(el, t) {
    const from = el.__fadeFrom ?? 1, to = el.__fadeTo ?? 1;
    if (from === to) return to;
    const share = Math.max(0.05, Math.min(1, pubVar.fadeShare));
    const p = to > from ? (t - (1 - share)) / share : t / share;
    return from + (to - from) * pubVar.transitionEase(Math.max(0, Math.min(1, p)));
  }

  function applyFades(t) {
    const set = (sel, apply) =>
      sel.each(function () {
        this.__fade = t === null ? this.__fadeTo ?? 1 : fadeAt(this, t);
        apply(this);
      });
    for (const sel of [node, nodeExit]) set(sel, (el) => el.setAttribute("opacity", el.__fade));
    for (const sel of [label, labelExit]) set(sel, (el) => el.setAttribute("fill-opacity", el.__fade));
    for (const sel of [link, linkExit]) set(sel, (el) => (el.style.opacity = (el.__baseOpacity ?? pubVar.unfocusOpacity) * el.__fade));
  }

  function frame(t) {
    const e = pubVar.transitionEase(t);
    tweenE = e;
    scale = scaleFrom + (scaleTo - scaleFrom) * e;
    for (const d of simulation.nodes()) {
      d.x = d.__x0 + (d.__tx - d.__x0) * e;
      d.y = d.__y0 + (d.__ty - d.__y0) * e;
    }
    drawNodes(node);
    drawNodes(nodeExit);
    node.each(function (d) {
      const to = nodeFill(d);
      this.setAttribute("fill", this.__fillFrom ? d3.interpolateRgb(this.__fillFrom, to)(e) : to);
    });
    drawLabels(label);
    positionLinks(link);
    positionLinks(linkExit);
    applyFades(t);
    if (++frameCount % 4 === 0) declutterLabels();
  }

  // stop a running transition where it is (positions, fades and sizes stay as drawn)
  function stopTween() {
    if (tween) tween.stop();
    tween = null;
    tweenE = null;
  }

  // end the transition: leaving elements are removed, everything takes its final state
  function finishTween() {
    stopTween();
    scale = scaleTo;
    applyFades(null);
    for (const sel of [nodeExit, labelExit, linkExit]) sel.filter(function () { return this.__fadeTo === 0; }).remove();
    nodeExit = labelExit = linkExit = d3.select(null);
    node.each(function () { this.__fillFrom = null; });
    link.each(function () { this.__wFrom = null; this.__offFrom = null; });
    drawNodes(node);
    refreshFocus();
  }

  // 7. UPDATE GRAPH AFTER FILTERING DATA ------------------------------------------------------
  function updateVis(nodes, links) {
    if (!simulation) {
      simulation = d3
        .forceSimulation()
        .force("link", d3.forceLink().id((n) => n[pubVar.nodeRefProp]))
        .force("charge", d3.forceManyBody())
        .force("x", d3.forceX())
        .force("y", d3.forceY())
        .force("collide", d3.forceCollide().iterations(2))
        .force("bounds", () => {
          // keep circles inside the graph area and out of reserved rectangles (legend)
          const rects = pubVar.avoidRects() || [];
          const L = pubVar.layout, alpha = simulation.alpha();
          const m = spacing * L.wallMargin, k = L.wallStrength * alpha;
          const top = pubVar.topOffset, W = pubVar.width, H = pubVar.height;
          for (const d of simulation.nodes()) {
            const r = R(d);
            // soft walls: push back inwards before the edge is reached
            if (d.x - r < m) d.vx += (m - (d.x - r)) * k;
            if (W - d.x - r < m) d.vx -= (m - (W - d.x - r)) * k;
            if (d.y - r - top < m) d.vy += (m - (d.y - r - top)) * k;
            if (H - d.y - r < m) d.vy -= (m - (H - d.y - r)) * k;
            if (d.x < r) { d.x = r; d.vx = 0; }
            if (d.x > pubVar.width - r) { d.x = pubVar.width - r; d.vx = 0; }
            if (d.y < pubVar.topOffset + r) { d.y = pubVar.topOffset + r; d.vy = 0; }
            if (d.y > pubVar.height - r) { d.y = pubVar.height - r; d.vy = 0; }
            for (const q of rects) {
              const x1 = q.x - r, y1 = q.y - r, x2 = q.x + q.width + r, y2 = q.y + q.height + r;
              if (d.x > x1 && d.x < x2 && d.y > y1 && d.y < y2) {
                // push out through the nearest side
                const opts = [[d.x - x1, "x", x1], [x2 - d.x, "x", x2], [d.y - y1, "y", y1], [y2 - d.y, "y", y2]];
                const [, axis, v] = opts.sort((a, b) => a[0] - b[0])[0];
                d[axis] = v;
                d[axis === "x" ? "vx" : "vy"] = 0;
              }
            }
          }
        })
        .on("tick", ticked)
        .stop();
    }

    // freeze what is on screen now; the transition starts from exactly there
    // (also when the previous one has not finished yet)
    stopTween();
    simulation.stop();
    nodeLayer.selectAll("circle.node").each(function () { this.__fillFrom = this.getAttribute("fill"); });
    linkLayer.selectAll("g.link").each(function (d) {
      this.__wFrom = d.__wNow ?? d.__w;
      this.__offFrom = d.__offNow ?? null;
    });
    scaleFrom = scale;

    // --- LAYOUT SCALE: circle sizes and distances from the space available ---
    const L = pubVar.layout;
    const area = pubVar.width * Math.max(1, pubVar.height - pubVar.topOffset);
    const circleArea = nodes.reduce((s, d) => s + Math.PI * (pubVar.nodeRadius(d) + L.nodePadding) ** 2, 0) || 1;
    scaleTo = Math.min(1, Math.sqrt((L.fillRatio * area) / circleArea));
    scale = scaleTo; // the new layout is computed with the new sizes
    spacing = Math.sqrt(area / Math.max(1, nodes.length));

    simulation.force("charge").strength(-spacing * L.repulsion).distanceMax(spacing * L.repulsionRange);
    simulation.force("x").x(pubVar.width / 2).strength(L.centering);
    simulation.force("y").y(pubVar.topOffset + (pubVar.height - pubVar.topOffset) / 2).strength(L.centering);
    simulation.force("collide").radius((d) => R(d) + L.nodePadding).strength(1);
    simulation.velocityDecay(L.friction);

    // --- NODES ---
    // persons still fading out from a previous change are matched again, so a
    // person who comes back simply fades in again from where they are
    const gridCols = 3, gridRows = 3, jitter = 60;
    const nodeSel = nodeLayer.selectAll("circle.node").data(nodes, (d) => d.id);
    const nodeEnter = nodeSel
      .enter()
      .append("circle")
      .attr("class", "node")
      .attr("opacity", 0)
      .each(function (d) {
        this.__fade = 0;
        // starting point for the layout computation only (new persons appear in place)
        const cellWidth = pubVar.width / gridCols;
        const cellHeight = pubVar.height / gridRows;
        if (typeof d.starting_loc_x === "number" && typeof d.starting_loc_y === "number") {
          d.x = d.starting_loc_y * cellWidth + cellWidth / 2 + (Math.random() * 2 - 1) * jitter;
          d.y = d.starting_loc_x * cellHeight + cellHeight / 2 + (Math.random() * 2 - 1) * jitter;
        } else {
          d.x = Math.random() * pubVar.width;
          d.y = Math.random() * pubVar.height;
        }
      })
      .on("mouseover", (event, d) => {
        showTooltip(event, pubVar.tooltipInnerHTML(d));
        focusId = d.id;
        refreshFocus();
      })
      .on("mousemove", moveTooltip)
      .on("mouseout", () => {
        hideTooltip();
        focusId = null;
        refreshFocus();
      })
      .on("click", (event, d) => {
        if (typeof pubVar.onNodeClick === "function") pubVar.onNodeClick(d, event);
        event.stopPropagation();
      })
      .call(d3.drag().on("start", dragstarted).on("drag", dragged).on("end", dragended));
    const entering = new Set(nodeEnter.data());
    node = nodeEnter.merge(nodeSel).style("pointer-events", null);
    nodeExit = nodeSel.exit().style("pointer-events", "none");
    setFade(node, 1);
    setFade(nodeExit, 0);

    // --- LABELS ---
    const labelSel = labelLayer.selectAll("text.node-label").data(nodes, (d) => d.id);
    const labelEnter = labelSel
      .enter()
      .append("text")
      .attr("class", "node-label")
      .attr("fill", "white")
      .attr("fill-opacity", 0)
      .attr("text-anchor", "middle")
      .style("pointer-events", "none")
      .style("font-size", "12px")
      .style("opacity", pubVar.unfocusOpacity)
      .each(function () { this.__fade = 0; });
    label = labelEnter.merge(labelSel).text((d) => d.name || d.id);
    labelExit = labelSel.exit();
    setFade(label, 1);
    setFade(labelExit, 0);

    // --- LINKS ---
    simulation.nodes(nodes);
    simulation.force("link")
      .links(links) // resolves source/target to node objects
      .distance((l) => R(l.source) + R(l.target) + spacing * (l.linkType === "correspondence" ? L.letterLength : L.greetingLength))
      .strength((l) => (l.linkType === "correspondence" ? L.letterPull : L.greetingPull));

    const linkSel = linkLayer
      .selectAll("g.link")
      .data(links, (d) => `${d.sourceId}-${d.targetId}-${d.linkType}`);
    const linkEnter = linkSel.enter().append("g").attr("class", "link").style("opacity", 0);
    linkEnter.each(function () {
      this.__fade = 0;
      const sel = d3.select(this);
      const none = (s) => s.style("pointer-events", "none");
      this.__refs = {
        lines: d3.range(MAX_STRANDS).map(() => none(sel.append("line").attr("class", "link-strand")).node()),
        rows: d3.range(2).map(() => {
          const row = none(sel.append("g").attr("class", "link-arrow-row"));
          row.append("path");
          return row.node();
        }),
        arrows: d3.range(MAX_STRANDS).map(() => none(sel.append("path").attr("class", "link-arrow")).node()),
      };
    });
    linkEnter
      .append("line")
      .attr("class", "link-hit")
      .attr("stroke", "transparent")
      .style("cursor", "pointer")
      .each(function () {
        this.parentNode.__refs.hit = this;
      })
      .on("click", (event, d) => {
        if (typeof pubVar.onLinkClick === "function") pubVar.onLinkClick(d, event);
        event.stopPropagation();
      })
      .on("mouseover", (event, d) => {
        hoveredLink = d;
        showTooltip(event, pubVar.linkTooltipInnerHTML(d));
        refreshFocus();
      })
      .on("mousemove", moveTooltip)
      .on("mouseout", () => {
        hoveredLink = null;
        hideTooltip();
        refreshFocus();
      });
    link = linkEnter.merge(linkSel);
    linkExit = linkSel.exit();
    link.each(function () { this.__refs.hit.style.pointerEvents = "stroke"; });
    linkExit.each(function () { this.__refs.hit.style.pointerEvents = "none"; });
    setFade(link, 1);
    setFade(linkExit, 0);

    // hit lines must see the current datum (join only propagates to direct children on enter)
    link.each(function (d) {
      d3.select(this).selectAll("line, path, g").datum(d);
    });

    // greeting and letter edge between the same two persons: draw side by side
    const byPair = new Map();
    for (const l of links) {
      const k = `${l.sourceId}|${l.targetId}`;
      if (!byPair.has(k)) byPair.set(k, []);
      byPair.get(k).push(l);
    }
    for (const group of byPair.values()) {
      for (const l of group) l.__sibling = group.find((o) => o !== l) || null;
    }

    // --- NEW LAYOUT, computed in advance from where everybody is now ---
    for (const d of nodes) {
      d.__x0 = d.x;
      d.__y0 = d.y;
      d.vx = d.vy = 0;
    }
    // d3's default decay runs 300 ticks from alpha 1 down to alphaMin; this stretches that
    simulation.alphaDecay(1 - Math.pow(simulation.alphaMin(), 1 / (300 * Math.max(0.1, pubVar.layoutRunLength))));
    simulation.alpha(pubVar.layoutAlpha);
    const ticks = Math.ceil(Math.log(simulation.alphaMin() / simulation.alpha()) / Math.log(1 - simulation.alphaDecay()));
    simulation.tick(Math.max(1, ticks));
    for (const d of nodes) {
      const r = R(d);
      d.__tx = Math.max(r, Math.min(pubVar.width - r, d.x));
      d.__ty = Math.max(pubVar.topOffset + r, Math.min(pubVar.height - r, d.y));
      // persons who just arrive appear in their place; everybody else glides there
      if (entering.has(d)) {
        d.__x0 = d.__tx;
        d.__y0 = d.__ty;
      }
      d.x = d.__x0;
      d.y = d.__y0;
      d.vx = d.vy = 0;
    }

    // drop focus that pointed at a node no longer shown, then rebuild the lit
    // set for the new year/selection (also dims nodes that just entered)
    if (focusId !== null && !nodes.some((n) => n.id === focusId)) focusId = null;
    hoveredLink = null;
    computeLitIds();
    styleLinks();
    label
      .style("opacity", (n) => (litIds.has(n.id) ? pubVar.focusOpacity : pubVar.unfocusOpacity))
      .style("font-size", (n) => (litIds.has(n.id) ? "16px" : "12px"));

    // --- PLAY THE TRANSITION ---
    frame(0);
    declutterLabels();
    const duration = Math.max(0, pubVar.transitionDuration);
    if (duration === 0) {
      frame(1);
      finishTween();
      return;
    }
    tween = d3.timer((elapsed) => {
      const t = Math.min(1, elapsed / duration);
      frame(t);
      if (t === 1) finishTween();
    });
  }

  // DRAG EVENTS ______________________________
  function dragstarted(event) {
    // grabbing a person mid-transition ends it where it is; the live layout takes over
    if (tween) finishTween();
    if (!event.active) simulation.alphaTarget(0.3).restart();
    event.subject.fx = event.subject.x;
    event.subject.fy = event.subject.y;
  }

  function dragged(event) {
    moveTooltip(event);
    event.subject.fx = event.x;
    event.subject.fy = event.y;
  }

  function dragended(event) {
    if (!event.active) simulation.alphaTarget(0);
    event.subject.fx = null;
    event.subject.fy = null;
  }

  // API ______________________________
  function _DynamicGraph() {}

  _DynamicGraph.updateVis = (nodes, links) => {
    nodes && links
      ? updateVis(nodes, links)
      : console.error("Error: parameters should be: DynamicGraph.updateVis(nodes, links)");
    return _DynamicGraph;
  };

  // Re-style links without restarting the layout (e.g. after toggling direction)
  _DynamicGraph.refreshLinks = () => {
    refreshFocus();
    return _DynamicGraph;
  };

  _DynamicGraph.pubVar = (pubVarUpdates) => {
    if (!pubVarUpdates) return pubVar;
    pubVar = mergeVars(pubVar, pubVarUpdates);
    if (pubVarUpdates.width || pubVarUpdates.height) {
      svg.attr("width", pubVar.width).attr("height", pubVar.height);
    }
    return _DynamicGraph;
  };

  _DynamicGraph.nodeColor = (colorSetter) => {
    if (!colorSetter) return pubVar.nodeColor;
    pubVar.nodeColor = colorSetter;
    return _DynamicGraph;
  };

  _DynamicGraph.tooltipInnerHTML = (innerHTML) => {
    if (!innerHTML) return pubVar.tooltipInnerHTML;
    pubVar.tooltipInnerHTML = innerHTML;
    return _DynamicGraph;
  };

  _DynamicGraph.linkTooltipInnerHTML = (innerHTML) => {
    if (!innerHTML) return pubVar.linkTooltipInnerHTML;
    pubVar.linkTooltipInnerHTML = innerHTML;
    return _DynamicGraph;
  };

  _DynamicGraph.nodeRadius = (radiusSetter) => {
    if (!radiusSetter) return pubVar.nodeRadius;
    pubVar.nodeRadius = radiusSetter;
    return _DynamicGraph;
  };

  return _DynamicGraph;
};

export default DynamicGraph;