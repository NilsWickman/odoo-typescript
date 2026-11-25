/**
 * Stream H2's controllers (ARCHITECTURE.md, Layout and ownership): one import for src/index.ts. Each module
 * registers its routes with `route()` at load time.
 */
import "./binary";
import "./assets";
import "./static";
import "./translations";
import "./service_worker";
import "./offline";
import "./html_editor";

export { readFile, readFileInfo } from "../filestore";
export { setTemplateRenderer } from "./offline";
