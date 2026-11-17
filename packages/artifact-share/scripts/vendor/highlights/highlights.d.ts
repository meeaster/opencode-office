// What build-site.ts uses of @pierre/highlights (dist/index.d.ts in the npm package declares all of it).

export type Lang = string & { readonly lang: unique symbol };

export interface Theme {
  name: string;
  appearance: "light" | "dark";
  cssVariables?: true | { prefix: string; defaults?: Record<string, string> };
  style: { syntax?: Record<string, string | { color?: string; font_style?: "normal" | "italic"; font_weight?: number }> };
}

export declare function isSupportedLanguage(name: string): name is Lang;

/** UTF-8 bytes of a `<pre class="highlights"><code>…</code></pre>` fragment, the code escaped. */
export declare function codeToHtml(code: string, options: { lang: Lang; theme: Theme }): Uint8Array;
