const { getDefaultConfig } = require('expo/metro-config')
const { dirname, resolve, sep } = require('node:path')
const { existsSync } = require('node:fs')

const config = getDefaultConfig(__dirname)
const link = resolve(__dirname, '../superagent/src/phone-link/src')
config.watchFolders = [...(config.watchFolders ?? []), link]
config.resolver.resolveRequest = (context, name, platform) => {
  if (name === '@phone-link') return context.resolveRequest(context, resolve(link, 'mobile-client.ts'), platform)
  if (!context.originModulePath.startsWith(link + sep)) return context.resolveRequest(context, name, platform)
  if (!name.startsWith('.')) {
    return context.resolveRequest({ ...context, originModulePath: resolve(__dirname, 'index.ts') }, name, platform)
  }
  const source = resolve(dirname(context.originModulePath), name.replace(/\.js$/u, '.ts'))
  return context.resolveRequest(context, name.endsWith('.js') && existsSync(source) ? source : name, platform)
}
module.exports = config
