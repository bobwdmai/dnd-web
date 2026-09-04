const MAP_BLOCK_RE = /\[MAP\]([\s\S]*?)\[\/MAP\]/i;

export function parseMapBlock(text) {
  const match = text.match(MAP_BLOCK_RE);
  if (!match) {
    return { narrative: text.trim(), ops: [] };
  }

  const narrative = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
  const body = match[1];
  const ops = [];

  const coordPair = '(-?\\d+(?:\\.\\d+)?),(-?\\d+(?:\\.\\d+)?)';
  const drawRe = new RegExp(`^draw\\s+${coordPair}\\s+${coordPair}(?:\\s+(#[0-9a-fA-F]{3,6}))?(?:\\s+(.*))?$`, 'i');
  const labelRe = new RegExp(`^label\\s+${coordPair}\\s+(.+)$`, 'i');

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^clear$/i.test(line)) {
      ops.push({ type: 'clear' });
      continue;
    }

    let m = line.match(drawRe);
    if (m) {
      ops.push({
        type: 'line',
        x1: parseFloat(m[1]), y1: parseFloat(m[2]),
        x2: parseFloat(m[3]), y2: parseFloat(m[4]),
        color: m[5] || '#e8e2d0',
        note: m[6] || ''
      });
      continue;
    }

    m = line.match(labelRe);
    if (m) {
      ops.push({ type: 'label', x: parseFloat(m[1]), y: parseFloat(m[2]), text: m[3].trim() });
      continue;
    }
  }

  return { narrative, ops };
}

/**
 * Apply parsed ops to a map state object { lines: [], labels: [] }, mutating it.
 * Returns only the ops that were actually applied (dedup'd against the existing map)
 * so callers can broadcast exactly what changed.
 */
export function applyOps(mapState, ops) {
  const applied = [];
  for (const op of ops) {
    if (op.type === 'clear') {
      mapState.lines = [];
      mapState.labels = [];
      applied.push(op);
    } else if (op.type === 'line') {
      const entry = { x1: op.x1, y1: op.y1, x2: op.x2, y2: op.y2, color: op.color, note: op.note };
      const isDup = mapState.lines.some(l =>
        l.x1 === entry.x1 && l.y1 === entry.y1 && l.x2 === entry.x2 && l.y2 === entry.y2 && l.color === entry.color);
      if (!isDup) {
        mapState.lines.push(entry);
        applied.push({ type: 'line', ...entry });
      }
    } else if (op.type === 'label') {
      const isDup = mapState.labels.some(l => l.x === op.x && l.y === op.y && l.text === op.text);
      if (!isDup) {
        const entry = { x: op.x, y: op.y, text: op.text };
        mapState.labels.push(entry);
        applied.push({ type: 'label', ...entry });
      }
    }
  }
  return applied;
}
