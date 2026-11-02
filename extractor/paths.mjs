// Where the framework keeps what it writes. Outside the framework's own folder,
// so an installed plugin (replaced on every update) keeps its cache and graphs.
//   LOGICMAP_CACHE, else $XDG_CACHE_HOME/logicmap, else ~/.cache/logicmap

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOME = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function cacheDir() {
  if (process.env.LOGICMAP_CACHE) return resolve(process.env.LOGICMAP_CACHE);
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "logicmap");
}

export const CACHE = cacheDir();
export const GRAPHS = join(CACHE, "graphs");
export const REPORT = join(CACHE, "last-run.json");
