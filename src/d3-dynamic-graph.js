import { max } from "d3";

const DynamicGraph = (d3SelectedVisContainer, d3, optionalPubVars) => {
  // 1. GLOBAL VARIALBES -------------------------------------------------------------------------
  // Public variables width default settings
  let pubVar = {
    topOffset: 0,
    width: window.innerWidth, // pixles
    height: window.innerHeight, // pixles
    transitionTime: 10, // milliseconds
    centeringForce: 0.1,
    // e.g. Nodes: [{id: "foo"}, {id: "bar"}] Links: [{source: "foo", target: "bar"}]
    nodeRefProp: "id",
    unfocusOpacity: 0.6,
    focusOpacity: 0.95,
    unfocusBrightness: 0.6,
    unfocusStrokeThickness: 0.5,
    focusStrokeThickness: 5,
    // Link and Node functions
    linkColor: (link) => "white",
    nodeColor: (node) => node.color || "gray",
    nodeStartXPos: null, // function, returns pixels
    nodeStartYPos: null, // function, returns pixels
    nodeRadius: (node) => 5, // pixles
    tooltipXOffset: 6,
    tooltipYOffset: 2,

    // Tooltip:
    
    tooltipInnerHTML: (node) => {
      const year = pubVar.year ?? 1500;
      const entry = node.colorSchedule?.find(([, start, end]) => year >= start && year <= end);
      const locId = entry?.[3] || "unknown";
      return `${locId}`;
    }

  };

  // Merge any specififed publiv variables
  if (optionalPubVars) pubVar = { ...pubVar, ...optionalPubVars };

  // Private global variables
  let link, node, simulation; // globals set within json request response
  let label; // text labels for nodes


  // Create vis svg canvas
  let svg = d3SelectedVisContainer
    .append("svg")
    .attr("width", pubVar.width)
    .attr("height", pubVar.height)
    .style("display", "block");

  // FOCUS NODE: TOOLTIP AND NEIGHBOR HIGHLIGHT -------------------------------------------------------------------------
  const tooltip = d3SelectedVisContainer
    .append("div")
    .attr("class", "d3-dynamic-graph-tooltip")
    .style("opacity", 0)
    .style("position", "absolute")
    .style("background-color", "black")
    .style("color", "white")
    .style("padding", "4px 6px")
    .style("border-radius", "4px")
    .style("font-size", "12px")
    .style("font-family", "sans-serif")
    .style("text-align", "center")
    .style("pointer-events", "none");

  const getX = (base) => base + pubVar.tooltipXOffset + "px";
  const getY = (base) => base + pubVar.tooltipYOffset + "px";

  const displayNodeTooltip = (event, d) => {
    tooltip.transition().duration(200).style("opacity", 0.9);
    tooltip
      .html(pubVar.tooltipInnerHTML(d))
      .style("left", getX(event.pageX))
      .style("top", getY(event.pageY));
  };

  const updateTooltipPosition = (event) => {
    const [mouseX, mouseY] = d3.pointer(event, this);
    tooltip.style("left", getX(mouseX)).style("top", getY(mouseY));
  };

  const removeNodeTooltip = () => {
    tooltip.transition().duration(500).style("opacity", 0);
  };

  const setLinkStrokeWidth = (targetLink, thickness) =>
    d3SelectedVisContainer
      .selectAll("line.link")
      .filter(
        (d) =>
          d.source[pubVar.nodeRefProp] === targetLink.source[pubVar.nodeRefProp] &&
          d.target[pubVar.nodeRefProp] === targetLink.target[pubVar.nodeRefProp]
      )
      .attr("stroke-width", thickness);


  // Toggles node and its nearest neighbors display, with respect to isInFocus param
  const changeNodeFocus = (node, links, isInFocus) => {
    const centerNodeId = node[pubVar.nodeRefProp];
    const strokeThickness = isInFocus
      ? pubVar.focusStrokeThickness
      : pubVar.unfocusStrokeThickness;
    // Get all neighbors via links, setting the link thickness simultaniously
    const neighborsSet = new Set([node[pubVar.nodeRefProp]]);
    d3SelectedVisContainer.selectAll("line.link")
      .each(function (link) {
        const isNeighbor =
          link.source[pubVar.nodeRefProp] === centerNodeId ||
          link.target[pubVar.nodeRefProp] === centerNodeId;

        if (isNeighbor) {
          neighborsSet.add(link.source[pubVar.nodeRefProp]);
          neighborsSet.add(link.target[pubVar.nodeRefProp]);

          const selection = d3.select(this);
          const current = parseFloat(selection.attr("stroke-width")) || pubVar.unfocusStrokeThickness;

          const sourceRadius = pubVar.nodeRadius(link.source);
          const targetRadius = pubVar.nodeRadius(link.target);
          const maxAllowed = Math.min(sourceRadius, targetRadius) * 2;

          let updatedWidth;
          let scaleFactor;

          if (isInFocus) {
            const desired = current * 2;
            scaleFactor = desired <= maxAllowed ? 2 : maxAllowed / current;
            updatedWidth = current * scaleFactor;

            // Store scale factor on the element so we can reverse it later
            selection.property("__linkScaleFactor__", scaleFactor);
          } else {
            // Retrieve stored scale factor or default to 2
            scaleFactor = selection.property("__linkScaleFactor__") || 2;
            updatedWidth = current / scaleFactor;
          }

          selection
            .attr("stroke-width", updatedWidth)
            .style("opacity", isInFocus ? pubVar.focusOpacity : pubVar.unfocusOpacity);

        }
      });
    
      d3SelectedVisContainer.selectAll("text.node-label")
        .style("opacity", (labelNode) => {
          if (isInFocus) {
            if (neighborsSet.has(labelNode[pubVar.nodeRefProp]) || labelNode.focused) {
              labelNode.focused = true;
              return pubVar.focusOpacity;
            }
            return pubVar.unfocusOpacity;
          } else {
            if (neighborsSet.has(labelNode[pubVar.nodeRefProp])) {
              labelNode.focused = false;
              return pubVar.unfocusOpacity;
            }
            return labelNode.focused ? pubVar.focusOpacity : pubVar.unfocusOpacity;
          }
        })
        .style("font-size", (labelNode) => {
          if (isInFocus) {
            if (neighborsSet.has(labelNode[pubVar.nodeRefProp]) || labelNode.focused) {
              return "16px"; // focused label size
            }
            return "12px"; // dimmed label size
          } else {
            if (neighborsSet.has(labelNode[pubVar.nodeRefProp]) && !labelNode.clicked) {
              return "12px";
            }
            return labelNode.focused ? "16px" : "12px";
          }
        });



    // Set the opacity of ego-node and neighbor nodes
    d3SelectedVisContainer.selectAll("circle.node").attr("filter", (node) => {
      const keepStatusQuo = (node) => {
        return node.focused ? null : `brightness(${pubVar.unfocusBrightness || 0.5})`;
      };

      if (isInFocus) {
        if (
          neighborsSet.has(node[pubVar.nodeRefProp]) ||
          node.clicked ||
          node.focused
        ) {
          node.focused = true;
          return null;
        }
        return keepStatusQuo(node);
      } else {
        if (neighborsSet.has(node[pubVar.nodeRefProp]) && !node.clicked) {
          node.focused = false;
          return `brightness(${pubVar.unfocusBrightness || 0.5})`;
        }
        return keepStatusQuo(node);
      }
    });

  };

  // Update positions at each frame refresh
  function ticked() {
    link
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);

    node
      .attr("r", pubVar.nodeRadius)
      .attr("fill", pubVar.nodeColor)
      .attr("filter", d => d.focused ? null : `brightness(${pubVar.unfocusBrightness || 0.5})`)
      .attr("cx", (d) => {
        const r = pubVar.nodeRadius(d);
        const x = Math.max(r, Math.min(pubVar.width - r, d.x));
        d.x = x;
        return x;
      })
      .attr("cy", (d) => {
        const r = pubVar.nodeRadius(d);
        const y = Math.max(pubVar.topOffset + r, Math.min(pubVar.height - r, d.y));
        d.y = y;
        return y;
      })

      label
        .attr("x", d => d.x)
        .attr("y", d => d.y - pubVar.nodeRadius(d) - 6); // position slightly above the node

  }



  // 5. UPDATE GRAPH AFTER FILTERING DATA -------------------------------------------------------------------------
  function updateVis(nodes, links) {
    // Initialize layout simulation at startup
    if (!simulation) {
      simulation = d3
        .forceSimulation()
        .force(
          "link",
          d3.forceLink()
            .id((node) => node[pubVar.nodeRefProp])
            .distance((l) => (l.linkType === "correspondence" ? 160 : 35))
            .strength((l) => (l.linkType === "correspondence" ? 0.005 : 0.2))
        )
        .force("charge", d3.forceManyBody().strength(-800))
        .force("x", d3.forceX(pubVar.width / 2).strength(pubVar.centeringForce))
        .force(
          "y",
          d3.forceY(pubVar.height / 2).strength(pubVar.centeringForce)
        )
        .velocityDecay(0.4)
        .force("bounds", () => {
          for (const d of simulation.nodes()) {
            const r = pubVar.nodeRadius(d);
            // bottom
            if (d.y > pubVar.height - r) {
              d.y  = pubVar.height - r;
              d.vy = 0;
            }
            // top
            if (d.y < pubVar.topOffset + r) {
            d.y  = pubVar.topOffset + r;
            d.vy = 0;
          }
            // (and similarly for x)
          }
        })
        .force("collide", 
          d3.forceCollide()
            .radius(d => pubVar.nodeRadius(d) + 15)   // 5px padding
            .strength(0.7)                           // tuning parameter
        );

      simulation.nodes(nodes).on("tick", ticked);
      simulation.force("link").links(links);
    }

    simulation.stop();

      if (!link) {
      link = svg
        .append("g")
          .attr("class", "links")
        .selectAll("line");
    }

    
    // supply d.sourceId + '-' + d.targetId as the key:
    link = link.data(
      links,
      d => `${d.sourceId}-${d.targetId}-${d.linkType}`
    );

    // EXIT old links
    link.exit()
      .transition()
        .duration(pubVar.transitionTime)
        .attr("stroke-opacity", 0)
      .remove();

    // ENTER new links
    const linkEnter = link.enter()
      .append("line")
        .attr("class", d =>
          `link link-${d.sourceId} link-${d.targetId}`
        )
        .attr("stroke", d => d.linkType === "correspondence" ? "#000000" : pubVar.linkColor(d))
        .attr("stroke-width", (d) => d.thickness || pubVar.unfocusStrokeThickness)
        .attr("stroke-opacity", pubVar.unfocusOpacity);


    // FADE in the new ones
    linkEnter.transition()
        .duration(pubVar.transitionTime)
        .attr("stroke-opacity", pubVar.unfocusOpacity);


    // MERGE for the simulation
    link = linkEnter
      .merge(link)
      .attr("stroke", d => d.linkType === "correspondence" ? "#000000" : pubVar.linkColor(d))
      .attr("stroke-width", (d) => d.thickness || pubVar.unfocusStrokeThickness)
      .style("opacity", pubVar.unfocusOpacity); // Reset to dimmed on every update


    if (!node) {
      node = svg.append("g").attr("class", "nodes").selectAll("circle");
      /*
      nodes.forEach((d) => {
        // if not supplied, distribute randomly
        
        const startingXPos = pubVar.nodeStartXPos
          ? pubVar.nodeStartXPos(d)
          : Math.random() * pubVar.width;
        const startingYPos = pubVar.nodeStartYPos
          ? pubVar.nodeStartYPos(d)
          : Math.random() * pubVar.height;


        d.x = d.cx = startingXPos;
        d.y = d.cy = startingYPos;
      });*/
    }

    // Apply the general update pattern to the nodes.
    node = node.data(nodes, (d) => d.id);

    node
      .exit()
      .transition()
      .duration(pubVar.transitionTime)
      .attr("r", 0)
      .remove();

    node = node
      .enter()
      .append("circle")
      .each(d => {
        const gridCols = 3;
        const gridRows = 3;

        const cellWidth = pubVar.width / gridCols;
        const cellHeight = pubVar.height / gridRows;
        const jitter = 60;

        /*
        svg.append("g")
        .attr("class", "debug-grid")
        .selectAll("rect")
        .data(d3.cross(d3.range(gridCols), d3.range(gridRows)))  // all [col, row] pairs
        .enter()
        .append("rect")
        .attr("x", ([col, _]) => col * cellWidth)
        .attr("y", ([_, row]) => row * cellHeight)
        .attr("width", cellWidth)
        .attr("height", cellHeight)
        .attr("fill", "none")
        .attr("stroke", "gray")
        .attr("stroke-width", 1)
        .attr("stroke-dasharray", "4 2");
        */
        if (typeof d.starting_loc_x === "number" && typeof d.starting_loc_y === "number") {
          d.x = d.starting_loc_y * cellWidth + cellWidth / 2 + (Math.random() * 2 - 1) * jitter;
          d.y = d.starting_loc_x * cellHeight + cellHeight / 2 + (Math.random() * 2 - 1) * jitter;
        } else {
          // fallback to random placement
          d.x = Math.random() * pubVar.width;
          d.y = Math.random() * pubVar.height;
        }

        console.log(
          `Node ${d.name}: loc=(${d.starting_loc_x}, ${d.starting_loc_y}) → x=${d.x.toFixed(1)}, y=${d.y.toFixed(1)}`
        );

      })
      .attr("class", "node")
      .attr("fill", pubVar.nodeColor)
      .attr("filter", d => d.focused ? null : `brightness(${pubVar.unfocusBrightness || 0.5})`)
      .on("mouseover", (event, node) => {
        displayNodeTooltip(event, node);
        changeNodeFocus(node, links, true);
      })
      .on("mouseout", (event, node) => {
        if (!node.clicked) {
          removeNodeTooltip(event, node);
          changeNodeFocus(node, links, false);
        }
      })
      /*
      .on("click", (event, node) => {
        node.clicked = !node.clicked;
        if (!node.clicked) {
          removeNodeTooltip(event, node);
          changeNodeFocus(node, links, false);
        }
      })*/
      .call((node) => {
        node
          .transition()
          .duration(pubVar.transitionTime)
          .attr("r", (d) => pubVar.nodeRadius(d));
      })
      .call(
        d3
          .drag()
          .on("start", dragstarted)
          .on("drag", dragged)
          .on("end", dragended)
      )
      .merge(node);

      // TEXT LABELS
      if (!label) {
        label = svg.append("g").attr("class", "labels").selectAll("text");
      }

      // Bind labels to the same data
      label = label.data(nodes, d => d.id);

      // Remove old labels
      label.exit().remove();

      // Enter + update
      label = label
        .enter()
        .append("text")
        .attr("class", "node-label")
        .merge(label)
        .text(d => d.name || d.id)
        .attr("font-size", "12px")
        .attr("fill", "white")
        .attr("text-anchor", "middle")
        .style("opacity", pubVar.unfocusOpacity);


    // Apply the general update pattern to the links.
    // Keep the exiting links connected to the moving remaining nodes.
    // Apply the general update pattern to the links, using a key so D3 can
    // track each link across time‐filter reorders:
    // Apply the general update pattern to the links, using a key so D3 can
        // track each link across time‐filter reorders:
    // Apply the general update pattern to the links, using a key so D3
    // can track each link across arbitrary re-filtering:




    // Update and restart the simulation
    simulation.nodes(nodes);
    simulation.force("link").links(links);
    // Start simulation at alpha = 0.3
    let startAlpha = 0.00001;
    let targetAlpha = 0.4;
    let duration = 2000; // in ms

    // Set initial alpha
    simulation.alpha(startAlpha).restart();
    // pause for a moment to let the initial positions settle
    setTimeout(() => {
      simulation.alpha(startAlpha).restart();
    }, 1000);

    // Use d3.timer to gradually increase alpha
    const startTime = Date.now();
    const interpolator = d3.interpolateNumber(startAlpha, targetAlpha);

    const rampUp = d3.timer(() => {
      let elapsed = Date.now() - startTime;
      let t = Math.min(1, elapsed / duration); // clamp between 0 and 1
      simulation.alpha(interpolator(t)).restart();

      if (t === 1) {
        rampUp.stop(); // stop timer after ramp-up is done
      }
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
    updateTooltipPosition(event);
    event.subject.fx = event.x;
    event.subject.fy = event.y;
  }

  function dragended(event) {
    if (!event.active) simulation.alphaTarget(0);
    event.subject.fx = null;
    event.subject.fy = null;
  }

  // CREATE API ______________________________
  function _DynamicGraph() {}

  // (Re)starts graph layout with given nodes and links
  _DynamicGraph.updateVis = (nodes, links) => {
    nodes && links
      ? updateVis(nodes, links)
      : console.error(
          "Error: paramters should be: DyanmicGraph.udpateVis(nodes, links)"
        );
    return _DynamicGraph;
  };

  // Optional settable values

  // Update any settable variable
  _DynamicGraph.pubVar = (pubVarUpdates) => {
    if (!pubVarUpdates) return pubVar;
    pubVar = { ...pubVar, ...pubVarUpdates };
    return _DynamicGraph;
  };

  // Provide a custom function to set node colors on vis update
  _DynamicGraph.nodeColor = (colorSetter) => {
    if (!colorSetter) return pubVar.nodeColor;
    pubVar.nodeColor = colorSetter;
    return _DynamicGraph;
  };

  // Provide a custom function to set node colors on vis update
  _DynamicGraph.tooltipInnerHTML = (innerHTML) => {
    if (!innerHTML) return pubVar.tooltipInnerHTML;
    pubVar.tooltipInnerHTML = innerHTML;
    return _DynamicGraph;
  };

  // Provide a custom function to set node colors on vis update
  _DynamicGraph.nodeRadius = (radiusSetter) => {
    if (!radiusSetter) return pubVar.nodeRadius;
    pubVar.nodeRadius = radiusSetter;
    return _DynamicGraph;
  };

  return _DynamicGraph; // for future api calls
};

export default DynamicGraph;
