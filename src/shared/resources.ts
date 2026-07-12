import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the resources directory relative to this file
export const RESOURCES_DIR = path.resolve(__dirname, "../resources");

export function getResourcePath(resourceName: string): string {
    return path.join(RESOURCES_DIR, resourceName);
}
