const BACKGROUND_COLOR = "#111b18";
const OUTSIDE_BACKGROUND_COLOR = "#000000";
const DETAILED_ROAD_MIN_ZOOM = 2.4;
const SPATIAL_GRID_CELL_SIZE = 250;
// Integer cell addressing: a `${column}:${row}` key would allocate and hash a
// string for every probe of every render, and a single tile pass probes
// hundreds of cells.
const GRID_KEY_ROW_STRIDE = 1 << 21;

const MODE_STYLES = [
  { color: "#a7704c", alpha: 0.86, dash: [] },
  { color: "#2f8b88", alpha: 0.86, dash: [3, 3] },
  { color: "#587b6c", alpha: 0.9, dash: [] },
  { color: "#40514b", alpha: 0.62, dash: [2, 4] },
];

let segmentGeometry = null;
let segmentWidths = null;
let segmentPriorities = null;
let segmentModes = null;
let segmentLanes = null;
let segmentLodRanks = null;
let segmentCarSupport = null;
let turnGeometry = null;
let turnLaneData = null;
let turnDirections = null;
let segmentSpatialIndex = null;
let turnSpatialIndex = null;
let renderCanvas = null;
let renderContext = null;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function gridCellKey(column, row) {
  return column * GRID_KEY_ROW_STRIDE + row;
}

function roadLodFraction(priority, zoom) {
  if (priority >= 2) {
    return 1;
  }
  if (priority === 1) {
    return clamp((zoom - 1.1) / 0.8, 0, 1);
  }
  return clamp((zoom - 2.4) / 0.8, 0, 1);
}

function roadVisible(index, zoom) {
  const fraction = roadLodFraction(segmentPriorities[index], zoom);
  return fraction >= 1 || (fraction > 0 && segmentLodRanks[index] < fraction);
}

function buildSpatialIndex(geometry, count) {
  const grid = new Map();
  const marks = new Uint32Array(count);
  const unindexed = [];
  for (let index = 0; index < count; index += 1) {
    const offset = index * 4;
    const startX = Number(geometry[offset]);
    const startY = Number(geometry[offset + 1]);
    const endX = Number(geometry[offset + 2]);
    const endY = Number(geometry[offset + 3]);
    if (![startX, startY, endX, endY].every(Number.isFinite)) {
      unindexed.push(index);
      continue;
    }
    const firstColumn = Math.floor(Math.min(startX, endX) / SPATIAL_GRID_CELL_SIZE);
    const lastColumn = Math.floor(Math.max(startX, endX) / SPATIAL_GRID_CELL_SIZE);
    const firstRow = Math.floor(Math.min(startY, endY) / SPATIAL_GRID_CELL_SIZE);
    const lastRow = Math.floor(Math.max(startY, endY) / SPATIAL_GRID_CELL_SIZE);
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      for (let row = firstRow; row <= lastRow; row += 1) {
        const key = gridCellKey(column, row);
        let cell = grid.get(key);
        if (!cell) {
          cell = { column, row, indices: [] };
          grid.set(key, cell);
        }
        cell.indices.push(index);
      }
    }
  }
  return {
    grid,
    cells: [...grid.values()],
    marks,
    generation: 0,
    unindexed,
  };
}

function spatialCandidates(index, view, margin) {
  if (!index || !Number.isFinite(view?.scale) || view.scale <= 0) {
    return [];
  }
  const horizontalReach = view.width / 2 + view.padding + margin;
  const verticalReach = view.height / 2 + view.padding + margin;
  const minimumX = view.centerX - horizontalReach / view.scale;
  const maximumX = view.centerX + horizontalReach / view.scale;
  const minimumY = view.centerY - verticalReach / view.scale;
  const maximumY = view.centerY + verticalReach / view.scale;
  const firstColumn = Math.floor(minimumX / SPATIAL_GRID_CELL_SIZE);
  const lastColumn = Math.floor(maximumX / SPATIAL_GRID_CELL_SIZE);
  const firstRow = Math.floor(minimumY / SPATIAL_GRID_CELL_SIZE);
  const lastRow = Math.floor(maximumY / SPATIAL_GRID_CELL_SIZE);
  const columnCount = Math.max(0, lastColumn - firstColumn + 1);
  const rowCount = Math.max(0, lastRow - firstRow + 1);
  const queryCellCount = columnCount * rowCount;

  index.generation = (index.generation + 1) >>> 0;
  if (index.generation === 0) {
    index.marks.fill(0);
    index.generation = 1;
  }
  const generation = index.generation;
  const candidates = [];
  const appendCell = (cell) => {
    for (const candidate of cell?.indices || []) {
      if (index.marks[candidate] === generation) {
        continue;
      }
      index.marks[candidate] = generation;
      candidates.push(candidate);
    }
  };

  // Large overview views can cover more empty grid cells than populated ones.
  // In that case walking the compact populated-cell list avoids a huge sparse
  // nested loop while retaining the same exact candidate set.
  if (queryCellCount > index.cells.length * 2) {
    for (const cell of index.cells) {
      if (
        cell.column >= firstColumn
        && cell.column <= lastColumn
        && cell.row >= firstRow
        && cell.row <= lastRow
      ) {
        appendCell(cell);
      }
    }
  } else {
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      for (let row = firstRow; row <= lastRow; row += 1) {
        appendCell(index.grid.get(gridCellKey(column, row)));
      }
    }
  }
  for (const candidate of index.unindexed) {
    if (index.marks[candidate] !== generation) {
      index.marks[candidate] = generation;
      candidates.push(candidate);
    }
  }
  return candidates;
}

function projectX(worldX, view) {
  return (worldX - view.centerX) * view.scale + view.width / 2;
}

function projectY(worldY, view) {
  return (worldY - view.centerY) * view.scale + view.height / 2;
}

function lineVisible(startX, startY, endX, endY, view, margin) {
  return !(
    Math.max(startX, endX) < -view.padding - margin
    || Math.min(startX, endX) > view.width + view.padding + margin
    || Math.max(startY, endY) < -view.padding - margin
    || Math.min(startY, endY) > view.height + view.padding + margin
  );
}

function drawOverview(context, view) {
  const groups = new Map();
  for (const index of spatialCandidates(segmentSpatialIndex, view, 20)) {
    if (!roadVisible(index, view.zoom)) {
      continue;
    }
    const offset = index * 4;
    const startX = projectX(segmentGeometry[offset], view);
    const startY = projectY(segmentGeometry[offset + 1], view);
    const endX = projectX(segmentGeometry[offset + 2], view);
    const endY = projectY(segmentGeometry[offset + 3], view);
    if (!lineVisible(startX, startY, endX, endY, view, 20)) {
      continue;
    }
    const mode = segmentModes[index];
    const width = segmentWidths[index];
    const key = `${mode}:${width}`;
    if (!groups.has(key)) {
      groups.set(key, { mode, width, path: new Path2D() });
    }
    const path = groups.get(key).path;
    path.moveTo(startX, startY);
    path.lineTo(endX, endY);
  }

  context.lineCap = "butt";
  context.setLineDash([]);
  for (const { mode, width, path } of groups.values()) {
    const style = MODE_STYLES[mode] || MODE_STYLES[3];
    context.strokeStyle = style.color;
    context.globalAlpha = style.alpha;
    context.lineWidth = width;
    context.stroke(path);
  }
  context.globalAlpha = 1;
}

function drawDetailedRoads(context, view) {
  const laneWidth = clamp(1.35 + Math.sqrt(view.zoom) * 0.55, 2, 5.2);
  const roadGroups = new Map();
  const laneDividerGroups = new Map();
  for (const index of spatialCandidates(segmentSpatialIndex, view, 40)) {
    if (!roadVisible(index, view.zoom)) {
      continue;
    }
    const offset = index * 4;
    const startX = projectX(segmentGeometry[offset], view);
    const startY = projectY(segmentGeometry[offset + 1], view);
    const endX = projectX(segmentGeometry[offset + 2], view);
    const endY = projectY(segmentGeometry[offset + 3], view);
    if (!lineVisible(startX, startY, endX, endY, view, 40)) {
      continue;
    }
    const mode = segmentModes[index];
    const modeStyle = MODE_STYLES[mode] || MODE_STYLES[3];
    const supportsCars = segmentCarSupport[index] === 1;
    const totalLanes = Math.max(1, segmentLanes[index]);
    const roadWidth = supportsCars
      ? Math.max(segmentWidths[index] * 1.4, totalLanes * laneWidth)
      : Math.max(1.3, segmentWidths[index] * 1.2);
    const key = `${mode}:${roadWidth}`;
    if (!roadGroups.has(key)) {
      roadGroups.set(key, { mode, roadWidth, path: new Path2D() });
    }
    const roadPath = roadGroups.get(key).path;
    roadPath.moveTo(startX, startY);
    roadPath.lineTo(endX, endY);

    if (supportsCars && view.zoom >= 3.5 && totalLanes > 1) {
      const deltaX = endX - startX;
      const deltaY = endY - startY;
      const length = Math.hypot(deltaX, deltaY);
      if (length > 1) {
        const normalX = -deltaY / length;
        const normalY = deltaX / length;
        const alphaKey = String(modeStyle.alpha);
        if (!laneDividerGroups.has(alphaKey)) {
          laneDividerGroups.set(alphaKey, { alpha: modeStyle.alpha, path: new Path2D() });
        }
        const dividerPath = laneDividerGroups.get(alphaKey).path;
        for (let lane = 1; lane < totalLanes; lane += 1) {
          const laneOffset = (lane - totalLanes / 2) * laneWidth;
          dividerPath.moveTo(startX + normalX * laneOffset, startY + normalY * laneOffset);
          dividerPath.lineTo(endX + normalX * laneOffset, endY + normalY * laneOffset);
        }
      }
    }
  }

  context.lineCap = "butt";
  for (const { roadWidth, path } of roadGroups.values()) {
    context.setLineDash([]);
    context.strokeStyle = "#07100f";
    context.lineWidth = roadWidth + 2.2;
    context.globalAlpha = 0.95;
    context.stroke(path);
  }
  for (const { mode, roadWidth, path } of roadGroups.values()) {
    const style = MODE_STYLES[mode] || MODE_STYLES[3];
    context.strokeStyle = style.color;
    context.lineWidth = roadWidth;
    context.globalAlpha = style.alpha;
    context.setLineDash(style.dash);
    context.stroke(path);
  }
  context.strokeStyle = "rgba(224, 239, 233, 0.34)";
  context.lineWidth = 0.65;
  context.setLineDash([4, 5]);
  for (const { alpha, path } of laneDividerGroups.values()) {
    context.globalAlpha = alpha;
    context.stroke(path);
  }
  context.setLineDash([]);
  context.globalAlpha = 1;
}

function drawTurnHead(context, tipX, tipY, directionAngle) {
  context.save();
  context.translate(tipX, tipY);
  context.rotate(directionAngle);
  context.beginPath();
  context.moveTo(0, 0);
  context.lineTo(-2.8, -1.8);
  context.lineTo(-2.8, 1.8);
  context.closePath();
  context.fill();
  context.restore();
}

function drawTurnSymbol(context, x, y, angle, directions) {
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.strokeStyle = "rgba(237, 248, 243, 0.86)";
  context.fillStyle = "rgba(237, 248, 243, 0.86)";
  context.lineWidth = 1;
  context.lineCap = "round";
  if (directions & 1) {
    context.beginPath();
    context.moveTo(-4, 0);
    context.lineTo(5, 0);
    context.stroke();
    drawTurnHead(context, 5, 0, 0);
  }
  if (directions & 2) {
    context.beginPath();
    context.moveTo(-4, 0);
    context.lineTo(0, 0);
    context.quadraticCurveTo(3, 0, 3, -3);
    context.lineTo(3, -5);
    context.stroke();
    drawTurnHead(context, 3, -5, -Math.PI / 2);
  }
  if (directions & 4) {
    context.beginPath();
    context.moveTo(-4, 0);
    context.lineTo(0, 0);
    context.quadraticCurveTo(3, 0, 3, 3);
    context.lineTo(3, 5);
    context.stroke();
    drawTurnHead(context, 3, 5, Math.PI / 2);
  }
  context.restore();
}

function drawTurnArrows(context, view) {
  if (view.zoom < 7 || !turnDirections) {
    return;
  }
  const laneWidth = clamp(1.35 + Math.sqrt(view.zoom) * 0.55, 2, 5.2);
  for (const index of spatialCandidates(turnSpatialIndex, view, 30)) {
    const geometryOffset = index * 4;
    const laneOffset = index * 2;
    const startX = projectX(turnGeometry[geometryOffset], view);
    const startY = projectY(turnGeometry[geometryOffset + 1], view);
    const endX = projectX(turnGeometry[geometryOffset + 2], view);
    const endY = projectY(turnGeometry[geometryOffset + 3], view);
    if (!lineVisible(startX, startY, endX, endY, view, 30)) {
      continue;
    }
    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const length = Math.hypot(deltaX, deltaY);
    if (length < 24) {
      continue;
    }
    const laneIndex = turnLaneData[laneOffset];
    const laneCount = Math.max(1, turnLaneData[laneOffset + 1]);
    const normalX = -deltaY / length;
    const normalY = deltaX / length;
    const offset = (laneIndex - (laneCount - 1) / 2) * laneWidth;
    drawTurnSymbol(
      context,
      startX + deltaX * 0.78 + normalX * offset,
      startY + deltaY * 0.78 + normalY * offset,
      Math.atan2(deltaY, deltaX),
      turnDirections[index],
    );
  }
}

function normalizedMapBounds(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const minimumX = Number(value.minimumX ?? value.minX ?? 0);
  const minimumY = Number(value.minimumY ?? value.minY ?? 0);
  const maximumX = Number(value.maximumX ?? value.maxX ?? value.worldWidth);
  const maximumY = Number(value.maximumY ?? value.maxY ?? value.worldHeight);
  if (![minimumX, minimumY, maximumX, maximumY].every(Number.isFinite)) {
    return null;
  }
  return {
    minimumX: Math.min(minimumX, maximumX),
    minimumY: Math.min(minimumY, maximumY),
    maximumX: Math.max(minimumX, maximumX),
    maximumY: Math.max(minimumY, maximumY),
  };
}

function drawBackground(context, view, rawMapBounds) {
  const logicalWidth = view.width + view.padding * 2;
  const logicalHeight = view.height + view.padding * 2;
  const mapBounds = normalizedMapBounds(rawMapBounds);
  if (!mapBounds) {
    context.fillStyle = BACKGROUND_COLOR;
    context.fillRect(-view.padding, -view.padding, logicalWidth, logicalHeight);
    return;
  }
  context.fillStyle = OUTSIDE_BACKGROUND_COLOR;
  context.fillRect(-view.padding, -view.padding, logicalWidth, logicalHeight);
  const firstX = projectX(mapBounds.minimumX, view);
  const firstY = projectY(mapBounds.minimumY, view);
  const lastX = projectX(mapBounds.maximumX, view);
  const lastY = projectY(mapBounds.maximumY, view);
  context.fillStyle = BACKGROUND_COLOR;
  context.fillRect(
    Math.min(firstX, lastX),
    Math.min(firstY, lastY),
    Math.abs(lastX - firstX),
    Math.abs(lastY - firstY),
  );
}

function drawPois(context, view, pois) {
  if (!pois?.length) {
    return;
  }
  const radius = clamp(2.4 + Math.log2(view.zoom + 1) * 0.45, 3, 5.2);
  const markerGroups = new Map();
  const markerOutline = new Path2D();
  for (const poi of pois) {
    const x = projectX(poi.x, view);
    const y = projectY(poi.y, view);
    if (
      x < -view.padding - 20
      || y < -view.padding - 20
      || x > view.width + view.padding + 20
      || y > view.height + view.padding + 20
    ) {
      continue;
    }
    markerOutline.moveTo(x + radius + 2, y);
    markerOutline.arc(x, y, radius + 2, 0, Math.PI * 2);
    if (!markerGroups.has(poi.color)) {
      markerGroups.set(poi.color, new Path2D());
    }
    const path = markerGroups.get(poi.color);
    path.moveTo(x + radius, y);
    path.arc(x, y, radius, 0, Math.PI * 2);
  }

  context.save();
  context.globalAlpha = 0.96;
  context.fillStyle = "rgba(5, 14, 12, 0.88)";
  context.fill(markerOutline);
  context.strokeStyle = "rgba(237, 248, 243, 0.7)";
  context.lineWidth = 0.7;
  for (const [color, path] of markerGroups) {
    context.fillStyle = color;
    context.fill(path);
    context.stroke(path);
  }
  context.restore();
}

function renderStaticMap(message) {
  const view = message.view;
  const logicalWidth = view.width + view.padding * 2;
  const logicalHeight = view.height + view.padding * 2;
  const backingWidth = Math.max(1, Math.round(logicalWidth * view.pixelRatio));
  const backingHeight = Math.max(1, Math.round(logicalHeight * view.pixelRatio));
  if (!renderCanvas) {
    renderCanvas = new OffscreenCanvas(backingWidth, backingHeight);
    renderContext = renderCanvas.getContext("2d", { alpha: false });
  } else if (renderCanvas.width !== backingWidth || renderCanvas.height !== backingHeight) {
    renderCanvas.width = backingWidth;
    renderCanvas.height = backingHeight;
  }
  renderContext.setTransform(
    view.pixelRatio,
    0,
    0,
    view.pixelRatio,
    view.padding * view.pixelRatio,
    view.padding * view.pixelRatio,
  );
  drawBackground(renderContext, view, message.mapBounds);
  if (view.zoom < DETAILED_ROAD_MIN_ZOOM) {
    drawOverview(renderContext, view);
  } else {
    drawDetailedRoads(renderContext, view);
  }
  drawTurnArrows(renderContext, view);
  drawPois(renderContext, view, message.pois);
  const bitmap = renderCanvas.transferToImageBitmap();
  self.postMessage(
    { type: "rendered", requestId: message.requestId, view, bitmap },
    [bitmap],
  );
}

self.addEventListener("message", (event) => {
  const message = event.data || {};
  try {
    if (message.type === "initialize") {
      segmentGeometry = message.segmentGeometry;
      segmentWidths = message.segmentWidths;
      segmentPriorities = message.segmentPriorities;
      segmentModes = message.segmentModes;
      segmentLanes = message.segmentLanes;
      segmentLodRanks = message.segmentLodRanks;
      segmentCarSupport = message.segmentCarSupport;
      turnGeometry = message.turnGeometry;
      turnLaneData = message.turnLaneData;
      turnDirections = message.turnDirections;
      segmentSpatialIndex = buildSpatialIndex(segmentGeometry, segmentWidths.length);
      turnSpatialIndex = buildSpatialIndex(turnGeometry, turnDirections.length);
      self.postMessage({ type: "ready" });
      return;
    }
    if (message.type === "render") {
      renderStaticMap(message);
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId: message.requestId ?? null,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
