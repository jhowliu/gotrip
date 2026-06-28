/** Loads the interactive single-page app (served at `/`). Kept as a sibling
 *  .html file so it stays readable; read once at startup. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const INDEX_HTML = readFileSync(join(here, "index.html"), "utf8");
