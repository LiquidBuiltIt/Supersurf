/**
 * Minimal .env file loader. Reads KEY=VALUE pairs from a .env file into process.env.
 * Does not override existing vars. Tracks loaded key names for credential discovery.
 *
 * @module dotenv
 */
/** Get the list of env var names loaded from .env. */
export declare function getDotenvKeys(): string[];
/**
 * Load a .env file into process.env. Does not override existing vars.
 * Supports KEY=VALUE, KEY="VALUE", KEY='VALUE', comments (#), and blank lines.
 */
export declare function loadDotenv(dir: string): void;
//# sourceMappingURL=dotenv.d.ts.map