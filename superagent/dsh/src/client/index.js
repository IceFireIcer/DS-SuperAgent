import { applyProduct } from './product.js'

export const inject = ['sessions', 'uiWorkspace', 'uiConversation', 'uiSession', 'slots', 'theme', 'layout']

export function apply(ctx) {
  return applyProduct(ctx)
}
