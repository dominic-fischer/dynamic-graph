const DynamicGraph = (d3SelectedVisContainer, d3, optionalPubVars) => {
  // 1. GLOBAL VARIABLES -------------------------------------------------------------------------
  let pubVar = {
    topOffset: 0,
    width: window.innerWidth,
    height: window.innerHeight,
    transitionTime: 10, // milliseconds
    centeringForce: 0.1,
    nodeRefProp: "id",
    unfocusOpacity: 0.6,
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

  if (optionalPubVars) pubVar = { ...pubVar, ...optionalPubVars };

  // Private state
  let link, node, label, simulation;
  let focusId = null; // id of the hovered node
  let hoveredLink = null; // hovered link datum
  // Ids of lit (non-dimmed) nodes. Rebuilt from focusId / hoveredLink on every
  // change, never stored on the node data, so nothing can stay lit by accident.
  let litIds = new Set();
  const idOf = (end) => (typeof end === "object" ? end[pubVar.nodeRefProp] : end);

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
    const base = d.thickness || pubVar.unfocusStrokeThickness;
    if (!isFocusedLink(d)) return base;
    // emphasise on focus: double, but no wider than the smaller node's diameter
    const maxAllowed = Math.min(pubVar.nodeRadius(d.source), pubVar.nodeRadius(d.target)) * 2;
    return base * Math.max(1, Math.min(2, maxAllowed / base));
  }

  // arrow heads stick out beyond the shafts, so arrow rows take a bit more room
  // (capped, so thick letter edges read as thick dashes with modest heads)
  const headExtra = (shaft) => Math.min(8, Math.max(4, shaft * 0.4));
  const visualWidth = (d) => {
    const W = d.__w ?? linkWidth(d);
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
      this.style.opacity = isFocusedLink(d) ? pubVar.focusOpacity : pubVar.unfocusOpacity;
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

  function positionLinks() {
    if (!link) return;
    link.each(function (d) {
      const r = this.__refs;
      const strands = d.__strands || orderedStrands(d);
      const W = d.__w ?? linkWidth(d);
      const a = d.source, b = d.target;

      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len; // a -> b
      const nx = -uy, ny = ux; // right-hand side of a -> b (y points down)
      const shift = siblingOffset(d);
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

  // 5. TICK -------------------------------------------------------------------------
  function ticked() {
    node
      .attr("r", pubVar.nodeRadius)
      .attr("fill", nodeFill)
      .attr("cx", (d) => {
        const r = pubVar.nodeRadius(d);
        d.x = Math.max(r, Math.min(pubVar.width - r, d.x));
        return d.x;
      })
      .attr("cy", (d) => {
        const r = pubVar.nodeRadius(d);
        d.y = Math.max(pubVar.topOffset + r, Math.min(pubVar.height - r, d.y));
        return d.y;
      });

    positionLinks();

    label.attr("x", (d) => d.x).attr("y", (d) => d.y - pubVar.nodeRadius(d) - 6);
  }

  // 6. UPDATE GRAPH AFTER FILTERING DATA ------------------------------------------------------
  function updateVis(nodes, links) {
    if (!simulation) {
      simulation = d3
        .forceSimulation()
        .force(
          "link",
          d3.forceLink()
            .id((n) => n[pubVar.nodeRefProp])
            .distance((l) => (l.linkType === "correspondence" ? 160 : 35))
            .strength((l) => (l.linkType === "correspondence" ? 0.005 : 0.2))
        )
        .force("charge", d3.forceManyBody().strength(-800))
        .force("x", d3.forceX(pubVar.width / 2).strength(pubVar.centeringForce))
        .force("y", d3.forceY(pubVar.height / 2).strength(pubVar.centeringForce))
        .velocityDecay(0.4)
        .force("bounds", () => {
          for (const d of simulation.nodes()) {
            const r = pubVar.nodeRadius(d);
            if (d.y > pubVar.height - r) { d.y = pubVar.height - r; d.vy = 0; }
            if (d.y < pubVar.topOffset + r) { d.y = pubVar.topOffset + r; d.vy = 0; }
          }
        })
        .force("collide", d3.forceCollide().radius((d) => pubVar.nodeRadius(d) + 15).strength(0.7))
        .on("tick", ticked);
    }

    simulation.stop();

    // --- NODES ---
    const gridCols = 3, gridRows = 3, jitter = 60;
    node = nodeLayer
      .selectAll("circle.node")
      .data(nodes, (d) => d.id)
      .join(
        (enter) =>
          enter
            .append("circle")
            .attr("class", "node")
            .each((d) => {
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
            .attr("r", 0)
            .attr("fill", nodeFill)
            .call((sel) =>
              sel.transition().duration(pubVar.transitionTime).attr("r", (d) => pubVar.nodeRadius(d))
            )
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
            .call(d3.drag().on("start", dragstarted).on("drag", dragged).on("end", dragended)),
        (update) => update,
        (exit) => exit.transition().duration(pubVar.transitionTime).attr("r", 0).remove()
      );

    // --- LABELS ---
    label = labelLayer
      .selectAll("text.node-label")
      .data(nodes, (d) => d.id)
      .join("text")
      .attr("class", "node-label")
      .text((d) => d.name || d.id)
      .attr("fill", "white")
      .attr("text-anchor", "middle")
      .style("pointer-events", "none")
      .style("font-size", "12px")
      .style("opacity", pubVar.unfocusOpacity);

    // --- LINKS ---
    simulation.nodes(nodes);
    simulation.force("link").links(links); // resolves source/target to node objects

    link = linkLayer
      .selectAll("g.link")
      .data(links, (d) => `${d.sourceId}-${d.targetId}-${d.linkType}`)
      .join((enter) => {
        const g = enter.append("g").attr("class", "link");
        g.each(function () {
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
        g.append("line")
          .attr("class", "link-hit")
          .attr("stroke", "transparent")
          .style("pointer-events", "stroke")
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
        return g;
      });

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

    // drop focus that pointed at a node no longer shown, then rebuild the lit
    // set for the new year/selection (also dims nodes that just entered)
    if (focusId !== null && !nodes.some((n) => n.id === focusId)) focusId = null;
    hoveredLink = null;
    refreshFocus();

    // restart exactly as in the original: start almost at rest, restart once
    // more after 1 s, and ramp alpha up to 0.4 over 2 s
    const startAlpha = 0.00001, targetAlpha = 0.4, duration = 2000;
    simulation.alpha(startAlpha).restart();
    setTimeout(() => {
      simulation.alpha(startAlpha).restart();
    }, 1000);
    const startTime = Date.now();
    const interpolator = d3.interpolateNumber(startAlpha, targetAlpha);
    const rampUp = d3.timer(() => {
      const t = Math.min(1, (Date.now() - startTime) / duration);
      simulation.alpha(interpolator(t)).restart();
      if (t === 1) rampUp.stop();
    });
    simulation.velocityDecay(0.7);
  }

  // DRAG EVENTS ______________________________
  function dragstarted(event) {
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
    pubVar = { ...pubVar, ...pubVarUpdates };
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
