// Serves the viewer and the graphs on localhost: /viewer/ and /lib/ from the
// framework, /graphs/<name>.json from the cache's graphs folder.
//
//   bin/logicmap view [--port 8765]

import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { GRAPHS, HOME } from "./paths.mjs";
import { coded } from "./errors.mjs";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

function resolveFile(url) {
  const path = decodeURIComponent(url.split("?")[0]);
  if (path === "/" || path === "/viewer") return { redirect: "/viewer/" };
  if (path === "/graphs/") return { list: true };
  const graph = path.match(/^\/graphs\/([\w.-]+\.json)$/);
  if (graph) return { file: join(GRAPHS, graph[1]) };
  if (!/^\/(viewer|lib)\//.test(path)) return null;
  const file = normalize(join(HOME, path.endsWith("/") ? `${path}index.html` : path));
  return file.startsWith(join(HOME, "viewer")) || file.startsWith(join(HOME, "lib")) ? { file } : null;
}

export function serve(port) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      const hit = resolveFile(req.url);
      if (hit?.list) {
        const names = existsSync(GRAPHS) ? readdirSync(GRAPHS).filter((f) => f.endsWith(".json"))
          .sort((a, b) => statSync(join(GRAPHS, b)).mtimeMs - statSync(join(GRAPHS, a)).mtimeMs).map((f) => f.replace(/\.json$/, "")) : [];
        res.writeHead(200, { "content-type": TYPES[".json"], "cache-control": "no-store" }).end(JSON.stringify(names));
      } else if (hit?.redirect) {
        res.writeHead(302, { location: hit.redirect }).end();
      } else if (hit && existsSync(hit.file) && statSync(hit.file).isFile()) {
        res.writeHead(200, { "content-type": TYPES[extname(hit.file)] || "application/octet-stream", "cache-control": "no-store" }).end(readFileSync(hit.file));
      } else {
        res.writeHead(404, { "content-type": "text/plain" }).end(`Not found: ${req.url}`);
      }
    });
    server.on("error", (e) => reject(e.code === "EADDRINUSE"
      ? coded("BAD_ARGUMENT", `port ${port} is in use`, `Pass --port N, or open the viewer that already runs there: http://localhost:${port}/viewer/`, String(port))
      : e));
    server.listen(port, "127.0.0.1", () => resolvePromise(server));
  });
}
