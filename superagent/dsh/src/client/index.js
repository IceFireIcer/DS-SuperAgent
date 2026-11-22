import { applyProduct } from './product.js'

export const inject = ['sessions', 'workspaces', 'uiWorkspace', 'uiConversation', 'uiSession', 'slots', 'theme', 'layout']

export function apply(ctx) {
  return applyProduct(ctx)
}
