export const ADAPTER_METHODS = Object.freeze([
  'detect',
  'discoverProfiles',
  'readProfile',
  'planBundleChange',
  'apply',
  'backup',
  'rollback',
  'healthCheck',
  'close',
])

export function assertAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new TypeError('adapter must be an object')
  const missing = ADAPTER_METHODS.filter(method => typeof adapter[method] !== 'function')
  if (missing.length) throw new TypeError(`adapter is missing methods: ${missing.join(', ')}`)
  return adapter
}
