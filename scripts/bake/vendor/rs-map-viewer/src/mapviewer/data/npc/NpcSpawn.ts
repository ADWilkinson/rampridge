// RampRidge patch: upstream also fetches bundled spawn JSON via Vite "?url" imports.
// The bake only needs the type, so the browser-only loaders are removed.
export interface NpcSpawn {
    id: number;
    name?: string;
    x: number;
    y: number;
    level: number;
}
