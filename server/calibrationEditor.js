// The calibration and its undo history. Both live on the server so the laptop and the phone step
// through the same edits. History holds geometry only: undo has never changed the theme or the
// test pattern, and a theme picked after a drag should survive undoing that drag.

const HISTORY_LIMIT = 100;

const geometryOf = ({ table, corners, offsets }) => ({ table, corners, offsets });
const isSameGeometry = (a, b) => JSON.stringify(geometryOf(a)) === JSON.stringify(geometryOf(b));

export function createCalibrationEditor(initial) {
  let current = initial;
  let past = [];
  let future = [];

  const isCurrent = (snapshot) => isSameGeometry(snapshot, current);

  function remember() {
    future = [];
    if (past.length > 0 && isCurrent(past.at(-1))) return;
    past = [...past, geometryOf(current)].slice(-HISTORY_LIMIT);
  }

  function restoreFrom(from, to) {
    const snapshot = from.pop();
    to.push(geometryOf(current));
    current = { ...current, ...snapshot };
  }

  return {
    get current() {
      return current;
    },
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    begin: remember,
    update(next) {
      current = next;
    },
    undo() {
      // Tapping a point begins an edit that never changes anything. Skip what that left behind,
      // or undo would look broken.
      while (past.length > 0 && isCurrent(past.at(-1))) past.pop();
      if (past.length > 0) restoreFrom(past, future);
    },
    redo() {
      if (future.length > 0) restoreFrom(future, past);
    },
    replace(next) {
      remember();
      current = next;
    },
  };
}
