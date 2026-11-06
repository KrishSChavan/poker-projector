const PRECISION_FACTOR = 0.2;
const DRAG_SLOP_PX = 3;
const OVERHANG_PX = 14;

// A point past the edge of the wall stays pinned just outside the preview, where it can still be
// grabbed. Drags are relative, so pulling it back never makes it jump.
const pinned = (fraction) =>
  `clamp(-${OVERHANG_PX}px, ${fraction * 100}%, calc(100% + ${OVERHANG_PX}px))`;

// Draggable points over the wall preview. `container` covers exactly the preview, so a position
// is a fraction of its rectangle, which is also what that position means on the wall.
// `api` supplies:
//   points()             [{ id, kind, label, position: [x, y] }]
//   moveTo(id, [x, y])   apply a drag
//   beginEdit()          called once, when a drag first really moves
//   endEdit()            called when a drag that moved finishes
//   onSelect(id)         someone here picked a point, or cleared it with null
export function createHandles(container, quad, api) {
  const nodes = new Map();
  let selectedId = null;
  let stopDrag = null;

  function show(id) {
    selectedId = id;
    for (const [nodeId, node] of nodes) {
      node.classList.toggle('selected', nodeId === id);
      // Focus left on another point would pick it again when this window next gets focus.
      if (nodeId !== id && node === document.activeElement) node.blur();
    }
  }

  function select(id) {
    if (id === selectedId) return;
    show(id);
    api.onSelect(id);
  }

  function startDrag(node, id, down) {
    let position = [...api.points().find((point) => point.id === id).position];
    let { clientX: lastX, clientY: lastY } = down;
    let hasMoved = false;

    const onMove = (move) => {
      if (move.pointerId !== down.pointerId) return;
      // The release can happen where this page never hears about it, such as over a system menu.
      if (move.buttons === 0) {
        finish();
        return;
      }
      const dx = move.clientX - lastX;
      const dy = move.clientY - lastY;
      // A small slop keeps a click that only selects a point from also moving it.
      if (!hasMoved && Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
      if (!hasMoved) api.beginEdit();
      hasMoved = true;

      const { width, height } = container.getBoundingClientRect();
      const factor = move.shiftKey ? PRECISION_FACTOR : 1;
      position = [position[0] + (dx * factor) / width, position[1] + (dy * factor) / height];
      lastX = move.clientX;
      lastY = move.clientY;
      api.moveTo(id, position);
    };

    const finish = () => {
      stopDrag = null;
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('lostpointercapture', finish);
      if (node.hasPointerCapture(down.pointerId)) node.releasePointerCapture(down.pointerId);
      if (hasMoved) api.endEdit();
    };

    stopDrag = finish;
    node.addEventListener('pointermove', onMove);
    node.addEventListener('lostpointercapture', finish);
  }

  function onPointerDown(event, node, id) {
    // Ctrl-click opens the context menu on a Mac, and the release then never reaches the page.
    if (event.button !== 0 || event.ctrlKey || stopDrag) return;
    event.preventDefault();
    node.setPointerCapture(event.pointerId);
    node.focus({ preventScroll: true });
    select(id);
    startDrag(node, id, event);
  }

  function nodeFor({ id, kind, label }) {
    if (!nodes.has(id)) {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = `handle ${kind}`;
      node.setAttribute('aria-label', label);
      node.title = label;
      node.addEventListener('pointerdown', (event) => onPointerDown(event, node, id));
      node.addEventListener('focus', () => select(id));
      container.append(node);
      nodes.set(id, node);
    }
    return nodes.get(id);
  }

  return {
    sync() {
      const points = api.points();
      for (const point of points) {
        const { style } = nodeFor(point);
        style.left = pinned(point.position[0]);
        style.top = pinned(point.position[1]);
      }
      quad.setAttribute(
        'points',
        points
          .filter((point) => point.kind === 'keystone')
          .map(({ position }) => position.join(','))
          .join(' '),
      );
    },
    selected: () => selectedId,
    // Selection that came from the server, which is not news to pass back to it.
    show,
    selectNext() {
      const ids = [...nodes.keys()];
      nodes.get(ids[(ids.indexOf(selectedId) + 1) % ids.length]).focus({ preventScroll: true });
    },
    clearSelection() {
      select(null);
    },
    isDragging: () => stopDrag !== null,
    stopDrag() {
      stopDrag?.();
    },
    setEnabled(enabled) {
      if (!enabled) stopDrag?.();
      for (const node of nodes.values()) node.disabled = !enabled;
    },
  };
}
