/**
 * Streamdown rehype plugin configuration with corrected rehype-harden options.
 *
 * The previous configuration had several issues with rehype-harden:
 *   - allowedProtocols lacked trailing colons (e.g. 'tel' instead of 'tel:')
 *   - allowedLinkPrefixes contained invalid entries like 'http://'
 *   - defaultOrigin was undefined, which is invalid when prefixes are not '*'
 *
 * This module re-exports the default plugin list with same-origin prefixes
 * and only overrides allowedProtocols to add the tel: protocol, while
 * keeping allowDataImages: false.
 */
import { defaultRehypePlugins } from 'streamdown'
import type { PluggableList } from 'unified'

// defaultRehypePlugins is Record<string, Pluggable> with keys: raw, katex, harden
// We filter out 'raw' (rehype-raw) to prevent XSS via raw HTML in AI output,
// and override harden with a secure configuration.
const hardenedRehypePlugins: PluggableList = Object.entries(
  defaultRehypePlugins
)
  .filter(([key]) => key !== 'raw')
  .map(([key, plugin]) => {
  if (key !== 'harden') {
    return plugin
  }

  // plugin is [hardenFn, options] — keep the function, replace options
  if (Array.isArray(plugin)) {
    const [hardenFn] = plugin
    const defaultOrigin =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : 'https://localhost'
    return [
      hardenFn,
      {
        allowedProtocols: ['tel:'],
        allowedLinkPrefixes: [defaultOrigin],
        allowedImagePrefixes: [defaultOrigin],
        allowDataImages: false,
        defaultOrigin,
      },
    ]
  }

  // Unexpected shape — return as-is (defensive)
  return plugin
})

export { hardenedRehypePlugins }
