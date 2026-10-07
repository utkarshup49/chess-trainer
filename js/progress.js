// Progress is saved in this browser only (localStorage).
const KEY = 'chess-gym-progress-v1';

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch (e) {
    return {};
  }
}

function save(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch (e) {
    // Storage blocked (private mode). Progress just won't be remembered.
  }
}

function moduleData(data, moduleId) {
  if (!data[moduleId]) data[moduleId] = { lines: {}, drill: { played: 0, clean: 0, best: 0, streak: 0 } };
  return data[moduleId];
}

export function getModuleProgress(moduleId) {
  return moduleData(load(), moduleId);
}

// clean = finished with no wrong moves and no "show move".
export function recordLine(moduleId, lineId, clean) {
  const data = load();
  const m = moduleData(data, moduleId);
  const line = m.lines[lineId] || { done: 0, clean: 0 };
  line.done += 1;
  if (clean) line.clean += 1;
  m.lines[lineId] = line;
  save(data);
}

export function recordDrill(moduleId, lineId, clean) {
  const data = load();
  const m = moduleData(data, moduleId);
  m.drill.played += 1;
  if (clean) {
    m.drill.clean += 1;
    m.drill.streak += 1;
    m.drill.best = Math.max(m.drill.best, m.drill.streak);
  } else {
    m.drill.streak = 0;
  }
  const line = m.lines[lineId] || { done: 0, clean: 0 };
  line.drilled = (line.drilled || 0) + 1;
  m.lines[lineId] = line;
  save(data);
  return m.drill;
}

export function resetModule(moduleId) {
  const data = load();
  delete data[moduleId];
  save(data);
}
