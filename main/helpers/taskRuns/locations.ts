import path from 'node:path';
import { readJson, writeJson, within } from './storageIO';

interface LocationIndex {
  version: 1;
  roots: string[];
  workspaceRoots: string[];
  runs: Record<string, string>;
}

/** This small index stays in userData; media never does when storageRoot is set. */
export function createTaskRunLocations(
  indexPath: string,
  legacyRoot: string,
  currentRoot: () => string,
) {
  const state = readJson<LocationIndex>(indexPath) ?? {
    version: 1,
    roots: [],
    workspaceRoots: [],
    runs: {},
  };
  if (
    state.version !== 1 ||
    !Array.isArray(state.roots) ||
    !Array.isArray(state.workspaceRoots) ||
    !state.runs
  )
    throw new Error('TASK_STORAGE_INDEX_UNSUPPORTED');
  function remember(root: string, key: 'roots' | 'workspaceRoots') {
    root = path.resolve(root);
    if (!state[key].includes(root)) {
      state[key].push(root);
      writeJson(indexPath, state);
    }
    return root;
  }
  remember(legacyRoot, 'roots');
  return {
    indexPath,
    get root() {
      return remember(currentRoot(), 'roots');
    },
    roots() {
      remember(currentRoot(), 'roots');
      return [...state.roots];
    },
    workspaceRoots: () => [...state.workspaceRoots],
    rememberWorkspaceRoot: (root: string) => remember(root, 'workspaceRoots'),
    pinned: (key: string) => state.runs[key],
    entries: () => Object.entries(state.runs),
    pin(key: string, root: string) {
      root = remember(root, 'roots');
      if (state.runs[key] === root) return;
      state.runs[key] = root;
      writeJson(indexPath, state);
    },
    forgetProject(projectHash: string, root?: string) {
      for (const key of Object.keys(state.runs))
        if (
          key.startsWith(projectHash + path.sep) &&
          (!root || state.runs[key] === root)
        )
          delete state.runs[key];
      writeJson(indexPath, state);
    },
    owns(target: string) {
      return state.roots.some((root) => within(root, target));
    },
  };
}
export type TaskRunLocations = ReturnType<typeof createTaskRunLocations>;
