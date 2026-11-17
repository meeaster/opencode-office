// What build-site.ts uses of Pele (dist/index.d.ts in the npm package declares all of it).

export interface RenderOptions {
  idPrefix?: string;
  maxWidth?: number;
  directionBreakpoint?: number;
  fontFamily?: string;
  linkSchemes?: string[];
  images?: boolean;
}

export interface RenderResult {
  svg: string;
  width: number;
  height: number;
  type: string;
}

export declare function render(source: string, options?: RenderOptions): RenderResult;

export declare class PeleError extends Error {
  line: number;
  column: number;
  snippet: string;
}
