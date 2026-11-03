// SVG -> PNG with resvg (WASM). The module is imported lazily so pages that never render a card
// don't pay for instantiating the WASM.
import { loadFonts } from './fonts';
import { W } from './svg';

export async function renderPng(svg: string): Promise<Uint8Array> {
  const [{ Resvg }, fonts] = await Promise.all([import('@cf-wasm/resvg/workerd'), loadFonts()]);
  const r = await Resvg.async(svg, {
    font: { fontBuffers: fonts, defaultFontFamily: 'Bricolage Grotesque', sansSerifFamily: 'Bricolage Grotesque', monospaceFamily: 'JetBrains Mono' },
    fitTo: { mode: 'width', value: W },
    shapeRendering: 2,
    textRendering: 1,
  });
  try {
    const img = r.render();
    try {
      return img.asPng();
    } finally {
      img.free();
    }
  } finally {
    r.free();
  }
}
