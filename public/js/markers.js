// Read-only copies of the laptop's calibration points, for checking them against the real wall.
// They're fixed in pixels rather than warped, and never catch a click, because a click on the
// wall window means fullscreen.

export function createMarkers(container) {
  const nodes = new Map();

  function nodeFor({ id, kind }) {
    if (!nodes.has(id)) {
      const node = document.createElement('span');
      node.className = `marker ${kind}`;
      container.append(node);
      nodes.set(id, node);
    }
    return nodes.get(id);
  }

  return {
    // `points` are from calibrationPoints().
    update({ points, visible, selectedId }) {
      container.hidden = !visible;
      for (const point of points) {
        const node = nodeFor(point);
        node.style.left = `${point.position[0] * 100}%`;
        node.style.top = `${point.position[1] * 100}%`;
        node.classList.toggle('selected', point.id === selectedId);
      }
    },
  };
}
