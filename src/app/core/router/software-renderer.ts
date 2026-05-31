/**
 * Software-renderer detection for the route/shared-element view transitions.
 *
 * The View Transitions API animates full-screen bitmap snapshots via the
 * compositor (`transform`/`opacity`). On a GPU that's free; on a software
 * rasterizer (SwiftShader, llvmpipe, "Microsoft Basic Render Driver", …) the
 * CPU re-blends those full-screen layers every frame and the morph janks.
 *
 * There's no media query for "is the GPU active", so we probe the WebGL
 * renderer string once at startup. When it looks like a software rasterizer we
 * stamp `<html class="no-gpu">`, which `styles.scss` reads to null out the
 * view-transition animations — mirroring the `prefers-reduced-motion` block, so
 * the transition still runs (no `AbortError`) but resolves in a single frame.
 */

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|basic render|software|microsoft basic/i;

function isSoftwareRenderer(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return true; // no WebGL at all → assume no hardware compositing
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (!ext) return false; // can't tell — don't penalise the common case
    const renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '');
    return SOFTWARE_RENDERER.test(renderer);
  } catch {
    return false;
  }
}

/**
 * Detect software rendering once and stamp `<html class="no-gpu">` so the
 * stylesheet can disable the (otherwise janky) view-transition animations.
 * Safe to call before bootstrap; no-ops outside a browser DOM.
 */
export function markRendererCapability(): void {
  if (typeof document === 'undefined') return;
  if (isSoftwareRenderer()) {
    document.documentElement.classList.add('no-gpu');
  }
}
